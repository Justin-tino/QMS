const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
// firebase-admin v14: auth lives in subpath export (admin.auth is undefined on umbrella import)
const { getAuth } = require('firebase-admin/auth');

// when Firestore is unreachable the in-memory mock keeps the app alive, but
// permission errors in production refuse the fallback so protected data stays protected.
const ALLOW_MOCK_FALLBACK = process.env.NODE_ENV !== 'production';
function failClosedOrMock(err) {
    const isSecurityError = err && (err.code === 7 || (typeof err.message === 'string' && (err.message.includes('PERMISSION_DENIED') || err.message.includes('API has not been used'))));
    if (!ALLOW_MOCK_FALLBACK && isSecurityError) {
        console.error('PRODUCTION: Firestore security error - failing closed (mock fallback denied).');
        return false;
    }
    if (!ALLOW_MOCK_FALLBACK) {
        console.warn('PRODUCTION: Firestore unavailable (' + (err && err.code ? err.code : 'network') + ') - falling back to in-memory mock per CAPSTONE 2.3.');
    }
    useFirebase = false;
    activeDb = mockDb;
    return true;
}

let activeDb;
let useFirebase = false;
const mockFeedbacks = [];

// Define mock DB
const mockDb = {
    collection: (name) => ({
        add: async (data) => {
            const id = 'mock_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            const entry = { id, ...data, createdAt: new Date() };
            if (mockFeedbacks.length >= 10000) mockFeedbacks.shift(); // Prevent unbounded growth
            mockFeedbacks.push(entry);
            return { id };
        },
        doc: (id) => ({
            get: async () => {
                const found = mockFeedbacks.find(f => f.id === id);
                return { exists: !!found, data: () => found, id };
            },
            update: async (data) => {
                const idx = mockFeedbacks.findIndex(f => f.id === id);
                if (idx !== -1) mockFeedbacks[idx] = { ...mockFeedbacks[idx], ...data };
            },
            set: async (data, options) => {
                const idx = mockFeedbacks.findIndex(f => f.id === id);
                if (idx !== -1) {
                    mockFeedbacks[idx] = options?.merge
                        ? { ...mockFeedbacks[idx], ...data }
                        : { id, ...data };
                } else {
                    mockFeedbacks.push({ id, ...data });
                }
            },
            delete: async () => {
                const idx = mockFeedbacks.findIndex(f => f.id === id);
                if (idx !== -1) {
                    mockFeedbacks.splice(idx, 1);
                }
            }
        }),
        get: async () => ({
            docs: mockFeedbacks.map(f => ({
                id: f.id,
                data: () => f
            })),
            size: mockFeedbacks.length,
            empty: mockFeedbacks.length === 0
        }),
        orderBy: function () { return this; },
        limit: function () { return this; },
        where: function () { return this; }
    })
};

let serviceAccount;
const envServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
if (envServiceAccount) {
    try {
        serviceAccount = JSON.parse(envServiceAccount);
    } catch (e) {
        console.log(' Failed to parse FIREBASE_SERVICE_ACCOUNT env var:', e.message);
    }
}
let serviceAccountSource = 'env';
if (!serviceAccount) {
    try {
        serviceAccount = require('./serviceAccountKey.json');
        serviceAccountSource = 'file';
        if (process.env.NODE_ENV === 'production') {
            console.warn(' Using serviceAccountKey.json in production is discouraged. Set FIREBASE_SERVICE_ACCOUNT env var instead.');
        }
    } catch (e) {
        console.log(' No service account file found (serviceAccountKey.json).');
    }
}

if (serviceAccount) {
    try {
        const app = admin.initializeApp({
            credential: admin.cert(serviceAccount)
        });
        const realDb = getFirestore(app);
        activeDb = realDb;
        useFirebase = true;
        console.log(' Firebase initialized successfully.');
    } catch (error) {
        console.log(' Firebase init failed. Using in-memory mock database.');
        console.log(' Error:', error.message);
        activeDb = mockDb;
        useFirebase = false;
    }
}

// Wrapper to handle runtime Firestore errors (like disabled API or permission denied)
const db = {
    batch: () => {
        if (useFirebase) {
            try {
                const realBatch = activeDb.batch();
                return {
                    delete: (docRef) => {
                        const refToUse = docRef && docRef._realRef ? docRef._realRef : docRef;
                        realBatch.delete(refToUse);
                    },
                    set: (docRef, data, options) => {
                        const refToUse = docRef && docRef._realRef ? docRef._realRef : docRef;
                        realBatch.set(refToUse, data, options);
                    },
                    update: (docRef, data) => {
                        const refToUse = docRef && docRef._realRef ? docRef._realRef : docRef;
                        realBatch.update(refToUse, data);
                    },
                    commit: async () => {
                        try {
                            return await realBatch.commit();
                        } catch (error) {
                            if (useFirebase && (error.code === 7 || error.message.includes('PERMISSION_DENIED') || error.message.includes('API has not been used'))) {
                                console.error('\n Firestore API disabled or permission denied during batch commit. Switching to mock database...');
                                if (!failClosedOrMock(error)) throw error;
                                useFirebase = false;
                                activeDb = mockDb;
                            }
                            throw error;
                        }
                    }
                };
            } catch (error) {
                if (!failClosedOrMock(error)) throw error;
                useFirebase = false;
                activeDb = mockDb;
            }
        }

        // Mock batch implementation
        const operations = [];
        return {
            delete: (docRef) => {
                operations.push({ type: 'delete', ref: docRef });
            },
            set: (docRef, data, options) => {
                operations.push({ type: 'set', ref: docRef, data, options });
            },
            update: (docRef, data) => {
                operations.push({ type: 'update', ref: docRef, data });
            },
            commit: async () => {
                for (const op of operations) {
                    if (op.type === 'delete') {
                        if (op.ref && typeof op.ref.delete === 'function') {
                            await op.ref.delete();
                        }
                    } else if (op.type === 'set') {
                        if (op.ref && typeof op.ref.set === 'function') {
                            await op.ref.set(op.data, op.options);
                        }
                    } else if (op.type === 'update') {
                        if (op.ref && typeof op.ref.update === 'function') {
                            await op.ref.update(op.data);
                        }
                    }
                }
            }
        };
    },
    collection: (name) => {
        return {
            add: async (data) => {
                try {
                    return await activeDb.collection(name).add(data);
                } catch (error) {
                    if (useFirebase && (error.code === 7 || error.message.includes('PERMISSION_DENIED') || error.message.includes('API has not been used'))) {
                        console.error('\n Firestore API is disabled or permission was denied in your Firebase project!');
                        console.error(' Please enable the Cloud Firestore API by visiting the URL in the error message.');
                        console.error(' Switching to the in-memory mock database to keep the app running...\n');
                        if (!failClosedOrMock(error)) throw error;
                        useFirebase = false;
                        activeDb = mockDb;
                        return await activeDb.collection(name).add(data);
                    }
                    throw error;
                }
            },
            doc: (id) => {
                return {
                    get _realRef() {
                        return useFirebase ? activeDb.collection(name).doc(id) : null;
                    },
                    get: async () => {
                        try {
                            return await activeDb.collection(name).doc(id).get();
                        } catch (error) {
                            if (useFirebase && (error.code === 7 || error.message.includes('PERMISSION_DENIED') || error.message.includes('API has not been used'))) {
                                console.error('\n Firestore API is disabled or permission was denied in your Firebase project!');
                                console.error(' Switching to mock database...\n');
                                if (!failClosedOrMock(error)) throw error;
                                useFirebase = false;
                                activeDb = mockDb;
                                return await activeDb.collection(name).doc(id).get();
                            }
                            throw error;
                        }
                    },
                    update: async (data) => {
                        try {
                            return await activeDb.collection(name).doc(id).update(data);
                        } catch (error) {
                            if (useFirebase && (error.code === 7 || error.message.includes('PERMISSION_DENIED') || error.message.includes('API has not been used'))) {
                                if (!failClosedOrMock(error)) throw error;
                                useFirebase = false;
                                activeDb = mockDb;
                                return await activeDb.collection(name).doc(id).update(data);
                            }
                            throw error;
                        }
                    },
                    set: async (data, options) => {
                        try {
                            return await activeDb.collection(name).doc(id).set(data, options);
                        } catch (error) {
                            if (useFirebase && (error.code === 7 || error.message.includes('PERMISSION_DENIED') || error.message.includes('API has not been used'))) {
                                if (!failClosedOrMock(error)) throw error;
                                useFirebase = false;
                                activeDb = mockDb;
                                return await activeDb.collection(name).doc(id).set(data, options);
                            }
                            throw error;
                        }
                    },
                    delete: async () => {
                        try {
                            return await activeDb.collection(name).doc(id).delete();
                        } catch (error) {
                            if (useFirebase && (error.code === 7 || error.message.includes('PERMISSION_DENIED') || error.message.includes('API has not been used'))) {
                                if (!failClosedOrMock(error)) throw error;
                                useFirebase = false;
                                activeDb = mockDb;
                                return await activeDb.collection(name).doc(id).delete();
                            }
                            throw error;
                        }
                    }
                };
            },
            get: async () => {
                try {
                    return await activeDb.collection(name).get();
                } catch (error) {
                    if (useFirebase && (error.code === 7 || error.message.includes('PERMISSION_DENIED') || error.message.includes('API has not been used'))) {
                        console.error('\n Firestore API is disabled or permission was denied in your Firebase project!');
                        console.error(' Please enable the Cloud Firestore API by visiting the URL in the error message.');
                        console.error(' Switching to the in-memory mock database to keep the app running...\n');
                        if (!failClosedOrMock(error)) throw error;
                        useFirebase = false;
                        activeDb = mockDb;
                        return await activeDb.collection(name).get();
                    }
                    throw error;
                }
            },
            orderBy: function (...args) {
                if (useFirebase) {
                    try {
                        const chain = activeDb.collection(name).orderBy(...args);
                        const originalGet = chain.get;
                        chain.get = async () => {
                            try {
                                return await originalGet.call(chain);
                            } catch (error) {
                                if (useFirebase && (error.code === 7 || error.message.includes('PERMISSION_DENIED') || error.message.includes('API has not been used'))) {
                                    if (!failClosedOrMock(error)) throw error;
                                    useFirebase = false;
                                    activeDb = mockDb;
                                    return await activeDb.collection(name).get();
                                }
                                throw error;
                            }
                        };
                        return chain;
                    } catch (error) {
                        if (!failClosedOrMock(error)) throw error;
                        useFirebase = false;
                        activeDb = mockDb;
                    }
                }
                return mockDb.collection(name).orderBy(...args);
            },
            limit: function (...args) {
                if (useFirebase) {
                    try {
                        const chain = activeDb.collection(name).limit(...args);
                        const originalGet = chain.get;
                        chain.get = async () => {
                            try {
                                return await originalGet.call(chain);
                            } catch (error) {
                                if (useFirebase && (error.code === 7 || error.message.includes('PERMISSION_DENIED') || error.message.includes('API has not been used'))) {
                                    if (!failClosedOrMock(error)) throw error;
                                    useFirebase = false;
                                    activeDb = mockDb;
                                    return await activeDb.collection(name).get();
                                }
                                throw error;
                            }
                        };
                        return chain;
                    } catch (error) {
                        if (!failClosedOrMock(error)) throw error;
                        useFirebase = false;
                        activeDb = mockDb;
                    }
                }
                return mockDb.collection(name).limit(...args);
            },
            where: function (...args) {
                if (useFirebase) {
                    try {
                        const chain = activeDb.collection(name).where(...args);
                        const originalGet = chain.get;
                        chain.get = async () => {
                            try {
                                return await originalGet.call(chain);
                            } catch (error) {
                                if (useFirebase && (error.code === 7 || error.message.includes('PERMISSION_DENIED') || error.message.includes('API has not been used'))) {
                                    if (!failClosedOrMock(error)) throw error;
                                    useFirebase = false;
                                    activeDb = mockDb;
                                    return await activeDb.collection(name).get();
                                }
                                throw error;
                            }
                        };
                        return chain;
                    } catch (error) {
                        if (!failClosedOrMock(error)) throw error;
                        useFirebase = false;
                        activeDb = mockDb;
                    }
                }
                return mockDb.collection(name).where(...args);
            }
        };
    }
};

function getAdminAuth() {
    try { return getAuth(); } catch (e) { return null; }
}
module.exports = { db, useFirebase: () => useFirebase, admin, getAdminAuth };


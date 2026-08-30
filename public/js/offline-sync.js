/**
 * PSAU Feedback System — Offline Sync & IndexedDB Engine
 * Handles PWA Service Worker registration, IndexedDB storage for offline submissions,
 * and automatic synchronization when an internet connection is restored.
 * Offline-first behavior: submissions made without connectivity are stored on the device and
 * synchronized ... ensures continuous data collection and prevents data loss.”
 */

// 1. Service Worker Registration
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then(reg => console.log(' Service Worker registered successfully. Scope:', reg.scope))
            .catch(err => console.warn(' Service Worker registration failed:', err));
    });
    // Handle Background Sync trigger from SW
    navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'PSAU_TRIGGER_SYNC') {
            console.log(' SW triggered sync via Background Sync');
            syncOfflineSubmissions();
        }
    });
}

// 2. IndexedDB Helper Class
class OfflineStorage {
    constructor() {
        this.dbName = 'PSAU_Feedback_DB';
        this.storeName = 'offline_feedbacks';
        this.db = null;
        this.ready = this.initDB();
    }
    initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName, { keyPath: 'id', autoIncrement: true });
                }
            };
            request.onsuccess = (event) => {
                this.db = event.target.result;
                console.log(' IndexedDB initialized successfully.');
                resolve(this.db);
            };
            request.onerror = (event) => {
                console.error(' IndexedDB error:', event.target.error);
                reject(event.target.error);
            };
        });
    }
    async saveFeedback(feedbackData) {
        await this.ready;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const entry = {
                ...feedbackData,
                savedOfflineAt: new Date().toISOString(),
                syncStatus: 'pending',
                attemptCount: 0
            };
            const request = store.add(entry);
            request.onsuccess = async (e) => {
                console.log(' Feedback stored locally in IndexedDB. ID:', e.target.result);
                // Register Background Sync so the browser flushes the queue automatically
                try {
                    if ('serviceWorker' in navigator && 'SyncManager' in window) {
                        const reg = await navigator.serviceWorker.ready;
                        await reg.sync.register('psau-feedback-sync');
                        console.log(' Background Sync registered');
                    }
                } catch (err) {
                    // sync registration may fail if permission/sw not ready — online event will handle
                }
                resolve(e.target.result);
            };
            request.onerror = (e) => reject(e.target.error);
        });
    }
    async getAllFeedbacks() {
        await this.ready;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = (e) => reject(e.target.error);
        });
    }
    async deleteFeedback(id) {
        await this.ready;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.delete(id);
            request.onsuccess = () => resolve(true);
            request.onerror = (e) => reject(e.target.error);
        });
    }
    async updateAttempt(id, attemptCount) {
        await this.ready;
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([this.storeName], 'readwrite');
            const store = tx.objectStore(this.storeName);
            const getReq = store.get(id);
            getReq.onsuccess = () => {
                const rec = getReq.result;
                if (!rec) return resolve(false);
                rec.attemptCount = attemptCount;
                const putReq = store.put(rec);
                putReq.onsuccess = () => resolve(true);
                putReq.onerror = (e) => reject(e.target.error);
            };
            getReq.onerror = (e) => reject(e.target.error);
        });
    }
    async getCount() {
        await this.ready;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.count();
            request.onsuccess = () => resolve(request.result);
            request.onerror = (e) => reject(e.target.error);
        });
    }
}
const offlineStorage = new OfflineStorage();

// 3. UI Status Notification Helper
function showOfflineBanner(message, type = 'info', isSyncing = false) {
    // Suppress offline banners on administrative dashboard routes
    if (window.location.pathname.startsWith('/admin')) {
        return;
    }
    let banner = document.getElementById('offlineSyncBanner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'offlineSyncBanner';
        banner.style.cssText = `
 position: fixed;
 top: 0;
 left: 0;
 right: 0;
 z-index: 99999;
 padding: 0.75rem 1.25rem;
 text-align: center;
 font-family: 'Inter', sans-serif;
 font-size: 0.9rem;
 font-weight: 600;
 color: #ffffff;
 box-shadow: 0 4px 12px rgba(0,0,0,0.15);
 transition: transform 0.3s ease, opacity 0.3s ease;
 display: flex;
 align-items: center;
 justify-content: center;
 gap: 0.75rem;
 `;
        document.body.prepend(banner);
    }
    const bgColors = {
        offline: 'linear-gradient(135deg, #d32f2f, #c62828)',
        success: 'linear-gradient(135deg, #2e7d32, #1b5e20)',
        info: 'linear-gradient(135deg, #0288d1, #01579b)',
        sync: 'linear-gradient(135deg, #f57c00, #e65100)'
    };
    banner.style.background = bgColors[type] || bgColors.info;
    const icon = isSyncing ? '<span class="psau-timer small" style="vertical-align:middle; display:inline-flex;"><span class="psau-timer-hand"></span><span class="psau-timer-center"></span></span>' : (type === 'offline' ? '<i class="fas fa-wifi-slash"></i>' : (type === 'success' ? '<i class="fas fa-check-circle"></i>' : '<i class="fas fa-info-circle"></i>'));
    banner.innerHTML = `${icon} <span>${message}</span>`;
    banner.style.transform = 'translateY(0)';
    banner.style.opacity = '1';
    if (type === 'success' || type === 'info') {
        setTimeout(() => {
            if (banner) {
                banner.style.transform = 'translateY(-100%)';
                banner.style.opacity = '0';
            }
        }, type === 'success' ? 5000 : 3500);
    }
}

// 4. Auto-Sync Logic: transient failures stay queued so no submission is lost
let isSyncing = false;
async function syncWithRetry(fb, maxRetries = 3) {
    // Exclude stale CSRF and internal meta — server skips CSRF when isOfflineSync=true to avoid 403 data-loss after restarts
    const EXCLUDE_KEYS = new Set(['id', 'syncStatus', 'attemptCount', '_csrf']);
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const formData = new URLSearchParams();
            Object.keys(fb).forEach(key => {
                if (!EXCLUDE_KEYS.has(key)) {
                    formData.append(key, fb[key]);
                }
            });
            formData.append('isOfflineSync', 'true');
            const response = await fetch('/submit-feedback', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-Requested-With': 'XMLHttpRequest',
                    'Accept': 'application/json'
                },
                body: formData
            });
            const body = await response.text();
            let json = null;
            try { json = body ? JSON.parse(body) : null; } catch (_) { }
            if (response.ok) {
                if (json && json.success) {
                    console.log(` Offline item ${fb.id} synchronized (attempt ${attempt}).`);
                    return { ok: true, permanent: true };
                }
                // 200 but no json.success flag still counts as success for dedup cases
                if (json && json.duplicate) {
                    console.log(` Offline item ${fb.id} already synced (duplicate).`);
                    return { ok: true, permanent: true };
                }
                if (json && json.success !== false) return { ok: true, permanent: true };
            }
            // Decide permanent vs transient
            // 400/422 = bad validation => permanent, delete to avoid loop; 409 duplicate => success/delete; 403 no longer happens for offline (skipped), but treat as transient if it does; 429/5xx/network => transient
            if (response.status === 409) return { ok: true, permanent: true };
            if (response.status === 400 || response.status === 422) {
                console.warn(` Permanent failure ${response.status} for item ${fb.id}: ${body.slice(0, 200)} — discarding.`);
                return { ok: false, permanent: true };
            }
            console.warn(` Sync attempt ${attempt}/${maxRetries} for item ${fb.id} status ${response.status} transient — will retry.`);
        } catch (err) {
            console.warn(` Sync attempt ${attempt}/${maxRetries} for item ${fb.id} network error:`, err.message);
        }
        if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt - 1) * 1000));
        }
    }
    // All attempts exhausted — transient, keep for next online event
    return { ok: false, permanent: false };
}
async function syncOfflineSubmissions() {
    if (!navigator.onLine || isSyncing) return;
    isSyncing = true;
    try {
        const pendingFeedbacks = await offlineStorage.getAllFeedbacks();
        if (pendingFeedbacks.length === 0) {
            isSyncing = false;
            return;
        }
        showOfflineBanner(`Nakakonekta na ulit! Isinusumite ang ${pendingFeedbacks.length} offline feedback...`, 'sync', true);
        let syncedCount = 0;
        let permanentFail = 0;
        let keptForRetry = 0;
        for (const fb of pendingFeedbacks) {
            if (!navigator.onLine) break;
            const result = await syncWithRetry(fb);
            if (result.ok) {
                await offlineStorage.deleteFeedback(fb.id);
                syncedCount++;
            } else if (result.permanent) {
                // Permanent validation failure — drop to prevent loop (rare)
                await offlineStorage.deleteFeedback(fb.id);
                permanentFail++;
            } else {

                const nextAttempt = (fb.attemptCount || 0) + 1;
                await offlineStorage.updateAttempt(fb.id, nextAttempt);
                keptForRetry++;
            }
        }
        if (syncedCount > 0 && keptForRetry === 0 && permanentFail === 0) {
            showOfflineBanner(`Tagumpay! Awtomatikong naisumite ang ${syncedCount} offline feedback.`, 'success');
        } else if (syncedCount > 0 && keptForRetry > 0) {
            showOfflineBanner(`Naisumite ang ${syncedCount} feedback. ${keptForRetry} pa ang naka-save at susubukang muli mamaya.`, 'info');
        } else if (keptForRetry > 0 && syncedCount === 0) {
            showOfflineBanner(`${keptForRetry} nakabinbing feedback — naka-save pa at awtomatikong isusumite pag stable na ang koneksyon.`, 'info');
        } else if (permanentFail > 0) {
            showOfflineBanner(`Naiproseso ang offline queue — ${permanentFail} ay na-skip (validation).`, 'info');
        }
    } catch (err) {
        console.error('Sync error:', err);
    } finally {
        isSyncing = false;
    }
}

// 5. Network Status Listeners
window.addEventListener('online', () => {
    if (window.location.pathname.startsWith('/admin')) return;
    showOfflineBanner('May koneksyon na sa internet. Ina-update ang data...', 'info');
    setTimeout(() => syncOfflineSubmissions(), 1200);
});
window.addEventListener('offline', () => {
    if (window.location.pathname.startsWith('/admin')) return;
    showOfflineBanner('Offline Mode: Ang mga isusumiteng feedback ay maii-save sa device (IndexedDB) at awtomatikong isusumite kapag nag-online.', 'offline');
});
// Extra trigger: tab becomes visible again (PWA resume)
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && navigator.onLine && !window.location.pathname.startsWith('/admin')) {
        syncOfflineSubmissions();
    }
});
// Check on load — short delay so server is ready before first sync
document.addEventListener('DOMContentLoaded', async () => {
    if (window.location.pathname.startsWith('/admin')) return;
    if (!navigator.onLine) {
        showOfflineBanner('Offline Mode: Naka-store local via IndexedDB.', 'offline');
    } else {
        try {
            const count = await offlineStorage.getCount();
            if (count > 0) {
                showOfflineBanner(`May ${count} naka-save na offline feedback — isinusumite...`, 'sync', true);
                setTimeout(() => syncOfflineSubmissions(), 1200);
            }
        } catch (err) {
            console.warn(' Could not check offline storage count:', err.message);
        }
    }
});
window.offlineStorage = offlineStorage;

const CACHE_NAME = 'psau-feedback-v6';

// Core local assets that MUST be cached for offline fallback
const CORE_ASSETS = [
    '/',
    '/css/style.css',
    '/js/offline-sync.js',
    '/manifest.json',
    '/images/logo.png',
    '/css/icon-192.png',
    '/css/icon-512.png'
];

// External/CDN assets — cached opportunistically (not required for install)
const EXTERNAL_ASSETS = [
    'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css'
];

// Install Event — Pre-cache CORE assets individually (not all-or-nothing)
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(async (cache) => {
            console.log('[Service Worker] Caching core app shell...');

            // Cache core assets one-by-one so a single failure doesn't block the rest
            for (const url of CORE_ASSETS) {
                try {
                    await cache.add(url);
                    console.log('[Service Worker] Cached:', url);
                } catch (err) {
                    console.warn('[Service Worker] Failed to cache:', url, err.message);
                }
            }

            // Opportunistically cache external CDN assets (no-cors mode for opaque responses)
            for (const url of EXTERNAL_ASSETS) {
                try {
                    const response = await fetch(url, { mode: 'no-cors' });
                    if (response) {
                        await cache.put(url, response);
                        console.log('[Service Worker] Cached (external):', url);
                    }
                } catch (err) {
                    console.warn('[Service Worker] Skipped external asset:', url, err.message);
                }
            }
        }).then(() => self.skipWaiting())
    );
});

// Activate Event — Clean up old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keyList) => {
            return Promise.all(
                keyList.map((key) => {
                    if (key !== CACHE_NAME) {
                        console.log('[Service Worker] Removing old cache:', key);
                        return caches.delete(key);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch Event — Network-First for HTML, Cache-First for static assets
self.addEventListener('fetch', (event) => {
    // Only handle GET requests
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);

    // Skip chrome-extension, non-http(s) requests
    if (!url.protocol.startsWith('http')) return;

    // Never intercept admin pages — they require auth and must always hit server fresh
    if (url.pathname.startsWith('/admin')) return;

    // Network-First for HTML page navigations
    if (event.request.mode === 'navigate' || event.request.headers.get('accept')?.includes('text/html')) {
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    // Only cache successful responses
                    if (response && response.status === 200) {
                        const responseClone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => {
                            cache.put(event.request, responseClone);
                        });
                    }
                    return response;
                })
                .catch(async () => {
                    // Offline: try to serve from cache
                    const cachedResponse = await caches.match(event.request);
                    if (cachedResponse) return cachedResponse;

                    // Ultimate fallback: serve the cached root page
                    const rootResponse = await caches.match('/');
                    if (rootResponse) return rootResponse;

                    // If nothing is cached at all, return a basic offline page
                    return new Response(
                        `<!DOCTYPE html>
 <html lang="en">
 <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
 <title>Offline - PSAU Feedback</title>
 <style>
 body { font-family: 'Inter', sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #1a1a2e; color: #e0e0e0; }
 .offline-card { text-align: center; padding: 2.5rem; background: #16213e; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.3); max-width: 400px; }
 .offline-card h1 { color: #4caf50; font-size: 1.5rem; margin-bottom: 0.75rem; }
 .offline-card p { color: #b0b0b0; font-size: 0.95rem; line-height: 1.6; }
 .retry-btn { display: inline-block; margin-top: 1.25rem; padding: 0.65rem 1.5rem; background: #4caf50; color: #fff; border: none; border-radius: 8px; font-size: 0.9rem; cursor: pointer; text-decoration: none; }
 .retry-btn:hover { background: #388e3c; }
 </style></head>
 <body>
 <div class="offline-card">
 <h1> Offline Mode</h1>
 <p>Hindi ka naka-connect sa internet. I-refresh ang page kapag may koneksyon na ulit.</p>
 <p style="font-size:0.8rem; margin-top:0.5rem; color:#888;">Kung mayroon kang di pa naisusumiteng feedback, ito ay awtomatikong isusumite kapag bumalik ang koneksyon.</p>
 <a class="retry-btn" href="javascript:location.reload()"> I-refresh</a>
 </div>
 </body></html>`,
                        { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
                    );
                })
        );
        return;
    }

    // Cache-First with Stale-While-Revalidate for CSS, Fonts, Images, JS
    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            const fetchPromise = fetch(event.request).then((networkResponse) => {
                // Cache both same-origin (basic) and cross-origin (cors) successful responses
                if (networkResponse && networkResponse.status === 200 &&
                    (networkResponse.type === 'basic' || networkResponse.type === 'cors')) {
                    const responseToCache = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseToCache);
                    });
                }
                return networkResponse;
            }).catch(() => {
                // Network failed — return null so we fall back to cached version
                return null;
            });

            return cachedResponse || fetchPromise;
        })
    );
});

// Background Sync: wake the page to flush the queue once connectivity returns
self.addEventListener('sync', (event) => {
    if (event.tag === 'psau-feedback-sync') {
        console.log('[Service Worker] Background Sync triggered: psau-feedback-sync');
        event.waitUntil((async () => {
            const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
            for (const client of clients) {
                client.postMessage({ type: 'PSAU_TRIGGER_SYNC' });
            }
            // If no window client, sync will run on next page load via offline-sync.js DOMContentLoaded check
        })());
    }
});

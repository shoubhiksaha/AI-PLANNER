// Cache Buster v4
importScripts('./sw-constants.js');
const { CACHE_NAME, ASSETS_TO_CACHE } = self.SW_CONSTANTS;

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS_TO_CACHE);
        })
    );
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    const path = url.pathname;
    // Use network-first for core logic scripts and app shell to reduce stale-client UI bugs
    const isAppScript = path.endsWith('/app.js') || path.endsWith('/app-helpers.js');
    const isAppShell = path === '/' || path.endsWith('/index.html');

    if (isAppScript || isAppShell) {
        event.respondWith(
            caches.open(CACHE_NAME).then((cache) => {
                return fetch(event.request)
                    .then((networkResponse) => {
                        // Keep a local fallback copy for offline mode
                        cache.put(event.request, networkResponse.clone());
                        return networkResponse;
                    })
                    .catch(() => cache.match(event.request).then((cachedResponse) => {
                        return cachedResponse || fetch(event.request);
                    }));
            })
        );
    } else {
        // Default Cache-First strategy for static assets (HTML, styles.css, manifest, icons)
        event.respondWith(
            caches.match(event.request).then((response) => {
                return response || fetch(event.request);
            })
        );
    }
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cache) => {
                    if (cache !== CACHE_NAME) {
                        return caches.delete(cache);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

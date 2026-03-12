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
    // Apply stale-while-revalidate exclusively to core logic scripts
    const isAppScript = path.endsWith('/app.js') || path.endsWith('/app-helpers.js');

    if (isAppScript) {
        event.respondWith(
            caches.open(CACHE_NAME).then((cache) => {
                return cache.match(event.request).then((cachedResponse) => {
                    const fetchPromise = fetch(event.request).then((networkResponse) => {
                        // Background update the cache with the new script
                        cache.put(event.request, networkResponse.clone());
                        return networkResponse;
                    });
                    // Serve cached instantly, or wait for network if un-cached
                    return cachedResponse || fetchPromise;
                });
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

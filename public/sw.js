// Cache Buster v6
importScripts('./sw-constants.js');
const { CACHE_NAME, ASSETS_TO_CACHE } = self.SW_CONSTANTS;

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return Promise.all(
                ASSETS_TO_CACHE.map(url => {
                    return fetch(url, { cache: 'no-store' }).then(response => {
                        if (!response.ok) throw new TypeError('Bad response for ' + url);
                        return cache.put(url, response);
                    });
                })
            );
        })
    );
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    const path = url.pathname;

    // Only handle same-origin requests
    if (url.origin !== self.location.origin) return;

    // Network-first for core scripts + app shell
    const isAppScript = path.endsWith('/app.js') || path.endsWith('/app-helpers.js') || path.endsWith('/sw-register.js') || path.endsWith('/streak-utils.js');
    const isAppShell = path === '/' || path.endsWith('.html');

    if (isAppScript || isAppShell) {
        event.respondWith(
            caches.open(CACHE_NAME).then((cache) => {
                // { cache: 'no-store' } ensures we bypass the browser HTTP cache
                // and always hit the origin server for fresh content.
                return fetch(event.request, { cache: 'no-store' })
                    .then((networkResponse) => {
                        cache.put(event.request, networkResponse.clone());
                        return networkResponse;
                    })
                    .catch(() => {
                        // Offline fallback — ignoreSearch so app.js?v=16 matches cached /app.js
                        return cache.match(event.request, { ignoreSearch: true })
                            .then(r => r || caches.match(event.request));
                    });
            })
        );
    } else {
        // Cache-first for other same-origin static assets
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

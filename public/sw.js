// AI Planner service worker (B-18)
// - Only same-origin GET requests are handled; POSTs (syncs, payments) always go straight to the network.
// - Only complete 200 responses are cached, so error pages never get stuck in the cache.
// - No automatic skipWaiting(): a new version waits until the page asks for it
//   (the user taps "Reload" on the "Update available" banner, see sw-register.js).
importScripts('./sw-constants.js');
const { CACHE_NAME, ASSETS_TO_CACHE } = self.SW_CONSTANTS;

// Code, styles, pages and the manifest are network-first; everything else (icons, PDFs,
// versioned vendor files) is cache-first.
const NETWORK_FIRST_RE = /(?:^\/$|\.(?:html|js|css|json)$)/;

const isCacheable = (response) =>
    !!response && response.status === 200 && (response.type === 'basic' || response.type === 'default');

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => Promise.all(
            ASSETS_TO_CACHE.map((url) => fetch(url, { cache: 'no-store' }).then((response) => {
                if (!isCacheable(response)) throw new TypeError('Bad response for ' + url);
                return cache.put(url, response);
            }))
        ))
    );
});

async function networkFirst(request) {
    const cache = await caches.open(CACHE_NAME);
    try {
        // Navigation requests can't be re-issued with a RequestInit.
        const response = request.mode === 'navigate'
            ? await fetch(request)
            : await fetch(request, { cache: 'no-cache' });
        if (isCacheable(response)) {
            cache.put(request, response.clone()).catch(() => { });
        }
        return response;
    } catch (err) {
        // Offline fallback — ignoreSearch so app.js?v=26 matches a cached /app.js
        const cached = await cache.match(request, { ignoreSearch: true });
        if (cached) return cached;
        if (request.mode === 'navigate') {
            const shell = await cache.match('/index.html');
            if (shell) return shell;
        }
        throw err;
    }
}

async function cacheFirst(request) {
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (isCacheable(response)) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, response.clone()).catch(() => { });
    }
    return response;
}

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    // Firebase reserved URLs (auth handler, init.json) must never be served from cache.
    if (url.pathname.startsWith('/__/')) return;

    if (request.mode === 'navigate' || NETWORK_FIRST_RE.test(url.pathname)) {
        event.respondWith(networkFirst(request));
    } else {
        event.respondWith(cacheFirst(request));
    }
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((cacheNames) => Promise.all(
                cacheNames.map((cache) => (cache !== CACHE_NAME ? caches.delete(cache) : undefined))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

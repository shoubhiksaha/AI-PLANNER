const CACHE_NAME = 'ai-planner-v2';
const ASSETS_TO_CACHE = [
    '/',
    '/index.html',
    '/manifest.json',
    '/tailwind.css',
    '/styles.css',
    '/app-helpers.js',
    '/app.js',
    '/privacy.html',
    '/gear.html',
    '/planner.html',
    'https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap',
    'https://cdn-icons-png.flaticon.com/512/2921/2921226.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS_TO_CACHE);
        })
    );
});

self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request).then((response) => {
            return response || fetch(event.request);
        })
    );
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
        })
    );
});

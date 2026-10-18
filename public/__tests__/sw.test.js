/**
 * Service Worker Tests for AI Planner
 *
 * These tests execute the real public/sw.js inside a minimal fake service
 * worker global (event registry, CacheStorage, fetch), so the install,
 * fetch and activate handlers under test are the production code.
 *
 * @jest-environment node
 */

const fs = require('fs');
const path = require('path');
const SW_CONSTANTS = require('../sw-constants');

const { CACHE_NAME, ASSETS_TO_CACHE } = SW_CONSTANTS;
const SW_SOURCE = fs.readFileSync(path.resolve(__dirname, '../sw.js'), 'utf8');
const ORIGIN = 'https://planner.analogdigital.tech';

// ============================================
// FAKE SERVICE WORKER ENVIRONMENT
// ============================================

const keyOf = (req) => (typeof req === 'string' ? new URL(req, ORIGIN).href : req.url);
const stripSearch = (href) => href.split('?')[0];

class FakeCache {
    constructor() { this.entries = new Map(); }
    async put(req, res) { this.entries.set(keyOf(req), res); }
    async match(req, opts = {}) {
        const key = keyOf(req);
        if (this.entries.has(key)) return this.entries.get(key);
        if (opts.ignoreSearch) {
            for (const [k, v] of this.entries) if (stripSearch(k) === stripSearch(key)) return v;
        }
        return undefined;
    }
}

class FakeCacheStorage {
    constructor() { this.caches = new Map(); }
    async open(name) {
        if (!this.caches.has(name)) this.caches.set(name, new FakeCache());
        return this.caches.get(name);
    }
    async keys() { return Array.from(this.caches.keys()); }
    async delete(name) { return this.caches.delete(name); }
    async match(req, opts) {
        for (const cache of this.caches.values()) {
            const hit = await cache.match(req, opts);
            if (hit) return hit;
        }
        return undefined;
    }
}

const makeResponse = (status = 200, body = 'ok', type = 'basic') => ({
    status,
    ok: status >= 200 && status < 300,
    type,
    body,
    clone() { return makeResponse(status, body, type); },
});

const makeRequest = (url, { method = 'GET', mode = 'cors' } = {}) => ({ url: new URL(url, ORIGIN).href, method, mode });

function loadServiceWorker({ fetchImpl } = {}) {
    const listeners = {};
    const self = {
        location: { origin: ORIGIN },
        addEventListener: (type, fn) => { listeners[type] = fn; },
        skipWaiting: jest.fn(),
        clients: { claim: jest.fn(async () => { }) },
    };
    const caches = new FakeCacheStorage();
    const fetch = jest.fn(fetchImpl || (async () => makeResponse(200)));
    const importScripts = jest.fn(() => { self.SW_CONSTANTS = SW_CONSTANTS; });

    // eslint-disable-next-line no-new-func
    new Function('self', 'caches', 'fetch', 'importScripts', SW_SOURCE)(self, caches, fetch, importScripts);
    return { self, listeners, caches, fetch, importScripts };
}

async function dispatchFetch(sw, request) {
    let responded = null;
    const event = { request, respondWith: (p) => { responded = p; } };
    sw.listeners.fetch(event);
    return responded ? { handled: true, response: await responded } : { handled: false };
}

async function dispatchLifecycle(sw, type, data) {
    let waited = null;
    sw.listeners[type]({ data, waitUntil: (p) => { waited = p; } });
    if (waited) await waited;
}

// ============================================
// CONSTANTS
// ============================================

describe('Service Worker Constants', () => {
    test('CACHE_NAME follows versioned naming convention', () => {
        expect(CACHE_NAME).toMatch(/^ai-planner-v\d+$/);
    });

    test('ASSETS_TO_CACHE includes the app shell', () => {
        ['/', '/index.html', '/app.js', '/app-helpers.js', '/manifest.json', '/theme-init.js', '/tailwind.css']
            .forEach(asset => expect(ASSETS_TO_CACHE).toContain(asset));
    });

    test('every precached asset exists in public/', () => {
        ASSETS_TO_CACHE.filter(a => a !== '/').forEach((asset) => {
            expect(fs.existsSync(path.resolve(__dirname, '..', `.${asset}`))).toBe(true);
        });
    });

    test('ASSETS_TO_CACHE has no cross-origin URLs or API endpoints', () => {
        expect(ASSETS_TO_CACHE.find(url => /^https?:\/\//.test(url))).toBeUndefined();
        ['/syncPlanner', '/setupNotion', '/exportUserData', '/deleteUserAccount', '/byokSession']
            .forEach(endpoint => expect(ASSETS_TO_CACHE).not.toContain(endpoint));
    });
});

// ============================================
// INSTALL
// ============================================

describe('install', () => {
    test('loads constants via importScripts and precaches every asset', async () => {
        const sw = loadServiceWorker();
        expect(sw.importScripts).toHaveBeenCalledWith('./sw-constants.js');
        await dispatchLifecycle(sw, 'install');
        const cache = await sw.caches.open(CACHE_NAME);
        expect(cache.entries.size).toBe(ASSETS_TO_CACHE.length);
    });

    test('does not call skipWaiting on its own (no forced takeover mid-sync)', async () => {
        const sw = loadServiceWorker();
        await dispatchLifecycle(sw, 'install');
        expect(sw.self.skipWaiting).not.toHaveBeenCalled();
    });

    test('fails the install if an asset returns an error page', async () => {
        const sw = loadServiceWorker({
            fetchImpl: async (url) => (String(url).includes('app.js') ? makeResponse(500, 'oops') : makeResponse(200)),
        });
        await expect(dispatchLifecycle(sw, 'install')).rejects.toThrow(/Bad response/);
    });
});

// ============================================
// FETCH
// ============================================

describe('fetch', () => {
    test('ignores non-GET requests (sync and payment POSTs go straight to the network)', async () => {
        const sw = loadServiceWorker();
        const result = await dispatchFetch(sw, makeRequest('/syncPlanner', { method: 'POST' }));
        expect(result.handled).toBe(false);
        expect(sw.fetch).not.toHaveBeenCalled();
    });

    test('ignores cross-origin requests and Firebase reserved URLs', async () => {
        const sw = loadServiceWorker();
        expect((await dispatchFetch(sw, makeRequest('https://www.gstatic.com/firebasejs/app.js'))).handled).toBe(false);
        expect((await dispatchFetch(sw, makeRequest('/__/auth/handler'))).handled).toBe(false);
    });

    test('network-first for scripts: fresh 200 responses are cached', async () => {
        const sw = loadServiceWorker({ fetchImpl: async () => makeResponse(200, 'new app.js') });
        const { response } = await dispatchFetch(sw, makeRequest('/app.js?v=26'));
        expect(response.body).toBe('new app.js');
        const cache = await sw.caches.open(CACHE_NAME);
        await new Promise(r => setTimeout(r, 0));
        expect((await cache.match(`${ORIGIN}/app.js?v=26`)).body).toBe('new app.js');
    });

    test('never caches 5xx error pages', async () => {
        const sw = loadServiceWorker({ fetchImpl: async () => makeResponse(503, '<html>Service Unavailable</html>') });
        const { response } = await dispatchFetch(sw, makeRequest('/app.js?v=26'));
        expect(response.status).toBe(503);
        await new Promise(r => setTimeout(r, 0));
        const cache = await sw.caches.open(CACHE_NAME);
        expect(cache.entries.size).toBe(0);
    });

    test('offline: falls back to the cached copy, ignoring the version query', async () => {
        const sw = loadServiceWorker({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
        const cache = await sw.caches.open(CACHE_NAME);
        await cache.put('/app.js', makeResponse(200, 'cached app.js'));
        const { response } = await dispatchFetch(sw, makeRequest('/app.js?v=99'));
        expect(response.body).toBe('cached app.js');
    });

    test('offline navigation falls back to the cached shell', async () => {
        const sw = loadServiceWorker({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
        const cache = await sw.caches.open(CACHE_NAME);
        await cache.put('/index.html', makeResponse(200, 'shell'));
        const { response } = await dispatchFetch(sw, makeRequest('/history', { mode: 'navigate' }));
        expect(response.body).toBe('shell');
    });

    test('navigation requests are fetched without a RequestInit (would throw in browsers)', async () => {
        const sw = loadServiceWorker();
        await dispatchFetch(sw, makeRequest('/', { mode: 'navigate' }));
        expect(sw.fetch).toHaveBeenCalledTimes(1);
        expect(sw.fetch.mock.calls[0]).toHaveLength(1);
    });

    test('cache-first for images: served from cache without touching the network', async () => {
        const sw = loadServiceWorker();
        const cache = await sw.caches.open(CACHE_NAME);
        await cache.put('/icon-192.png', makeResponse(200, 'png'));
        const { response } = await dispatchFetch(sw, makeRequest('/icon-192.png'));
        expect(response.body).toBe('png');
        expect(sw.fetch).not.toHaveBeenCalled();
    });

    test('cache-first miss: a 404 is returned but not cached', async () => {
        const sw = loadServiceWorker({ fetchImpl: async () => makeResponse(404, 'missing') });
        const { response } = await dispatchFetch(sw, makeRequest('/vendor/missing.png'));
        expect(response.status).toBe(404);
        await new Promise(r => setTimeout(r, 0));
        const cache = await sw.caches.open(CACHE_NAME);
        expect(cache.entries.size).toBe(0);
    });
});

// ============================================
// ACTIVATE + MESSAGES
// ============================================

describe('activate and update handshake', () => {
    test('deletes old caches, keeps the current one and claims clients', async () => {
        const sw = loadServiceWorker();
        await sw.caches.open('ai-planner-v1');
        await sw.caches.open(CACHE_NAME);
        await dispatchLifecycle(sw, 'activate');
        expect(await sw.caches.keys()).toEqual([CACHE_NAME]);
        expect(sw.self.clients.claim).toHaveBeenCalled();
    });

    test('skipWaiting only when the page asks (user tapped "Reload")', () => {
        const sw = loadServiceWorker();
        sw.listeners.message({ data: { type: 'SOMETHING_ELSE' } });
        expect(sw.self.skipWaiting).not.toHaveBeenCalled();
        sw.listeners.message({ data: { type: 'SKIP_WAITING' } });
        expect(sw.self.skipWaiting).toHaveBeenCalledTimes(1);
    });
});

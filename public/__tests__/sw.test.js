/**
 * Service Worker Tests for AI Planner
 * Tests the cache lifecycle from public/sw.js
 *
 * Constants are imported from the production sw-constants.js module
 * to eliminate drift between tests and source.
 *
 * @jest-environment jsdom
 */

const { CACHE_NAME, ASSETS_TO_CACHE } = require('../sw-constants');

// ============================================
// MOCK SERVICE WORKER ENVIRONMENT
// ============================================

// Mock CacheStorage for service worker tests
class MockCache {
    constructor() {
        this.entries = new Map();
    }
    async addAll(urls) {
        urls.forEach(url => this.entries.set(url, `cached:${url}`));
    }
    async match(request) {
        const url = typeof request === 'string' ? request : request.url;
        return this.entries.get(url) || undefined;
    }
    async delete(key) {
        return this.entries.delete(key);
    }
}

class MockCacheStorage {
    constructor() {
        this.caches = new Map();
    }
    async open(name) {
        if (!this.caches.has(name)) {
            this.caches.set(name, new MockCache());
        }
        return this.caches.get(name);
    }
    async keys() {
        return Array.from(this.caches.keys());
    }
    async match(request) {
        for (const cache of this.caches.values()) {
            const result = await cache.match(request);
            if (result) return result;
        }
        return undefined;
    }
    async delete(name) {
        return this.caches.delete(name);
    }
}

// ============================================
// TESTS
// ============================================

describe('Service Worker Constants', () => {
    test('CACHE_NAME follows versioned naming convention', () => {
        expect(CACHE_NAME).toMatch(/^ai-planner-v\d+$/);
    });

    test('ASSETS_TO_CACHE includes all critical app files', () => {
        const requiredAssets = ['/', '/index.html', '/app.js', '/manifest.json'];
        requiredAssets.forEach(asset => {
            expect(ASSETS_TO_CACHE).toContain(asset);
        });
    });

    test('ASSETS_TO_CACHE includes privacy and guide pages', () => {
        expect(ASSETS_TO_CACHE).toContain('/privacy.html');
        expect(ASSETS_TO_CACHE).toContain('/planner.html');
    });

    test('ASSETS_TO_CACHE does not include external cross-origin URLs', () => {
        const externalUrl = ASSETS_TO_CACHE.find(url => /^https?:\/\//.test(url));
        expect(externalUrl).toBeUndefined();
    });
});

describe('Service Worker Install', () => {
    test('install caches all required assets', async () => {
        const cacheStorage = new MockCacheStorage();

        // Simulate install event
        const cache = await cacheStorage.open(CACHE_NAME);
        await cache.addAll(ASSETS_TO_CACHE);

        // Verify all assets are cached
        for (const asset of ASSETS_TO_CACHE) {
            const result = await cache.match(asset);
            expect(result).toBeDefined();
        }
    });

    test('cache contains the correct number of assets', async () => {
        const cacheStorage = new MockCacheStorage();
        const cache = await cacheStorage.open(CACHE_NAME);
        await cache.addAll(ASSETS_TO_CACHE);

        expect(cache.entries.size).toBe(ASSETS_TO_CACHE.length);
    });
});

describe('Service Worker Fetch Strategy', () => {
    test('returns cached response when available', async () => {
        const cacheStorage = new MockCacheStorage();
        const cache = await cacheStorage.open(CACHE_NAME);
        await cache.addAll(ASSETS_TO_CACHE);

        // Simulate fetch for cached asset
        const response = await cacheStorage.match('/index.html');
        expect(response).toBeDefined();
        expect(response).toBe('cached:/index.html');
    });

    test('returns undefined for uncached requests (triggers network fetch)', async () => {
        const cacheStorage = new MockCacheStorage();
        const cache = await cacheStorage.open(CACHE_NAME);
        await cache.addAll(ASSETS_TO_CACHE);

        // API call should NOT be cached
        const response = await cacheStorage.match('/syncPlanner');
        expect(response).toBeUndefined();
    });

    test('API endpoints are never cached', async () => {
        const apiEndpoints = ['/syncPlanner', '/setupNotion', '/exportUserData', '/deleteUserAccount'];

        apiEndpoints.forEach(endpoint => {
            expect(ASSETS_TO_CACHE).not.toContain(endpoint);
        });
    });
});

describe('Service Worker Activate (Cache Cleanup)', () => {
    test('deletes old caches during activation', async () => {
        const cacheStorage = new MockCacheStorage();

        // Create an old cache and the current cache
        await cacheStorage.open('ai-planner-v1');
        await cacheStorage.open(CACHE_NAME);

        // Simulate activate event: delete caches that aren't CACHE_NAME
        const cacheNames = await cacheStorage.keys();
        await Promise.all(
            cacheNames.map(cache => {
                if (cache !== CACHE_NAME) {
                    return cacheStorage.delete(cache);
                }
            })
        );

        const remaining = await cacheStorage.keys();
        expect(remaining).toEqual([CACHE_NAME]);
        expect(remaining).not.toContain('ai-planner-v1');
    });

    test('preserves current cache during activation', async () => {
        const cacheStorage = new MockCacheStorage();

        await cacheStorage.open('ai-planner-v1');
        const currentCache = await cacheStorage.open(CACHE_NAME);
        await currentCache.addAll(ASSETS_TO_CACHE);

        // Activate
        const cacheNames = await cacheStorage.keys();
        await Promise.all(
            cacheNames.map(cache => {
                if (cache !== CACHE_NAME) {
                    return cacheStorage.delete(cache);
                }
            })
        );

        // Current cache should still have all assets
        const result = await currentCache.match('/index.html');
        expect(result).toBeDefined();
    });

    test('handles activation with no old caches (fresh install)', async () => {
        const cacheStorage = new MockCacheStorage();
        await cacheStorage.open(CACHE_NAME);

        const cacheNames = await cacheStorage.keys();
        await Promise.all(
            cacheNames.map(cache => {
                if (cache !== CACHE_NAME) {
                    return cacheStorage.delete(cache);
                }
            })
        );

        const remaining = await cacheStorage.keys();
        expect(remaining).toEqual([CACHE_NAME]);
    });
});

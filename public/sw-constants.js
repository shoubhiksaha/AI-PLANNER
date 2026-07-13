/**
 * AI Planner — Service Worker Constants (UMD Module)
 *
 * Shared between sw.js (browser service worker) and Jest tests (Node).
 * - Service Worker: importScripts('./sw-constants.js') → self.SW_CONSTANTS
 * - Node/Jest: require('../sw-constants')
 *
 * Keep this file free of DOM/SW APIs — constants only.
 */
(function (exports) {
    exports.CACHE_NAME = 'ai-planner-v39';

    exports.ASSETS_TO_CACHE = [
        '/',
        '/index.html',
        '/manifest.json',
        '/tailwind.css',
        '/app-helpers.js',
        '/app.js',
        '/streak-utils.js',
        '/sw-register.js',
        '/privacy.html',
        '/pricing-policy.html',
        '/refund-policy.html',
        '/gear.html',
        '/planner.html',
        '/icon-192.png',
        '/icon-512.png'
    ];

})(typeof module !== 'undefined' && module.exports ? module.exports : (self.SW_CONSTANTS = {}));

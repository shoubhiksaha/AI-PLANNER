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
    'use strict';

    exports.CACHE_NAME = 'ai-planner-v4';

    exports.ASSETS_TO_CACHE = [
        '/',
        '/index.html',
        '/manifest.json',
        '/tailwind.css',
        '/app-helpers.js',
        '/app.js',
        '/privacy.html',
        '/gear.html',
        '/planner.html',
        'https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap',
        '/icon-192.png',
        '/icon-512.png'
    ];

})(typeof module !== 'undefined' && module.exports ? module.exports : (self.SW_CONSTANTS = {}));

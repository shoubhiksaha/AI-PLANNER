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
    exports.CACHE_NAME = 'ai-planner-v53';

    exports.ASSETS_TO_CACHE = [
        '/',
        '/index.html',
        '/manifest.json',
        '/tailwind.css',
        '/app-helpers.js',
        '/env-config.js',
        '/app.js',
        '/streak-utils.js',
        '/sw-register.js',
        '/privacy.html',
        '/pricing-policy.html',
        '/refund-policy.html',
        '/planner.html',
        '/themes/packs.js',
        '/theme-init.js',
        '/brand/app-icon.svg',
        '/brand/favicon.svg',
        '/brand/app-icon-aqua.svg',
        '/brand/offering-by-adt-stacked-light.svg',
        '/brand/offering-by-adt-stacked-dark.svg',
        '/brand/offering-by-adt-inline-light.svg',
        '/brand/offering-by-adt-inline-dark.svg',
        '/fonts/SpaceGrotesk-500.woff2',
        '/fonts/SpaceGrotesk-700.woff2',
        '/fonts/IBMPlexSans-400.woff2',
        '/fonts/IBMPlexSans-500.woff2',
        '/fonts/IBMPlexSans-600.woff2',
        '/favicon-48.png',
        '/icon-192.png',
        '/icon-512.png',
        '/icon-maskable-512.png',
        '/apple-touch-icon.png'
    ];

})(typeof module !== 'undefined' && module.exports ? module.exports : (self.SW_CONSTANTS = {}));

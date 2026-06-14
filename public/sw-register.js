// Service Worker Registration — Cache Buster v6
//
// Key design decisions:
// 1. controllerchange listener is attached SYNCHRONOUSLY (before 'load')
//    so we never miss an activation event.
// 2. We only auto-reload when UPDATING from an old SW to a new one.
//    On first install (no prior controller), the page already has fresh
//    content from the network, so reloading would be wasteful/harmful.

if ('serviceWorker' in navigator) {

    // Snapshot: was there already a SW controlling this page?
    const hadPriorController = !!navigator.serviceWorker.controller;

    // 1. Reload listener — only when upgrading from a previous version
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (hadPriorController && !refreshing) {
            refreshing = true;
            window.location.reload();
        }
    });

    // 2. Register + auto-apply updates on load
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(reg => {
            console.log('SW registered');

            // If a waiting worker already exists (from a prior visit that left
            // an unapplied update), tell it to take over right now.
            if (reg.waiting) {
                reg.waiting.postMessage({ type: 'SKIP_WAITING' });
            }

            reg.addEventListener('updatefound', () => {
                const newWorker = reg.installing;
                newWorker.addEventListener('statechange', () => {
                    if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                        // New version ready — activate immediately.
                        newWorker.postMessage({ type: 'SKIP_WAITING' });
                    }
                });
            });
        }).catch(e => console.log('SW registration failed', e));
    });
}

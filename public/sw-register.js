// Service Worker registration (B-18)
//
// A new deploy never reloads the page by itself. When an updated worker is
// installed we show an "Update available — Reload" banner. The banner is held
// back while a sync, recording or payment is in progress (app.js sets
// <html data-busy="true"> and fires "ai-planner:idle" when work finishes).
(function () {
    if (!('serviceWorker' in navigator)) return;

    var waitingWorker = null;
    var reloadRequested = false;

    var isBusy = function () {
        return document.documentElement.dataset.busy === 'true';
    };

    var banner = function () { return document.getElementById('update-banner'); };

    var showBanner = function () {
        var el = banner();
        if (!el) return;
        if (isBusy()) {
            window.addEventListener('ai-planner:idle', showBanner, { once: true });
            return;
        }
        el.classList.remove('hidden');
        el.classList.add('flex');
    };

    var hideBanner = function () {
        var el = banner();
        if (!el) return;
        el.classList.add('hidden');
        el.classList.remove('flex');
    };

    var onUpdateReady = function (worker) {
        waitingWorker = worker;
        showBanner();
    };

    // Reload only when the user asked for the update.
    navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (!reloadRequested) return;
        reloadRequested = false;
        window.location.reload();
    });

    document.addEventListener('click', function (e) {
        var target = e.target && e.target.closest ? e.target.closest('#update-reload-btn') : null;
        if (!target) return;
        if (isBusy()) {
            hideBanner();
            window.addEventListener('ai-planner:idle', showBanner, { once: true });
            return;
        }
        hideBanner();
        if (waitingWorker) {
            reloadRequested = true;
            waitingWorker.postMessage({ type: 'SKIP_WAITING' });
        } else {
            window.location.reload();
        }
    });

    window.addEventListener('load', function () {
        navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(function (reg) {
            if (!reg) return;
            if (reg.waiting && navigator.serviceWorker.controller) {
                onUpdateReady(reg.waiting);
            }
            reg.addEventListener('updatefound', function () {
                var newWorker = reg.installing;
                if (!newWorker) return;
                newWorker.addEventListener('statechange', function () {
                    if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                        onUpdateReady(newWorker);
                    }
                });
            });
            // Long-lived tabs (and the mobile WebView) check for new deploys hourly.
            setInterval(function () { reg.update().catch(function () { }); }, 60 * 60 * 1000);
        }).catch(function (e) { console.log('SW registration failed', e); });
    });
})();

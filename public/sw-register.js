if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').then(reg => {
            console.log('SW registered');
            
            reg.addEventListener('updatefound', () => {
                const newWorker = reg.installing;
                newWorker.addEventListener('statechange', () => {
                    if (newWorker.state === 'installed') {
                        if (navigator.serviceWorker.controller) {
                            // New update available
                            showUpdateToast();
                        }
                    }
                });
            });
        }).catch(e => console.log('SW failed', e));

        // Track when SW controls the page after a skipWaiting
        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (!refreshing) {
                refreshing = true;
                window.location.reload();
            }
        });
    });
}

function showUpdateToast() {
    const toast = document.createElement('div');
    toast.style.position = 'fixed';
    toast.style.bottom = '20px';
    toast.style.left = '50%';
    toast.style.transform = 'translateX(-50%)';
    toast.style.backgroundColor = '#2563eb'; // blue-600
    toast.style.color = '#ffffff';
    toast.style.padding = '12px 24px';
    toast.style.borderRadius = '9999px';
    toast.style.boxShadow = '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)';
    toast.style.zIndex = '9999';
    toast.style.display = 'flex';
    toast.style.alignItems = 'center';
    toast.style.gap = '12px';
    toast.style.fontSize = '14px';
    toast.style.fontWeight = '500';
    toast.style.cursor = 'pointer';
    toast.innerHTML = `
        <span>A new version is available!</span>
        <button style="background: white; color: #2563eb; border: none; padding: 4px 10px; border-radius: 999px; font-weight: bold; cursor: pointer;">Refresh</button>
    `;
    
    toast.addEventListener('click', () => {
        navigator.serviceWorker.getRegistration().then(reg => {
            if (reg && reg.waiting) {
                reg.waiting.postMessage({ type: 'SKIP_WAITING' });
            } else {
                window.location.reload();
            }
        });
    });

    document.body.appendChild(toast);
}

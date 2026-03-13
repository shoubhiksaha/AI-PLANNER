if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then(r => console.log('SW registered'))
            .catch(e => console.log('SW failed', e));
    });
}

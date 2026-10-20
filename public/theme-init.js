// Applies the saved (or OS) theme before first paint to avoid a light flash (B-30).
// Loaded synchronously from <head>; must stay tiny and dependency-free.
(function () {
    try {
        var saved = null;
        try { saved = localStorage.getItem('theme'); } catch (_) { /* storage blocked */ }
        var mode = (saved === 'light' || saved === 'dark' || saved === 'oled' || saved === 'auto') ? saved : 'auto';
        var prefersDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
        var effect = mode === 'auto' ? (prefersDark ? 'dark' : 'light') : mode;
        var html = document.documentElement;
        html.classList.remove('dark-mode', 'oled-mode');
        if (effect === 'dark') html.classList.add('dark-mode');
        if (effect === 'oled') html.classList.add('oled-mode');
    } catch (_) { /* never block page load */ }
})();

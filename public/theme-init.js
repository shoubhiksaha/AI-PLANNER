// Applies the saved (or OS) theme before first paint to avoid a light flash (B-30).
// Loaded synchronously from <head>; must stay tiny and dependency-free.
// Themes: 'auto' (default), 'light', 'dark'. The old 'oled' choice now maps to the near-black dark theme.
(function () {
    try {
        var saved = null;
        try { saved = localStorage.getItem('theme'); } catch (_) { /* storage blocked */ }
        if (saved === 'oled') saved = 'dark';
        var mode = (saved === 'light' || saved === 'dark' || saved === 'auto') ? saved : 'auto';
        var prefersDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
        var effect = mode === 'auto' ? (prefersDark ? 'dark' : 'light') : mode;
        var html = document.documentElement;
        html.classList.remove('dark-mode', 'oled-mode');
        if (effect === 'dark') html.classList.add('dark-mode');
        html.dataset.themeMode = mode;
        if (window.ThemePacks) window.ThemePacks.syncThemeColor(document);
    } catch (_) { /* never block page load */ }
})();

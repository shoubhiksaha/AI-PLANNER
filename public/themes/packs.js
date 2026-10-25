/**
 * AI Planner — theme packs (docs/THEMES.md).
 *
 * A theme pack is one entry in PACKS plus, for every pack except the default, a stylesheet
 * public/themes/<id>.css imported at the top of styles.css. The light/dark mode
 * (theme-init.js) is separate, so every pack has a light and a dark version.
 *
 * Loaded synchronously in <head>, before theme-init.js, so the saved style is applied
 * before first paint. A pack with an `emoji` map shows an emoji in place of each listed
 * line icon: the emoji sits in a <span class="icon-twin"> right after the <svg class="icon">,
 * and styles.css hides one or the other. A MutationObserver keeps the twins in step with
 * icons that app.js renders or changes later.
 *
 * Browser: self.ThemePacks. Jest: require('../themes/packs').
 */
(function (exports, isBrowserScript) {
    'use strict';

    exports.STORAGE_KEY = 'style';
    exports.DEFAULT_STYLE = 'minimal';

    /** Line icons that stay line icons in every pack: controls, not content. */
    exports.CONTROL_ICONS = ['menu', 'x', 'check', 'plus', 'chevron-down', 'chevron-left', 'external-link', 'arrow-right'];

    exports.PACKS = [
        {
            id: 'minimal',
            label: 'Minimalist modern',
            description: 'Black, white and aqua, with line icons.',
            swatch: ['#0A0A0A', '#01F9C9'],
            themeColor: { light: '#FFFFFF', dark: '#0A0A0A' },
            emoji: null,
        },
        {
            id: 'cheerful',
            label: 'Cheerful',
            description: 'The original look: soft colours, emoji and rounded cards.',
            swatch: ['#047857', '#F59E0B'],
            themeColor: { light: '#F8FAFC', dark: '#0F172A' },
            emoji: {
                camera: '📷', image: '🖼️', folder: '📁',
                sun: '☀️', moon: '🌙', monitor: '🖥️',
                calendar: '📅', 'list-checks': '✅', 'book-open': '📖', mic: '🎤',
                lock: '🔒', history: '🕘', 'chart-column': '📊', settings: '⚙️', gem: '👑',
                'file-text': '📄', shield: '🛡️', receipt: '💳', 'rotate-ccw': '💸',
                download: '📦', 'trash-2': '🗑️', 'log-out': '🚪',
                flame: '🔥', coins: '🪙', snowflake: '❄️',
                'hard-drive': '🗂️', database: '📝', sheet: '📈',
                'triangle-alert': '⚠️', info: 'ℹ️', user: '👤', 'key-round': '🔑', 'pen-line': '✏️',
                'circle-check': '✅', 'circle-x': '❌', hourglass: '⏳', smartphone: '📱',
                'refresh-cw': '🔄', 'notebook-pen': '📓', 'scan-line': '📸',
            },
        },
    ];

    exports.getPack = (id) =>
        exports.PACKS.find((p) => p.id === id) || exports.PACKS.find((p) => p.id === exports.DEFAULT_STYLE);

    /** A known pack id; anything else (missing, removed, tampered) falls back to the default. */
    exports.resolveStyle = (id) => exports.getPack(id).id;

    const iconNameOf = (svg) => {
        const use = svg.querySelector && svg.querySelector('use');
        const href = use ? (use.getAttribute('href') || use.getAttribute('xlink:href') || '') : '';
        return href.indexOf('#i-') === 0 ? href.slice(3) : '';
    };

    /** Adds, updates or removes the emoji twin of one line icon for the given pack. */
    exports.syncIcon = (svg, pack) => {
        const name = iconNameOf(svg);
        const emoji = (pack && pack.emoji && name && pack.emoji[name]) || '';
        let twin = svg.nextElementSibling;
        if (twin && !twin.classList.contains('icon-twin')) twin = null;
        if (!emoji) {
            if (twin) twin.remove();
            svg.classList.remove('icon-swapped');
            return;
        }
        if (!twin) {
            twin = svg.ownerDocument.createElement('span');
            twin.setAttribute('aria-hidden', 'true');
            svg.after(twin);
        }
        // Same size and spacing classes as the icon it stands in for.
        const classes = ['icon-twin'];
        svg.classList.forEach((c) => { if (c !== 'icon' && c !== 'icon-swapped') classes.push(c); });
        twin.className = classes.join(' ');
        twin.dataset.icon = name;
        if (twin.textContent !== emoji) twin.textContent = emoji;
        svg.classList.add('icon-swapped');
    };

    exports.syncIcons = (root, pack) => {
        if (!root || root.nodeType !== 1) return;
        if (root.matches('svg.icon')) exports.syncIcon(root, pack);
        root.querySelectorAll('svg.icon').forEach((svg) => exports.syncIcon(svg, pack));
    };

    /**
     * Keeps twins in step with the page: icons the parser or app.js adds, and icons whose
     * <use href> changes (the theme button). Returns the observer (one per document).
     */
    exports.watchIcons = (doc, currentPack) => {
        if (doc.__themeIconObserver || typeof MutationObserver === 'undefined') return doc.__themeIconObserver || null;
        const observer = new MutationObserver((records) => {
            try {
                const pack = currentPack();
                // A pack without emoji has no twins to keep (applyStyle removed them).
                if (!pack || !pack.emoji) return;
                records.forEach((r) => {
                    if (r.type === 'attributes') {
                        const svg = r.target.closest && r.target.closest('svg.icon');
                        if (svg) exports.syncIcon(svg, pack);
                        return;
                    }
                    r.addedNodes.forEach((n) => {
                        if (n.nodeType !== 1 || n.classList.contains('icon-twin')) return;
                        // While parsing, <use> can arrive after its <svg> was reported.
                        const host = n.closest('svg.icon');
                        if (host) exports.syncIcon(host, pack);
                        else exports.syncIcons(n, pack);
                    });
                });
            } catch (_) { /* an icon without its emoji is fine; a broken page is not */ }
        });
        observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
        doc.__themeIconObserver = observer;
        return observer;
    };

    /**
     * The browser bar colour of the current pack. In Match device mode the light and dark
     * <meta name="theme-color"> tags follow the device; a chosen Light or Dark mode
     * (data-theme-mode, set by theme-init.js and applyTheme) sets both to that mode's colour.
     */
    exports.syncThemeColor = (doc) => {
        const html = doc.documentElement;
        const pack = exports.getPack(html.dataset.style);
        const mode = html.dataset.themeMode;
        doc.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
            const dark = mode === 'light' || mode === 'dark' ? mode === 'dark' : /dark/.test(m.getAttribute('media') || '');
            m.setAttribute('content', dark ? pack.themeColor.dark : pack.themeColor.light);
        });
    };

    /** Applies a pack to the document: data-style, data-icons, the browser theme colour and the icons. */
    exports.applyStyle = (id, doc) => {
        const pack = exports.getPack(id);
        const html = doc.documentElement;
        html.dataset.style = pack.id;
        html.dataset.icons = pack.emoji ? 'emoji' : 'line';
        exports.syncThemeColor(doc);
        exports.syncIcons(doc.body || html, pack);
        return pack.id;
    };

    exports.savedStyle = (storage) => {
        try { return exports.resolveStyle(storage ? storage.getItem(exports.STORAGE_KEY) : null); } catch (_) { return exports.DEFAULT_STYLE; }
    };

    exports.saveStyle = (id, storage) => {
        try { if (storage) storage.setItem(exports.STORAGE_KEY, exports.resolveStyle(id)); } catch (_) { /* storage blocked */ }
    };

    /** localStorage, or null where it is blocked or missing. */
    const browserStorage = () => {
        try { return typeof window !== 'undefined' ? window.localStorage : null; } catch (_) { return null; }
    };

    /** Saves and applies the user's choice (if storage is blocked, it applies to this page only). */
    exports.setStyle = (id, doc, storage = browserStorage()) => {
        exports.saveStyle(id, storage);
        return exports.applyStyle(id, doc);
    };

    /** A storage event that can change the style: a new style, or storage cleared (key null). */
    exports.isStyleChange = (e) => e.key === exports.STORAGE_KEY || e.key === null;

    if (isBrowserScript) {
        try {
            exports.applyStyle(exports.savedStyle(browserStorage()), document);
            exports.watchIcons(document, () => exports.getPack(document.documentElement.dataset.style));
            // Keep other open tabs in step when the style changes in one of them.
            window.addEventListener('storage', (e) => {
                if (exports.isStyleChange(e)) exports.applyStyle(exports.savedStyle(browserStorage()), document);
            });
        } catch (_) { /* never block page load */ }
    }
})(
    typeof module !== 'undefined' && module.exports ? module.exports : (self.ThemePacks = {}),
    typeof module === 'undefined'
);

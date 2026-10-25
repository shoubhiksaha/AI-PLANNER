/**
 * @jest-environment jsdom
 */
const fs = require('fs');
const path = require('path');
const packs = require('../themes/packs');

const PUBLIC = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(PUBLIC, file), 'utf8');
const spriteIcons = () => [...read('index.html').matchAll(/<symbol id="i-([a-z0-9-]+)"/g)].map(m => m[1]);

const memoryStorage = (initial = {}) => {
    const data = { ...initial };
    return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, data };
};
const blockedStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };

const iconMarkup = (name, extra = '') => `<svg class="icon ${extra}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;

describe('theme pack registry', () => {
    test('pack ids are unique and the default pack exists', () => {
        const ids = packs.PACKS.map(p => p.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toContain(packs.DEFAULT_STYLE);
        expect(ids).toEqual(['minimal', 'cheerful']);
    });

    test('every pack has a label, a description, a two-colour swatch and theme colours', () => {
        const hex = /^#[0-9A-F]{6}$/i;
        packs.PACKS.forEach((p) => {
            expect(p.label).toBeTruthy();
            expect(p.description).toBeTruthy();
            expect(p.swatch).toHaveLength(2);
            p.swatch.forEach(c => expect(c).toMatch(hex));
            expect(p.themeColor.light).toMatch(hex);
            expect(p.themeColor.dark).toMatch(hex);
        });
    });

    test('every non-default pack has a stylesheet that styles.css imports, and no stylesheet is orphaned', () => {
        const styles = read('styles.css');
        const extra = packs.PACKS.filter(p => p.id !== packs.DEFAULT_STYLE).map(p => p.id);
        extra.forEach((id) => {
            expect(fs.existsSync(path.join(PUBLIC, 'themes', `${id}.css`))).toBe(true);
            expect(styles).toContain(`@import "./themes/${id}.css";`);
            expect(read(`themes/${id}.css`)).toContain(`html[data-style="${id}"]`);
        });
        const cssFiles = fs.readdirSync(path.join(PUBLIC, 'themes')).filter(f => f.endsWith('.css')).map(f => f.replace(/\.css$/, ''));
        expect(cssFiles.sort()).toEqual(extra.sort());
    });

    test('emoji maps cover every content icon in the sprite and name no missing icons', () => {
        const sprite = spriteIcons();
        packs.CONTROL_ICONS.forEach(name => expect(sprite).toContain(name));
        packs.PACKS.filter(p => p.emoji).forEach((p) => {
            const content = sprite.filter(n => !packs.CONTROL_ICONS.includes(n));
            expect(content.filter(n => !p.emoji[n])).toEqual([]);
            expect(Object.keys(p.emoji).filter(n => !sprite.includes(n))).toEqual([]);
            packs.CONTROL_ICONS.forEach(n => expect(p.emoji[n]).toBeUndefined());
        });
    });

    test('unknown, missing or tampered styles fall back to the default', () => {
        expect(packs.resolveStyle('cheerful')).toBe('cheerful');
        expect(packs.resolveStyle('retro-90s')).toBe('minimal');
        expect(packs.resolveStyle(null)).toBe('minimal');
        expect(packs.resolveStyle('<script>')).toBe('minimal');
    });

    test('saved style survives blocked storage', () => {
        expect(packs.savedStyle(memoryStorage({ style: 'cheerful' }))).toBe('cheerful');
        expect(packs.savedStyle(memoryStorage({ style: 'gone' }))).toBe('minimal');
        expect(packs.savedStyle(null)).toBe('minimal');
        expect(packs.savedStyle(blockedStorage)).toBe('minimal');

        const store = memoryStorage();
        packs.saveStyle('cheerful', store);
        expect(store.data.style).toBe('cheerful');
        packs.saveStyle('not-a-pack', store);
        expect(store.data.style).toBe('minimal');
        expect(() => packs.saveStyle('cheerful', blockedStorage)).not.toThrow();
        expect(() => packs.saveStyle('cheerful', null)).not.toThrow();
    });
});

describe('applying a pack', () => {
    beforeEach(() => {
        document.head.innerHTML = `
            <meta name="theme-color" content="#FFFFFF" media="(prefers-color-scheme: light)">
            <meta name="theme-color" content="#0A0A0A" media="(prefers-color-scheme: dark)">`;
        document.body.innerHTML = `
            <button id="b1">${iconMarkup('sun', 'icon-lg mt-0.5')} Light</button>
            <button id="b2">${iconMarkup('x')} Close</button>
            <span id="b3">${iconMarkup('mic')}</span>`;
        delete document.documentElement.dataset.style;
    });

    test('sets data-style, data-icons and the browser theme colour', () => {
        expect(packs.applyStyle('cheerful', document)).toBe('cheerful');
        expect(document.documentElement.dataset.style).toBe('cheerful');
        expect(document.documentElement.dataset.icons).toBe('emoji');
        const [light, dark] = document.querySelectorAll('meta[name="theme-color"]');
        expect(light.getAttribute('content')).toBe('#F8FAFC');
        expect(dark.getAttribute('content')).toBe('#0F172A');

        expect(packs.applyStyle('nope', document)).toBe('minimal');
        expect(document.documentElement.dataset.icons).toBe('line');
        expect(light.getAttribute('content')).toBe('#FFFFFF');
        expect(dark.getAttribute('content')).toBe('#0A0A0A');
    });

    test('a chosen Light or Dark mode sets both browser theme colours to that mode', () => {
        const [light, dark] = document.querySelectorAll('meta[name="theme-color"]');
        const html = document.documentElement;
        packs.applyStyle('cheerful', document);

        html.dataset.themeMode = 'light';
        packs.syncThemeColor(document);
        expect([light.getAttribute('content'), dark.getAttribute('content')]).toEqual(['#F8FAFC', '#F8FAFC']);

        html.dataset.themeMode = 'dark';
        packs.syncThemeColor(document);
        expect([light.getAttribute('content'), dark.getAttribute('content')]).toEqual(['#0F172A', '#0F172A']);

        html.dataset.themeMode = 'auto';
        packs.applyStyle('minimal', document);
        expect([light.getAttribute('content'), dark.getAttribute('content')]).toEqual(['#FFFFFF', '#0A0A0A']);
        delete html.dataset.themeMode;
    });

    test('setStyle saves and applies; storage events for the style or a cleared storage count as changes', () => {
        const store = memoryStorage();
        expect(packs.setStyle('cheerful', document, store)).toBe('cheerful');
        expect(store.data.style).toBe('cheerful');
        expect(document.documentElement.dataset.style).toBe('cheerful');
        expect(packs.setStyle('cheerful', document, blockedStorage)).toBe('cheerful');

        expect(packs.isStyleChange({ key: 'style' })).toBe(true);
        expect(packs.isStyleChange({ key: null })).toBe(true);
        expect(packs.isStyleChange({ key: 'theme' })).toBe(false);
    });

    test('content icons get an emoji twin with the same size classes; controls keep their line icon', () => {
        packs.applyStyle('cheerful', document);
        const sun = document.querySelector('#b1 svg');
        const twin = sun.nextElementSibling;
        expect(twin.className).toBe('icon-twin icon-lg mt-0.5');
        expect(twin.textContent).toBe('☀️');
        expect(twin.getAttribute('aria-hidden')).toBe('true');
        expect(sun.classList.contains('icon-swapped')).toBe(true);

        const x = document.querySelector('#b2 svg');
        expect(x.nextElementSibling).toBeNull();
        expect(x.classList.contains('icon-swapped')).toBe(false);
        // Accessible names are unchanged: the twin is aria-hidden.
        expect(document.querySelector('#b1').textContent.trim()).toBe('☀️ Light');
    });

    test('applying the same pack twice keeps one twin per icon', () => {
        packs.applyStyle('cheerful', document);
        packs.applyStyle('cheerful', document);
        expect(document.querySelectorAll('.icon-twin')).toHaveLength(2);
    });

    test('switching back to the default pack removes every twin', () => {
        packs.applyStyle('cheerful', document);
        packs.applyStyle('minimal', document);
        expect(document.querySelectorAll('.icon-twin')).toHaveLength(0);
        expect(document.querySelectorAll('.icon-swapped')).toHaveLength(0);
    });

    test('the observer adds twins to icons rendered later and follows <use href> changes', async () => {
        packs.applyStyle('cheerful', document);
        packs.watchIcons(document, () => packs.getPack(document.documentElement.dataset.style));
        const flush = () => new Promise(r => setTimeout(r, 0));

        const later = document.createElement('div');
        later.innerHTML = `<p>${iconMarkup('flame', 'icon-sm')} 3-day streak</p>`;
        document.body.append(later);
        await flush();
        expect(later.querySelector('.icon-twin').textContent).toBe('🔥');
        expect(later.querySelector('.icon-twin').className).toBe('icon-twin icon-sm');

        document.querySelector('#b1 use').setAttribute('href', '#i-moon');
        await flush();
        expect(document.querySelector('#b1 .icon-twin').textContent).toBe('🌙');

        // innerHTML replacement (how app.js swaps the voice-note icon) gets a fresh twin.
        document.querySelector('#b3').innerHTML = iconMarkup('circle-x');
        await flush();
        expect(document.querySelectorAll('#b3 .icon-twin')).toHaveLength(1);
        expect(document.querySelector('#b3 .icon-twin').textContent).toBe('❌');

        // A pack without emoji adds no twins to icons rendered later.
        packs.applyStyle('minimal', document);
        const plain = document.createElement('div');
        plain.innerHTML = iconMarkup('coins');
        document.body.append(plain);
        await flush();
        expect(plain.querySelector('.icon-twin')).toBeNull();

        // One observer per document.
        expect(packs.watchIcons(document, () => null)).toBe(document.__themeIconObserver);
        document.__themeIconObserver.disconnect();
        delete document.__themeIconObserver;
    });
});

describe('pages load the theme packs before first paint', () => {
    const pages = fs.readdirSync(PUBLIC).filter(f => f.endsWith('.html'));

    test.each(pages)('%s loads themes/packs.js before theme-init.js, both in <head>', (page) => {
        const html = read(page);
        const head = html.slice(0, html.indexOf('</head>'));
        const packsAt = head.search(/<script src="themes\/packs\.js(\?v=\d+)?"><\/script>/);
        const initAt = head.search(/<script src="theme-init\.js(\?v=\d+)?"><\/script>/);
        expect(packsAt).toBeGreaterThan(-1);
        expect(initAt).toBeGreaterThan(packsAt);
    });

    test('the theme menu has a Mode group and a Style group', () => {
        const doc = new DOMParser().parseFromString(read('index.html'), 'text/html');
        expect(doc.querySelectorAll('#theme-dropdown [data-theme]')).toHaveLength(3);
        expect(doc.getElementById('style-items').getAttribute('aria-labelledby')).toBe('theme-style-label');
        expect(doc.getElementById('theme-style-label').textContent).toBe('Style');
    });

    test('the service worker precaches the registry and every pack font, so packs work offline', () => {
        const assets = require('../sw-constants').ASSETS_TO_CACHE;
        expect(assets).toContain('/themes/packs.js');
        packs.PACKS.filter(p => p.id !== packs.DEFAULT_STYLE).forEach((p) => {
            const fonts = [...read(`themes/${p.id}.css`).matchAll(/url\("(fonts\/[^"]+)"\)/g)].map(m => `/${m[1]}`);
            fonts.forEach((f) => {
                expect(fs.existsSync(path.join(PUBLIC, f))).toBe(true);
                expect(assets).toContain(f);
            });
        });
    });

    test('theme-init.js records the chosen mode and sets the browser theme colour for it', () => {
        document.head.innerHTML = `
            <meta name="theme-color" content="#FFFFFF" media="(prefers-color-scheme: light)">
            <meta name="theme-color" content="#0A0A0A" media="(prefers-color-scheme: dark)">`;
        const html = document.documentElement;
        html.dataset.style = 'cheerful';
        window.ThemePacks = packs;
        localStorage.setItem('theme', 'dark');
        new Function(read('theme-init.js'))();
        expect(html.dataset.themeMode).toBe('dark');
        expect(html.classList.contains('dark-mode')).toBe(true);
        const colours = [...document.querySelectorAll('meta[name="theme-color"]')].map(m => m.getAttribute('content'));
        expect(colours).toEqual(['#0F172A', '#0F172A']);
        delete window.ThemePacks;
        localStorage.clear();
        html.classList.remove('dark-mode');
    });
});

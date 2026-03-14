const fs = require('fs');
const path = require('path');
const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

const { JSDOM } = require('jsdom');

describe('Critical DOM Elements', () => {
    let document;

    beforeAll(() => {
        const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
        const dom = new JSDOM(html);
        document = dom.window.document;
    });

    test('Required UI elements exist in the DOM', () => {
        const requiredIds = [
            'hamburger-btn',
            'drawer-container',
            'drawer-overlay',
            'close-drawer',
            'current-plan-badge',
            'pricing-modal',
            'buy-booster-btn',
            'upgrade-standard-btn',
            'upgrade-pro-btn',
            'paywall-modal',
            'notion-setup-fields',
            'history-list',
            'heatmap-grid'
        ];

        requiredIds.forEach(id => {
            const el = document.getElementById(id);
            if (!el) throw new Error(`Missing expected DOM ID: ${id}`);
        });
    });

    test('All drawer navigation items have valid data attributes', () => {
        const drawerItems = document.querySelectorAll('[data-drawer]');
        expect(drawerItems.length).toBeGreaterThan(0);
        
        const validActions = ['upgrade', 'reports', 'history', 'settings', 'export', 'delete', 'logout'];
        drawerItems.forEach(item => {
            expect(validActions).toContain(item.getAttribute('data-drawer'));
        });
    });
});

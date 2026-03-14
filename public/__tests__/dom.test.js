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
            'history-list',
            'heatmap-grid',
            // Notion onboarding
            'view-notion-setup',
            'notion-key-input',
            'notion-db-input',
            'save-notion-btn',
            'skip-notion-btn',
            // Advanced Settings
            'save-setup-btn',
            'adv-notion-status',
        ];

        requiredIds.forEach(id => {
            const el = document.getElementById(id);
            if (!el) throw new Error(`Missing expected DOM ID: ${id}`);
        });
    });

    test('All drawer navigation items have valid data attributes', () => {
        const drawerItems = document.querySelectorAll('[data-drawer]');
        expect(drawerItems.length).toBeGreaterThan(0);
        
        const validActions = ['upgrade', 'reports', 'notion', 'history', 'settings', 'export', 'delete', 'logout'];
        drawerItems.forEach(item => {
            expect(validActions).toContain(item.getAttribute('data-drawer'));
        });
    });

    test('Notion onboarding page does NOT contain BYOK elements', () => {
        const notionView = document.getElementById('view-notion-setup');
        expect(notionView).not.toBeNull();
        // Ensure BYOK elements are NOT inside the Notion onboarding view
        expect(notionView.querySelector('#byok-api-key')).toBeNull();
        expect(notionView.querySelector('#byok-provider')).toBeNull();
        expect(notionView.querySelector('[name="byok-mode"]')).toBeNull();
    });
});

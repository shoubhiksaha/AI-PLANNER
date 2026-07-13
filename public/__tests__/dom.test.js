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
            'upgrade-step-1',
            'upgrade-step-2',
            'upgrade-step-3',
            'upgrade-next-outcome',
            'upgrade-next-plan',
            'checkout-selected-plan-btn',
            'upgrade-standard-pricing-btn',
            'upgrade-pro-btn',
            'history-list',
            'heatmap-grid',
            'build-version',
            // Notion onboarding
            'view-notion-setup',
            'notion-key-input',
            'notion-db-input',
            'save-notion-btn',
            'skip-notion-btn',
            'actionable-error-modal',
            'actionable-error-know-more',
            'actionable-error-close',
            // Advanced Settings
            'save-setup-btn',
            'adv-notion-status',
        ];

        requiredIds.forEach(id => {
            const el = document.getElementById(id);
            if (!el) throw new Error(`Missing expected DOM ID: ${id}`);
        });
    });

    test('Upgrade flow limits the primary comparison to two plans and defaults to annual', () => {
        const planChoices = document.querySelectorAll('[data-upgrade-plan]');
        const annualBilling = document.querySelector('input[name="upgrade-billing"][value="annual"]');

        expect(planChoices).toHaveLength(2);
        expect(annualBilling).not.toBeNull();
        expect(annualBilling.checked).toBe(true);
        expect(document.getElementById('upgrade-step-2').classList.contains('hidden')).toBe(true);
        expect(document.getElementById('upgrade-step-3').classList.contains('hidden')).toBe(true);
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

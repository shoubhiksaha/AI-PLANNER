/**
 * @jest-environment jsdom
 */
const fs = require('fs');
const path = require('path');

describe('Critical DOM Elements', () => {
    let document;

    beforeAll(() => {
        const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
        // Parse with the jsdom environment's DOMParser (no direct jsdom dependency).
        document = new DOMParser().parseFromString(html, 'text/html');
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
            // Audit remediation
            'btn-sync-primary',
            'sync-hint',
            'credit-cost-line',
            'status-area',
            'voice-pro-lock',
            'login-error',
            'notion-db-error',
            'notion-key-error',
            'adv-notion-disconnect',
            'byok-delete-stored',
            'byok-clear-session',
            'payment-result',
            'update-banner',
            'update-reload-btn',
        ];

        requiredIds.forEach(id => {
            const el = document.getElementById(id);
            if (!el) throw new Error(`Missing expected DOM ID: ${id}`);
        });
    });

    test('ADT endorsement links to ADT, with light and dark versions of both lockups', () => {
        const link = document.querySelector('#adt-footer a');
        expect(link.getAttribute('href')).toBe('https://analogdigital.tech');
        expect(link.getAttribute('rel')).toContain('noopener');
        expect(link.getAttribute('aria-label')).toMatch(/An offering by ADT/);
        ['stacked-light', 'stacked-dark', 'inline-light', 'inline-dark'].forEach(v => {
            expect(document.querySelector(`#adt-footer img[src="brand/offering-by-adt-${v}.svg"]`)).not.toBeNull();
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
        
        const validActions = ['upgrade', 'reports', 'notion', 'history', 'name', 'settings', 'export', 'delete', 'logout'];
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

    test('U-02 / UX 15: pinch-zoom allowed and the build tag lives in the drawer', () => {
        const viewport = document.querySelector('meta[name="viewport"]').getAttribute('content');
        expect(viewport).not.toMatch(/user-scalable\s*=\s*no/);
        expect(viewport).not.toMatch(/maximum-scale/);
        expect(document.getElementById('build-version').closest('#drawer-panel')).not.toBeNull();
    });

    test('U-12 / S-07 / S-08: no AOS, no jsdelivr, no eager Cashfree SDK, no hotlinked icons', () => {
        const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
        expect(html).not.toMatch(/unpkg\.com|aos\.js|AOS\.init|data-aos/);
        expect(html).not.toMatch(/cdn\.jsdelivr\.net/);
        expect(html).not.toMatch(/<script[^>]+sdk\.cashfree\.com/);
        expect(html).not.toMatch(/flaticon/);
        expect(html).not.toMatch(/price-tag-wiggle|tagWiggle/);
        // Inline <script> blocks are blocked by the CSP, so none may exist.
        const inlineScripts = Array.from(document.querySelectorAll('script:not([src])'));
        expect(inlineScripts).toHaveLength(0);
    });

    test('UX 13: all three plan durations are visible radios', () => {
        const radios = document.querySelectorAll('input[name="upgrade-billing"]');
        expect(Array.from(radios).map(r => r.value).sort()).toEqual(['annual', 'monthly', 'sprint']);
        radios.forEach(r => expect(r.closest('details')).toBeNull());
    });

    test('U-03 / U-06 / U-08: menu button is labelled; form fields have labels', () => {
        const hamburger = document.getElementById('hamburger-btn');
        expect(hamburger.getAttribute('aria-label')).toBe('Menu');
        expect(hamburger.className).toMatch(/btn-icon/); // 44×44 px target (styles.css .btn-icon)
        ['notion-key-input', 'notion-db-input', 'byok-api-key', 'byok-provider', 'user-display-name-input', 'user-phone']
            .forEach(id => expect(document.querySelector(`label[for="${id}"]`)).not.toBeNull());
        document.querySelectorAll('.theme-item').forEach(item => {
            expect(item.tagName).toBe('BUTTON');
            // Accessible name: visible text (preferred) or an aria-label.
            expect((item.getAttribute('aria-label') || item.textContent).trim()).toBeTruthy();
        });
    });

    test('U-04 / U-05: dialogs and live regions are announced', () => {
        ['pricing-modal', 'guide-modal', 'phone-modal'].forEach(id => {
            const el = document.getElementById(id);
            expect(el.getAttribute('role')).toBe('dialog');
            expect(el.getAttribute('aria-modal')).toBe('true');
        });
        expect(document.getElementById('drawer-panel').getAttribute('role')).toBe('dialog');
        expect(document.getElementById('status-area').getAttribute('aria-live')).toBeTruthy();
        expect(document.getElementById('dash-loader').getAttribute('aria-live')).toBeTruthy();
    });

    test('S-04: BYOK copy describes sessionStorage + per-sync header, not cookies or RAM-only', () => {
        const text = document.getElementById('view-setup').textContent.replace(/\s+/g, ' ');
        expect(text).toMatch(/sessionStorage/);
        expect(text).toMatch(/sent with each sync/);
        expect(text).not.toMatch(/cookie/i);
        expect(text).not.toMatch(/deleted from RAM/i);
    });
});

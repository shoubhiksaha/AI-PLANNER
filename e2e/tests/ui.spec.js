const { test, expect } = require('@playwright/test');

// These checks run against the static app shell without signing in. Anything
// that needs a backend is asserted through client-side behaviour (validation,
// "please sign in" guards) and by verifying which requests were or were not made.
test.describe('Dashboard UI Smoke Checks', () => {
    test.beforeEach(async ({ page, baseURL }) => {
        const targetUrl = baseURL || 'http://localhost:3000';
        await page.goto(`${targetUrl}/index.html`);
        // Wait until app.js has applied the initial (signed-out) auth state, otherwise it
        // can switch back to the login view after we open the dashboard shell.
        await page.waitForFunction(() => document.documentElement.dataset.authReady === 'true');
        await page.evaluate(() => {
            // The menu button and plan chip only show for a signed-in user.
            document.body.dataset.signedIn = 'true';
            window.AppHelpers.switchView('view-dashboard');
        });
        await expect(page.locator('#view-dashboard')).toBeVisible();
    });

    test('Hamburger Menu opens and closes the navigation drawer', async ({ page }) => {
        const drawer = page.locator('#drawer-container');
        await expect(drawer).toHaveClass(/hidden/);

        await page.click('#hamburger-btn');
        await expect(drawer).toHaveClass(/drawer-open/);
        await expect(drawer).not.toHaveClass(/hidden/);
        await expect(page.locator('#hamburger-btn')).toHaveAttribute('aria-expanded', 'true');

        await page.click('#close-drawer');
        await expect(drawer).toHaveClass(/hidden/);
        await expect(page.locator('#hamburger-btn')).toHaveAttribute('aria-expanded', 'false');
    });

    test('Escape closes the drawer (U-04)', async ({ page }) => {
        await page.click('#hamburger-btn');
        await expect(page.locator('#drawer-container')).toHaveClass(/drawer-open/);
        await expect(page.locator('#close-drawer')).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(page.locator('#drawer-container')).toHaveClass(/hidden/);
    });

    test('Touch targets are at least 44×44 (U-08)', async ({ page }) => {
        for (const selector of ['#hamburger-btn', '#current-plan-badge', '#theme-btn', '#btn-morning']) {
            const box = await page.locator(selector).boundingBox();
            expect(box, selector).not.toBeNull();
            // Round: the view's fade-in transform can report 43.99998px mid-animation.
            expect(Math.round(box.width), `${selector} width`).toBeGreaterThanOrEqual(44);
            expect(Math.round(box.height), `${selector} height`).toBeGreaterThanOrEqual(44);
        }
    });

    test('Sync buttons are disabled with a reason until a page is added (UX 3)', async ({ page }) => {
        for (const id of ['#btn-morning', '#btn-night', '#btn-journal']) await expect(page.locator(id)).toBeDisabled();
        await expect(page.locator('#btn-sync-primary')).toHaveCount(0);
        await expect(page.locator('#sync-hint')).toContainText('Add a page photo first');
        await expect(page.locator('#drop-zone')).toContainText('free printable template');
    });

    test('Free Plan badge opens the outcome-first upgrade flow', async ({ page }) => {
        const pricingModal = page.locator('#pricing-modal');
        await expect(pricingModal).toHaveClass(/hidden/);

        await page.click('#current-plan-badge');

        await expect(pricingModal).toHaveClass(/flex/);
        await expect(page.locator('#upgrade-step-1')).toBeVisible();
        await expect(page.locator('#upgrade-next-outcome')).toBeDisabled();

        await page.click('[data-upgrade-outcome="automation"]');
        await page.click('#upgrade-next-outcome');

        await expect(page.locator('#upgrade-step-2')).toBeVisible();
        await expect(page.locator('[data-upgrade-plan]')).toHaveCount(2);
        // UX 13: all three durations are visible, annual preselected
        await expect(page.locator('input[name="upgrade-billing"]')).toHaveCount(3);
        for (const value of ['annual', 'sprint', 'monthly']) {
            await expect(page.locator(`input[name="upgrade-billing"][value="${value}"]`)).toBeVisible();
        }
        await expect(page.locator('input[name="upgrade-billing"][value="annual"]')).toBeChecked();

        await page.click('#upgrade-next-plan');
        await expect(page.locator('#upgrade-step-3')).toBeVisible();
        await expect(page.locator('#checkout-plan-name')).toContainText('Standard · Annual');
        await expect(page.locator('#checkout-selected-plan-btn')).toContainText('₹290');

        await page.keyboard.press('Escape');
        await expect(pricingModal).toHaveClass(/hidden/);
    });

    test('Notion setup validates inline and accepts a pasted Notion URL (UX 10)', async ({ page }) => {
        const setupCalls = [];
        await page.route('**/setupNotion', async (route) => {
            setupCalls.push(route.request().postDataJSON());
            await route.fulfill({ status: 200, contentType: 'application/json', json: { success: true } });
        });

        await page.evaluate(() => window.AppHelpers.switchView('view-notion-setup'));
        await expect(page.locator('#view-notion-setup')).toBeVisible();

        await page.click('#save-notion-btn');
        await expect(page.locator('#notion-key-error')).toBeVisible();
        await expect(page.locator('#notion-db-error')).toBeVisible();

        await page.fill('#notion-db-input', 'https://www.notion.so/ws/Brain-Dump-395c1d2e3f4a5b6c7d8e9f0a1b2c38ab?v=aaaaaaaabbbbbbbbccccccccdddddddd');
        await expect(page.locator('#notion-db-help')).toContainText('Database ID found: 395c');
        await page.fill('#notion-key-input', 'ntn_' + 'x'.repeat(40));
        await page.click('#save-notion-btn');

        await expect(page.locator('#notion-key-error')).toBeHidden();
        // Not signed in: the guard fires before any network call.
        await expect(page.locator('#notion-db-error')).toContainText('sign in');
        expect(setupCalls).toHaveLength(0);
    });

    test('BYOK save validates and never stores the key without a validated session (C1, B-04)', async ({ page }) => {
        const calls = [];
        await page.route(/\/(byokSession|setupBYOK)$/, async (route) => {
            calls.push(route.request().url());
            await route.fulfill({ status: 200, contentType: 'application/json', json: { valid: true } });
        });

        await page.evaluate(() => {
            window.AppHelpers.switchView('view-setup');
            document.getElementById('byok-details').open = true;
        });
        await expect(page.locator('#view-setup')).toBeVisible();

        await page.click('#save-setup-btn');
        await expect(page.locator('#byok-error')).toHaveText('Paste your API key first.');

        await page.fill('#byok-api-key', 'sk-test-key-1234567890');
        await page.click('#save-setup-btn');
        await expect(page.locator('#byok-error')).toContainText('sign in');

        expect(calls).toHaveLength(0);
        const stored = await page.evaluate(() => ({
            session: sessionStorage.getItem('byok_stateless_v2'),
            local: Object.keys(localStorage).filter(k => k.startsWith('byok')),
            cookie: document.cookie,
        }));
        expect(stored.session).toBeNull();
        expect(stored.local).toEqual([]);
        expect(stored.cookie).not.toContain('byok');
        // The key input must never be pre-filled with placeholder text (B-04)
        await expect(page.locator('#byok-api-key')).toHaveAttribute('placeholder', /Paste your API key/);
    });

    test('logClientError is called on unhandled errors', async ({ page }) => {
        await page.route('**/logClientError', async route => {
            await route.fulfill({ status: 200, json: { success: true } });
        });
        const reqPromise = page.waitForRequest(req => req.url().includes('logClientError'));

        await page.evaluate(() => {
            window.dispatchEvent(new ErrorEvent('error', { error: new Error('Fake UI Error'), message: 'Fake UI Error' }));
        });

        const req = await reqPromise;
        expect(req.postDataJSON().message).toBe('Fake UI Error');
    });
});

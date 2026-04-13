const { test, expect } = require('@playwright/test');

test.describe('Dashboard UI Smoke Checks', () => {
    test.beforeEach(async ({ page, baseURL }) => {
        // Mock Firebase Auth and load index.html directly
        const targetUrl = baseURL || 'http://localhost:3000';
        await page.goto(`${targetUrl}/index.html`);
        // Wait for app helpers & basic dom to load
        await page.waitForFunction(() => typeof window.AppHelpers !== 'undefined');
        // Bootstrap a real visible dashboard state for subsequent tests
        await page.evaluate(() => {
            window.AppHelpers.switchView('view-dashboard');
        });
        // Wait for potential animations to clear
        await page.waitForTimeout(300);
        // Explicitly check visibility
        await expect(page.locator('#view-dashboard')).toBeVisible();
    });

    test('Hamburger Menu opens navigation drawer', async ({ page }) => {
        const drawer = page.locator('#drawer-container');
        await expect(drawer).toHaveClass(/hidden/);

        await page.click('#hamburger-btn');
        
        // Wait for the drawer out transition
        await page.waitForTimeout(300);
        await expect(drawer).not.toHaveClass(/hidden/);
        await expect(drawer).toHaveClass(/drawer-open/);

        // Close drawer
        await page.click('#close-drawer');
        await page.waitForTimeout(350);
        await expect(drawer).toHaveClass(/hidden/);
    });

    test('Free Plan badge opens Pricing Modal', async ({ page }) => {
        const pricingModal = page.locator('#pricing-modal');
        await expect(pricingModal).toHaveClass(/hidden/);

        await page.click('#current-plan-badge');

        await expect(pricingModal).not.toHaveClass(/hidden/);
        await expect(pricingModal).toHaveClass(/flex/);

        // Close modal (Click outside or use Escape/close button if one exists, relying on JS for this test)
        // Check that Standard Plan button is present in the modal
        await expect(page.locator('#upgrade-standard-pricing-btn')).toBeVisible();
        await expect(page.locator('#upgrade-pro-btn')).toBeVisible();
    });

    test('Notion Setup save triggers backend and shows success', async ({ page }) => {
        await page.route('**/setupNotion', async route => {
            await route.fulfill({ json: { success: true, text: "Notion setup saved securely." }, status: 200, contentType: 'application/json' });
        });

        // Trigger Notion setup flow (make view visible)
        await page.evaluate(() => {
            window.AppHelpers.switchView('view-notion-setup');
        });
        await page.waitForTimeout(300);
        await expect(page.locator('#view-notion-setup')).toBeVisible();

        await page.fill('#notion-key-input', 'secret_fake_key_123');
        await page.fill('#notion-db-input', 'fake_db_123');
        await page.click('#save-notion-btn');

        await expect(page.locator('#notion-onboard-status')).toContainText('Notion Connected', { timeout: 3000 });
    });

    test('BYOK KMS Save interacts with backend', async ({ page }) => {
        await page.route('**/setupBYOK', async route => {
            await route.fulfill({ json: { success: true, text: "BYOK settings saved securely." }, status: 200, contentType: 'application/json' });
        });

        await page.evaluate(() => {
            window.AppHelpers.switchView('view-setup');
            const detailsEl = document.querySelector('#view-setup details');
            if (detailsEl) detailsEl.open = true;
            document.querySelector('input[name="byok-mode"][value="kms"]').checked = true;
        });
        await page.waitForTimeout(300);
        await expect(page.locator('#view-setup')).toBeVisible();

        await page.fill('#byok-api-key', 'sk-test-key-1234');
        await page.click('#save-setup-btn');

        // Since BYOK setup shows an alert natively or changes the button text, we'll wait for the network mock to be hit
        await page.waitForResponse('**/setupBYOK');
    });

    test('logClientError is called on unhandled errors', async ({ page }) => {
        const reqPromise = page.waitForRequest(req => req.url().includes('logClientError'));
        
        await page.route('**/logClientError', async route => {
            await route.fulfill({ status: 200, json: { success: true } });
        });

        await page.evaluate(() => {
            // Trigger a manual global error
            window.dispatchEvent(new ErrorEvent('error', { error: new Error('Fake UI Error'), message: 'Fake UI Error' }));
        });

        await reqPromise;
    });
});

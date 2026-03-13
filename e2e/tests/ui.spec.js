const { test, expect } = require('@playwright/test');

test.describe('Dashboard UI Smoke Checks', () => {
    test.beforeEach(async ({ page }) => {
        // Mock Firebase Auth and load index.html directly
        await page.goto('http://127.0.0.1:5000/index.html');
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
});

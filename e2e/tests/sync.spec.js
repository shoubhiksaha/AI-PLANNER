const { test, expect } = require('@playwright/test');

test.describe('E2E Sync Flow', () => {

  test('login -> upload -> morning sync -> verify side effects', async ({ page, baseURL }) => {
    const targetUrl = baseURL || 'http://localhost:3000';
    const isCI = !!process.env.CI;
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    // In CI without a Firebase Emulator, run a smoke test only.
    if (isCI) {
        await page.goto(targetUrl);
        await expect(page.locator('#login-btn')).toBeVisible({ timeout: 15000 });
        await expect(page.locator('h1')).toHaveText('AI Planner');
        await expect(page.locator('#view-dashboard')).toBeHidden();
        expect(pageErrors).toEqual([]);
        return;
    }

    // --- FULL E2E FLOW (Local Auth Emulator only) ---
    await page.route('**/updateProfile', route => route.fulfill({ status: 200, contentType: 'application/json', json: { success: true } }));
    await page.route('**/refreshStaleStreak', route => route.fulfill({ status: 200, contentType: 'application/json', json: { success: true } }));
    const syncBodies = [];
    await page.route('**/syncPlanner', async route => {
        syncBodies.push(route.request().postDataJSON());
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            json: { text: 'Planner synced successfully to E2E Mock Backend!', counts: { events: 2, tasks: 3 }, creditsCharged: 1, warnings: [] },
        });
    });

    await page.goto(targetUrl + '/?emulator=true');
    await page.waitForFunction(() => typeof window.e2eLogin === 'function');
    await page.evaluate(() => window.e2eLogin('playwright@aiplanner.local', 'testpassword123'));
    await expect(page.locator('#view-dashboard')).toBeVisible({ timeout: 10000 });

    // Provide a Google access token through the C7 bridge (no OAuth popup in tests).
    await page.evaluate(() => window.mobileUpdateAccessToken('e2e-google-token'));

    const base64Image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    await page.locator('#drop-zone input.upload-input:not([capture])').first().setInputFiles({
        name: 'test-planner.png',
        mimeType: 'image/png',
        buffer: Buffer.from(base64Image, 'base64'),
    });
    await expect(page.locator('#btn-morning')).toBeEnabled();

    const syncResponse = page.waitForResponse('**/syncPlanner');
    await page.click('#btn-morning');
    await syncResponse;

    const card = page.locator('#status-area .status-card');
    await expect(card).toHaveAttribute('data-tone', 'success');
    await expect(card).toContainText('2 events · 3 tasks added');
    await expect(card).toContainText('1 credit used');
    expect(syncBodies).toHaveLength(1);
    expect(syncBodies[0].syncType).toBe('morning');
    expect(syncBodies[0].googleToken).toBe('e2e-google-token');
    expect(syncBodies[0].clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
    // B-16: photos are cleared only after a successful sync
    await expect(page.locator('#btn-sync-primary')).toBeDisabled();
  });

});

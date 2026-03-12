const { test, expect } = require('@playwright/test');

test.describe('E2E Sync Flow', () => {

  test('login -> upload -> morning/night/journal sync -> verify side effects', async ({ page, baseURL }) => {
    // 1. Determine if running against local emulator or production (smoke test)
    const targetUrl = baseURL || 'http://localhost:3000';
    const isLocal = targetUrl.includes('localhost') || targetUrl.includes('127.0.0.1');
    
    // For production smoke tests (triggered by CI), just verify the app loads and prompts login
    if (!isLocal) {
        await page.goto(targetUrl);
        await expect(page.locator('#login-btn')).toBeVisible({ timeout: 15000 });
        console.log("Smoke test passed: Production app loaded successfully.");
        return;
    }

    // --- FULL E2E FLOW (Local/Emulator Only) ---
    // 2. Visit page with emulator flag
    await page.goto(targetUrl + '/?emulator=true');

    // 3. Bypass real Google OAuth and login directly with emulator test endpoint
    await page.evaluate(async () => {
        if (!window.e2eLogin) throw new Error("e2eLogin not exposed. Check emulator flag.");
        await window.e2eLogin('playwright@aiplanner.local', 'testpassword123');
    });

    // 4. Verify Login Side Effect (Dashboard visible)
    await expect(page.locator('#logout-btn')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#btn-morning')).toBeVisible();

    // 5. Intercept the API to validate UI side effects without triggering real backend charges/quota
    // Note: This validates app behavior + API contract, not the Google OAuth flow or Notion backend logic.
    await page.route('**/syncPlanner', async route => {
        const json = { text: "Planner synced successfully to E2E Mock Backend!" };
        await route.fulfill({ json, status: 200, contentType: 'application/json' });
    });

    // 6. Upload an image
    const buffer = Buffer.from('fake-image-data', 'utf-8');
    await page.setInputFiles('#file-upload', {
        name: 'test-planner.jpg',
        mimeType: 'image/jpeg',
        buffer
    });

    // 7. Click specific sync mode
    await page.click('#btn-morning');

    // 8. Verify Side Effects
    // Status area should appear containing the success text
    await expect(page.locator('#status-area')).toContainText('Planner synced successfully to E2E Mock Backend!', { timeout: 15000 });
  });

});

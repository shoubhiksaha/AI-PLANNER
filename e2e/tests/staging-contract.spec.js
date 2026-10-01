const { test, expect } = require('@playwright/test');

test.describe('Live Environment Contract & Smoke Verification', () => {
    const targetUrl = process.env.STAGING_URL || process.env.PRODUCTION_URL || 'https://staging-planner.analogdigital.tech';

    test('1. Hosting rewrite reaches Cloud Functions endpoint without 404', async ({ request }) => {
        // Calling /syncPlanner without auth header should return 401 Unauthorized (proves function rewrite works)
        const response = await request.post(`${targetUrl}/syncPlanner`, {
            data: { syncType: 'morning' },
            headers: {
                'Content-Type': 'application/json'
            },
            ignoreHTTPSErrors: true
        });

        // 401 proves the rewrite reached Cloud Functions and executed authentication validation
        // 404 would mean the hosting rewrite failed or function was not deployed
        expect(response.status()).toBe(401);
    });

    test('2. Client loads runtime environment configuration', async ({ page }) => {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        const envConfig = await page.evaluate(() => window.__ENV_CONFIG__);
        expect(envConfig).toBeDefined();
        expect(typeof envConfig.projectId).toBe('string');
        expect(envConfig.projectId.length).toBeGreaterThan(0);
    });

    test('3. Critical security and caching headers are enforced', async ({ page }) => {
        const response = await page.goto(targetUrl, { waitUntil: 'commit', timeout: 30000 });
        expect(response).not.toBeNull();

        const headers = response.headers();
        expect(headers['x-content-type-options']).toBe('nosniff');
        expect(headers['x-frame-options']).toBe('DENY');
        expect(headers['content-security-policy']).toBeDefined();
    });

    test('4. Core App Shell loads without uncaught JavaScript exceptions', async ({ page }) => {
        const errors = [];
        page.on('pageerror', err => errors.push(err.message));

        await page.goto(targetUrl, { waitUntil: 'load', timeout: 30000 });
        await expect(page.locator('#login-btn')).toBeVisible({ timeout: 15000 });

        // Ensure no fatal missing module / config exceptions occurred
        const fatalErrors = errors.filter(msg => !msg.includes('net::ERR') && !msg.includes('Failed to fetch'));
        expect(fatalErrors).toHaveLength(0);
    });
});

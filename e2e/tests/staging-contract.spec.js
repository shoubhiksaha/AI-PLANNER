const { test, expect } = require('@playwright/test');

// Post-deploy contract checks, run against staging and production by the deploy workflows.
// TARGET_URL / EXPECTED_PROJECT_ID / EXPECTED_ENVIRONMENT pin each run to one environment,
// so a production deploy carrying staging config (or vice versa) fails here.
// Both environments share project ai-planner-project-467800; they differ by database, region and site.
const targetUrl = process.env.TARGET_URL || 'https://ai-planner-staging.web.app';
const expectedProjectId = process.env.EXPECTED_PROJECT_ID || 'ai-planner-project-467800';
const expectedEnvironment = process.env.EXPECTED_ENVIRONMENT || 'staging';
const expectedDatabase = process.env.EXPECTED_DATABASE || 'staging';
const expectedRegion = process.env.EXPECTED_REGION || 'asia-south1';
const functionsBase = `https://${expectedRegion}-${expectedProjectId}.cloudfunctions.net`;

test.describe(`Live environment contract (${expectedEnvironment})`, () => {
    test('1. Hosting rewrite reaches Cloud Functions and rejects unauthenticated calls', async ({ request }) => {
        const response = await request.post(`${targetUrl}/updateProfile`, {
            data: {},
            headers: { 'Content-Type': 'application/json' }
        });
        // 401 AUTH_INVALID proves the rewrite reached the function and ran auth validation.
        // 404 would mean the rewrite or the function is missing.
        expect(response.status()).toBe(401);
        expect((await response.json()).errorCode).toBe('AUTH_INVALID');
    });

    test('2. Direct syncPlanner URL accepts CORS preflight from this environment\'s origin only', async ({ request }) => {
        const allowed = await request.fetch(`${functionsBase}/syncPlanner`, {
            method: 'OPTIONS',
            headers: {
                Origin: targetUrl,
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'content-type,x-byok-token'
            }
        });
        expect(allowed.status()).toBeLessThan(300);
        expect(allowed.headers()['access-control-allow-origin']).toBe(targetUrl);
        expect(allowed.headers()['access-control-allow-credentials']).toBeUndefined();

        const blocked = await request.fetch(`${functionsBase}/syncPlanner`, {
            method: 'OPTIONS',
            headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' }
        });
        expect(blocked.status()).toBe(403);

        // The other environment's site must not be able to call these functions.
        const otherOrigin = expectedEnvironment === 'production' ? 'https://ai-planner-staging.web.app' : 'https://planner.analogdigital.tech';
        const crossEnv = await request.fetch(`${functionsBase}/syncPlanner`, {
            method: 'OPTIONS',
            headers: { Origin: otherOrigin, 'Access-Control-Request-Method': 'POST' }
        });
        expect(crossEnv.status()).toBe(403);
    });

    test('3. Client is configured for this environment and project', async ({ page }) => {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const envConfig = await page.evaluate(() => window.__ENV_CONFIG__);
        expect(envConfig).toBeDefined();
        expect(envConfig.projectId).toBe(expectedProjectId);
        expect(envConfig.environment).toBe(expectedEnvironment);
        expect(envConfig.hostingUrl).toBe(targetUrl);
        expect(envConfig.firestoreDatabaseId).toBe(expectedDatabase);
        expect(envConfig.functionsRegion).toBe(expectedRegion);
        expect(envConfig.appId).toMatch(/^1:\d+:web:[0-9a-f]+$/);
    });

    test('4. Security headers are enforced', async ({ page }) => {
        const response = await page.goto(targetUrl, { waitUntil: 'commit', timeout: 30000 });
        expect(response).not.toBeNull();
        const headers = response.headers();
        expect(headers['x-content-type-options']).toBe('nosniff');
        expect(headers['x-frame-options']).toBe('DENY');
        const csp = headers['content-security-policy'] || '';
        expect(csp).toContain("default-src 'self'");
        expect(csp).not.toContain('cdn.jsdelivr.net');
        expect(headers['permissions-policy'] || '').not.toContain('camera=*');
    });

    test('5. App shell loads without uncaught exceptions or CSP violations', async ({ page }) => {
        const errors = [];
        const cspViolations = [];
        page.on('pageerror', err => errors.push(err.message));
        page.on('console', msg => {
            if (msg.type() === 'error' && /Content Security Policy/i.test(msg.text())) cspViolations.push(msg.text());
        });

        await page.goto(targetUrl, { waitUntil: 'load', timeout: 30000 });
        await expect(page.locator('#login-btn')).toBeVisible({ timeout: 15000 });

        expect(errors.filter(msg => !msg.includes('net::ERR') && !msg.includes('Failed to fetch'))).toHaveLength(0);
        expect(cspViolations).toHaveLength(0);
    });
});

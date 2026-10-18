// Browser quality checks on the real hosted app: accessibility (axe), layout at phone
// width, security headers from firebase.json, and console cleanliness.
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const h = require('./helpers');

// Wait for view fade-ins to finish so axe measures final colours, not mid-animation blends.
async function settle(page) {
    await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running'), null, { timeout: 5000 }).catch(() => {});
}

async function seriousViolations(page) {
    await settle(page);
    const results = await new AxeBuilder({ page }).options({ preload: false }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    return results.violations
        .filter(v => ['serious', 'critical'].includes(v.impact))
        .map(v => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`);
}

async function noHorizontalOverflow(page) {
    return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

test.describe('Browser quality', () => {
    // Accessibility checks run with reduced motion (which the app honours), so axe never
    // measures a view mid-fade on slower CI machines. Motion itself is covered by the other specs.
    test.use({ reducedMotion: 'reduce' });

    test.beforeEach(async ({ request }) => {
        await h.resetEmulators(request);
    });

    test('hosting serves the production security headers', async ({ page }) => {
        const res = await page.goto('/');
        const headers = res.headers();
        expect(headers['x-frame-options']).toBe('DENY');
        expect(headers['x-content-type-options']).toBe('nosniff');
        expect(headers['content-security-policy']).toContain("default-src 'self'");
        expect(headers['permissions-policy']).toContain('camera=(self)');
    });

    test('landing page: accessible, zoomable, no overflow, clean console', async ({ page }) => {
        const problems = h.watchConsole(page);
        await page.goto('/');
        await expect(page.locator('#login-btn')).toBeVisible();
        expect(await page.locator('meta[name="viewport"]').getAttribute('content')).not.toMatch(/user-scalable=no|maximum-scale=1/);
        expect(await seriousViolations(page)).toEqual([]);
        expect(await noHorizontalOverflow(page)).toBe(true);
        expect(problems).toEqual([]);
    });

    test('signed-in views: accessible, no overflow, 44px targets on the dashboard', async ({ page, request }) => {
        const problems = h.watchConsole(page);
        const user = await h.createUser(request, { email: h.uniqueEmail('quality') });
        await h.signIn(page, user);

        expect(await seriousViolations(page)).toEqual([]);
        expect(await noHorizontalOverflow(page)).toBe(true);

        const small = await page.evaluate(() => Array.from(document.querySelectorAll('#view-dashboard button, #view-dashboard label[for], #hamburger-btn'))
            .filter(el => el.offsetParent !== null)
            .map(el => ({ id: el.id || el.textContent.trim().slice(0, 20), r: el.getBoundingClientRect() }))
            .filter(({ r }) => r.width < 43.5 || r.height < 43.5)
            .map(({ id, r }) => `${id}: ${Math.round(r.width)}x${Math.round(r.height)}`));
        expect(small).toEqual([]);

        for (const action of ['history', 'reports', 'settings']) {
            await h.openDrawerItem(page, action);
            expect(await seriousViolations(page), `axe on ${action}`).toEqual([]);
            expect(await noHorizontalOverflow(page), `overflow on ${action}`).toBe(true);
        }

        await h.openDrawerItem(page, 'upgrade');
        await expect(page.locator('#pricing-modal')).toBeVisible();
        expect(await seriousViolations(page), 'axe on pricing').toEqual([]);
        await page.keyboard.press('Escape');
        await expect(page.locator('#pricing-modal')).toBeHidden();

        expect(problems).toEqual([]);
    });

    test('dark theme keeps result cards readable', async ({ page, request }) => {
        const user = await h.createUser(request, { email: h.uniqueEmail('dark') });
        await page.emulateMedia({ colorScheme: 'dark' });
        await h.signIn(page, user);
        // Use the app's own theme picker (a reload would drop the in-memory Google token by design).
        await page.click('#theme-btn');
        await page.click('#theme-dropdown [data-theme="dark"]');
        await expect(page.locator('html')).toHaveClass(/dark-mode/);
        await h.addPhoto(page, 'planner-page.png');
        await page.click('#btn-morning');
        await expect(page.locator('#status-area .status-card')).toHaveAttribute('data-tone', 'success');
        await settle(page);
        const contrastIssues = (await new AxeBuilder({ page }).options({ preload: false }).include('#status-area').withRules(['color-contrast']).analyze()).violations;
        expect(contrastIssues.map(v => v.id)).toEqual([]);
    });
});

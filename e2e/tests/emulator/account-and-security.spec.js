// Account lifecycle, BYOK privacy and auth hardening on the emulator stack.
const { test, expect } = require('@playwright/test');
const h = require('./helpers');

test.describe('Account, BYOK and auth hardening', () => {
    let problems;

    test.beforeEach(async ({ page, request }) => {
        await h.resetEmulators(request);
        problems = h.watchConsole(page);
    });

    test.afterEach(async () => {
        expect(problems, problems.join('\n')).toEqual([]);
    });

    test('unverified email is refused by the backend with a clear message (S-03)', async ({ page, request }) => {
        const user = await h.createUser(request, { email: h.uniqueEmail('unverified'), verified: false });
        await page.goto('/');
        await page.waitForFunction(() => typeof window.e2eLogin === 'function');
        await page.evaluate(([u, p]) => window.e2eLogin(u, p), [user.email, user.password]);
        await expect(page.locator('#view-login')).toBeVisible();
        await expect(page.locator('#login-error')).toContainText(/isn’t verified|not verified|verify/i);
        await expect(page.locator('#view-dashboard')).toBeHidden();
        expect(await h.userDoc(request, user.email)).toBeNull();
    });

    test('BYOK "this tab only": key stays in sessionStorage, sync is not charged, sign-out wipes it', async ({ page, request }) => {
        const user = await h.createUser(request, { email: h.uniqueEmail('byok') });
        await h.signIn(page, user);
        await expect.poll(async () => (await h.userDoc(request, user.email))?.tierCredits).toBe(15);

        await h.openDrawerItem(page, 'settings');
        await expect(page.locator('#view-setup')).toBeVisible();
        await page.locator('#byok-details').evaluate(el => { if (el.tagName === 'DETAILS') el.open = true; });
        await page.selectOption('#byok-provider', { index: 1 });
        await page.fill('#byok-api-key', 'sk-e2eFakeByokKey0123456789abcdefghijklmn');
        await page.click('#save-setup-btn');
        await expect(page.locator('#byok-status')).toContainText(/tab/i);

        const stored = await page.evaluate(() => window.sessionStorage.getItem('byok_stateless_v2'));
        expect(stored).toContain('sk-e2eFakeByokKey');
        expect(await page.evaluate(() => window.localStorage.getItem('byok_stateless_v2'))).toBeNull();
        expect(await page.evaluate(() => document.cookie)).not.toContain('byok');
        const profile = await h.userDoc(request, user.email);
        expect(JSON.stringify(profile)).not.toContain('sk-e2eFakeByokKey'); // never stored server-side

        // Saving returns to the dashboard and states the cost plainly.
        await expect(page.locator('#view-dashboard')).toBeVisible();
        await expect(page.locator('#status-area')).toContainText(/AI key saved/i);
        await expect(page.locator('#credit-cost-line')).toContainText(/no credits used/i);
        await h.addPhoto(page, 'planner-page.png');
        const syncRequest = page.waitForRequest(r => r.url().includes('/syncPlanner') && r.method() === 'POST');
        await page.click('#btn-morning');
        const req = await syncRequest;
        expect(req.headers()['x-byok-token']).toContain('sk-e2eFakeByokKey');
        expect(JSON.stringify(req.postDataJSON())).not.toContain('sk-e2eFakeByokKey'); // header only

        await expect(page.locator('#status-area .status-card')).toHaveAttribute('data-tone', 'success');
        expect((await h.userDoc(request, user.email)).tierCredits).toBe(15); // own key → no credit

        await h.openDrawerItem(page, 'logout');
        await expect(page.locator('#view-login')).toBeVisible();
        expect(await page.evaluate(() => window.sessionStorage.getItem('byok_stateless_v2'))).toBeNull();
    });

    test('sign-out leaves nothing behind for the next user on the same tab (B-15)', async ({ page, request }) => {
        const first = await h.createUser(request, { email: h.uniqueEmail('first') });
        const second = await h.createUser(request, { email: h.uniqueEmail('second') });

        await h.signIn(page, first);
        await h.addPhoto(page, 'planner-page.png');
        await page.click('#btn-morning');
        await expect(page.locator('#status-area .status-card')).toHaveAttribute('data-tone', 'success');
        await h.addPhoto(page, 'planner-page.png'); // pending photo at sign-out

        await h.openDrawerItem(page, 'logout');
        await expect(page.locator('#view-login')).toBeVisible();

        await page.evaluate(([u, p]) => window.e2eLogin(u, p), [second.email, second.password]);
        await expect(page.locator('#view-dashboard')).toBeVisible();
        await expect(page.locator('#btn-morning')).toBeDisabled(); // first user's photo is gone
        await expect(page.locator('#status-area')).not.toContainText(/events/);
        await h.openDrawerItem(page, 'history');
        await expect(page.locator('#history-list')).not.toContainText(/morning/i);
    });

    test('account deletion removes the profile and history', async ({ page, request }) => {
        const user = await h.createUser(request, { email: h.uniqueEmail('delete') });
        await h.signIn(page, user);
        await h.addPhoto(page, 'planner-page.png');
        await page.click('#btn-morning');
        await expect(page.locator('#status-area .status-card')).toHaveAttribute('data-tone', 'success');
        expect(await h.listDocs(request, `users/${encodeURIComponent(user.email)}/syncHistory`)).not.toHaveLength(0);

        // Deliberate friction: two confirmations before anything is deleted.
        const dialogs = [];
        page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
        await h.openDrawerItem(page, 'delete');
        await expect.poll(() => dialogs.length).toBe(2);

        await expect(page.locator('#view-login')).toBeVisible();
        await expect.poll(async () => h.userDoc(request, user.email)).toBeNull();
        expect(await h.listDocs(request, `users/${encodeURIComponent(user.email)}/syncHistory`)).toHaveLength(0);
    });

    test('a free user can attach only one page per Morning sync (plan limit, no surprise charge)', async ({ page, request }) => {
        const user = await h.createUser(request, { email: h.uniqueEmail('limit') });
        await h.signIn(page, user);
        const input = page.locator('#drop-zone input[type="file"]:not([capture])').first();
        await input.setInputFiles([h.fixture('planner-page.png'), h.fixture('planner-page.png')]);
        // The extra page is skipped with a plain explanation and a way to compare plans.
        await expect(page.locator('#status-area')).toContainText(/fits your plan; the rest were skipped/i);
        await expect(page.locator('#status-area')).toContainText(/See plans/i);
        await expect(page.locator('#drop-zone .delete-btn')).toHaveCount(1);
        await expect.poll(async () => (await h.userDoc(request, user.email))?.tierCredits).toBe(15);
    });
});

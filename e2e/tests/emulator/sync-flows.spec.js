// Full-stack sync flows: real browser → Hosting emulator (production CSP + emulator hosts)
// → Functions emulator (real handlers, fake Gemini/Google/Notion) → Firestore/Auth emulators.
const { test, expect } = require('@playwright/test');
const h = require('./helpers');

test.describe('Sync flows on the emulator stack', () => {
    let user;
    let problems;

    test.beforeEach(async ({ page, request }) => {
        await h.resetEmulators(request);
        user = await h.createUser(request, { email: h.uniqueEmail('sync') });
        problems = h.watchConsole(page);
    });

    test.afterEach(async () => {
        expect(problems, problems.join('\n')).toEqual([]);
    });

    test('first run: straight to dashboard, 15 free credits, morning sync creates events and tasks', async ({ page, request }) => {
        await h.signIn(page, user);

        // UX 1 / C6: no name or Notion wall; the profile is created with Free-tier defaults.
        await expect(page.locator('#view-name-prompt')).toBeHidden();
        await expect(page.locator('#view-notion-setup')).toBeHidden();
        await expect.poll(async () => (await h.userDoc(request, user.email))?.tierCredits).toBe(15);
        await expect(page.locator('#credits-badge')).toContainText('15');

        // UX 3: the sync buttons are disabled with a reason until a page is added.
        await expect(page.locator('#btn-morning')).toBeDisabled();
        await expect(page.locator('#sync-hint')).toBeVisible();

        await h.addPhoto(page, 'planner-page.png');
        await expect(page.locator('#btn-morning')).toBeEnabled();
        await page.click('#btn-morning');

        const card = page.locator('#status-area .status-card');
        await expect(card).toHaveAttribute('data-tone', 'success');
        await expect(card).toContainText(/2 events/);
        await expect(card).toContainText(/3 tasks/);
        await expect(card).toContainText(/1 credit used/);

        await expect(page.locator('#credits-badge')).toContainText('14');
        expect((await h.userDoc(request, user.email)).tierCredits).toBe(14);

        const calls = await h.externalCalls(request, user.email);
        expect(h.writes(calls, 'events.insert')).toHaveLength(2);
        expect(h.writes(calls, 'tasks.insert')).toHaveLength(3);

        // The photo is cleared only after a successful sync (B-16).
        await expect(page.locator('#btn-morning')).toBeDisabled();

        // History shows the sync.
        await h.openDrawerItem(page, 'history');
        await expect(page.locator('#view-history')).toBeVisible();
        await expect(page.locator('#history-list')).toContainText(/morning/i);
    });

    test('AI failure: red card, no credit used, photo kept for retry', async ({ page, request }) => {
        await h.signIn(page, user);
        await expect.poll(async () => (await h.userDoc(request, user.email))?.tierCredits).toBe(15);

        await h.addPhoto(page, 'ai-failure-red-pixel.png');
        await page.click('#btn-morning');

        const card = page.locator('#status-area .status-card');
        await expect(card).toHaveAttribute('data-tone', 'error');
        await expect(card).toContainText(/No credit used/i);
        await expect(page.locator('#btn-morning')).toBeEnabled(); // photo still attached
        expect((await h.userDoc(request, user.email)).tierCredits).toBe(15);
        const calls = await h.externalCalls(request, user.email);
        expect(h.writes(calls, 'events.insert')).toHaveLength(0);
        expect(h.writes(calls, 'tasks.insert')).toHaveLength(0);
    });

    test('expired Google connection offers "Reconnect Google" instead of a generic error', async ({ page, request }) => {
        await h.signIn(page, user, { googleToken: 'expired-google-token' });
        await h.addPhoto(page, 'planner-page.png');
        await page.click('#btn-morning');

        await expect(page.locator('#reconnect-google-btn')).toBeVisible();
        await expect(page.locator('#status-area')).toContainText(/reconnect/i);
        await expect(page.locator('#pricing-modal')).toBeHidden(); // never the upsell (C3)
        await expect.poll(async () => (await h.userDoc(request, user.email))?.tierCredits).toBe(15);
    });

    test('HEIC photo is accepted and converted on the server', async ({ page, request }) => {
        await h.signIn(page, user);
        await h.addPhoto(page, 'planner-page.heic');
        await expect(page.locator('#btn-morning')).toBeEnabled();
        await page.click('#btn-morning');

        const card = page.locator('#status-area .status-card');
        await expect(card).toHaveAttribute('data-tone', 'success');
        expect(h.writes(await h.externalCalls(request, user.email), 'events.insert')).toHaveLength(2);
    });

    test('Journal asks for Notion only when needed, then syncs to Notion', async ({ page, request }) => {
        await h.signIn(page, user);
        await h.addPhoto(page, 'planner-page.png');
        await page.click('#btn-journal');
        await expect(page.locator('#view-notion-setup')).toBeVisible();

        await page.fill('#notion-key-input', 'ntn_e2eFakeNotionIntegrationKey0123456789abcdef');
        await page.fill('#notion-db-input', 'https://www.notion.so/myworkspace/Journal-0123456789abcdef0123456789abcdef?v=1');
        await page.click('#save-notion-btn');
        await expect(page.locator('#view-dashboard')).toBeVisible();
        await expect.poll(async () => Boolean((await h.userDoc(request, user.email))?.notionKey)).toBe(true);

        // The page photo survives the detour through Notion setup (Zeigarnik: resume, don't restart).
        await expect(page.locator('#drop-zone .delete-btn')).toHaveCount(1);
        await page.click('#btn-journal');
        const card = page.locator('#status-area .status-card');
        await expect(card).toHaveAttribute('data-tone', 'success');
        const notionCalls = (await h.externalCalls(request, user.email)).filter(c => c.service === 'notion');
        expect(notionCalls.length).toBeGreaterThan(0);
    });
});

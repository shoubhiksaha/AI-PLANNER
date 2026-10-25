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

    test('Style menu switches between Minimalist modern and Cheerful and remembers it', async ({ page }) => {
        const html = page.locator('html');
        await expect(html).toHaveAttribute('data-style', 'minimal');
        await expect(html).toHaveAttribute('data-icons', 'line');

        await page.click('#theme-btn');
        await expect(page.locator('#style-items .theme-item')).toHaveText(['Minimalist modern', 'Cheerful']);
        await expect(page.locator('[data-style-choice="minimal"]')).toHaveAttribute('aria-pressed', 'true');
        await page.click('[data-style-choice="cheerful"]');
        await expect(html).toHaveAttribute('data-style', 'cheerful');
        await expect(page.locator('#theme-dropdown')).not.toHaveClass(/active/);
        await expect(page.locator('#theme-btn')).toBeFocused();

        // Emoji stand in for content icons; controls keep their line icons.
        await expect(page.locator('#btn-morning .icon-twin')).toHaveText('☀️');
        await expect(page.locator('#btn-morning .icon-twin')).toBeVisible();
        await expect(page.locator('#btn-morning svg.icon')).toBeHidden();
        await expect(page.locator('#hamburger-btn svg.icon')).toBeVisible();
        await expect(page.locator('#btn-morning')).toHaveAccessibleName(/^Morning plan/);
        // Same type as Minimalist modern; only colours and icons change.
        expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/^"IBM Plex Sans"/);
        // Cheerful paints ADT's black-on-aqua logo into the app icon's own box.
        await expect(page.locator('.app-bar img.brand-tile')).toBeVisible();
        await expect(page.locator('.app-bar img.brand-tile')).toHaveCSS('background-image', /brand\/adt-profile-stacked-aqua\.svg/);

        // The light/dark mode is separate from the style.
        await page.click('#theme-btn');
        await page.click('#theme-dropdown [data-theme="dark"]');
        await expect(html).toHaveClass(/dark-mode/);
        await expect(html).toHaveAttribute('data-style', 'cheerful');
        // A chosen Dark mode gives the browser bar the pack's dark colour whatever the device says.
        const barColours = () => page.locator('meta[name="theme-color"]').evaluateAll(ms => ms.map(m => m.content));
        expect(await barColours()).toEqual(['#0F172A', '#0F172A']);

        // Remembered across reloads and applied before app.js runs.
        await page.reload();
        await expect(html).toHaveAttribute('data-style', 'cheerful');
        await expect(html).toHaveClass(/dark-mode/);
        expect(await barColours()).toEqual(['#0F172A', '#0F172A']);

        await page.click('#theme-btn');
        await expect(page.locator('[data-style-choice="cheerful"]')).toHaveAttribute('aria-pressed', 'true');
        await page.click('[data-style-choice="minimal"]');
        await expect(html).toHaveAttribute('data-style', 'minimal');
        await expect(page.locator('.icon-twin')).toHaveCount(0);
        expect(await barColours()).toEqual(['#0A0A0A', '#0A0A0A']);
    });

    test('Settings › Appearance offers the theme menu\'s choices and stays in step with it', async ({ page }) => {
        const html = page.locator('html');
        const openSettings = () => page.evaluate(() => window.AppHelpers.switchView('view-setup'));
        const appearance = page.locator('section[aria-labelledby="settings-appearance-title"]');
        const radio = (name) => appearance.getByRole('radio', { name });
        await openSettings();
        await expect(radio('Match device')).toBeChecked();
        await expect(radio(/^Minimalist modern/)).toBeChecked();
        await expect(appearance.getByRole('radio')).toHaveCount(5);

        await radio('Dark').check();
        await expect(html).toHaveClass(/dark-mode/);
        await radio(/^Cheerful/).check();
        await expect(html).toHaveAttribute('data-style', 'cheerful');
        await expect(radio(/^Cheerful/)).toHaveAccessibleName(/The original look/);

        // The theme menu shows the same choices...
        await page.click('#theme-btn');
        await expect(page.locator('#theme-dropdown [data-theme="dark"]')).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('[data-style-choice="cheerful"]')).toHaveAttribute('aria-pressed', 'true');
        // ...and a pick there updates Settings.
        await page.click('#theme-dropdown [data-theme="light"]');
        await page.click('#theme-btn');
        await page.click('[data-style-choice="minimal"]');
        await expect(html).not.toHaveClass(/dark-mode/);
        await expect(radio('Light')).toBeChecked();
        await expect(radio(/^Minimalist modern/)).toBeChecked();

        // Remembered after a reload.
        await radio(/^Cheerful/).check();
        await page.reload();
        await page.waitForFunction(() => document.documentElement.dataset.authReady === 'true');
        await openSettings();
        await expect(html).toHaveAttribute('data-style', 'cheerful');
        await expect(radio('Light')).toBeChecked();
        await expect(radio(/^Cheerful/)).toBeChecked();
    });

    // Styles change colours, icons and decoration only: every box and every line of text keeps
    // its position, size and type in every pack (docs/THEMES.md, "Same sizes in every pack").
    test('Cheerful keeps every box and every line of text the same as Minimalist modern', async ({ page, baseURL }) => {
        test.setTimeout(90000);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const setStyle = async (id) => {
            await page.evaluate((s) => window.ThemePacks.setStyle(s, document), id);
            // Let fonts and the icon swap settle, then jump any fade-in, slide-in or colour
            // transition to its end (Firefox never ticks the ones that are offscreen).
            await page.evaluate(async () => {
                await document.fonts.ready;
                await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                document.getAnimations()
                    .filter(a => a.effect?.getComputedTiming().endTime !== Infinity)
                    .forEach(a => a.finish());
            });
        };
        // One row per visible element: its box, and its type unless it is an icon. An emoji
        // twin stands in for its line icon, so the icon's row measures whichever is showing.
        const measure = () => page.evaluate(() => {
            const els = [...document.querySelectorAll('body *')]
                .filter(el => !el.matches('.icon-twin, .icon-sprite, .icon-sprite *, svg.icon *'));
            return els.flatMap((el, i) => {
                const twin = el.nextElementSibling;
                const shown = el.matches('svg.icon') && twin?.matches('.icon-twin') && getComputedStyle(el).display === 'none' ? twin : el;
                const r = shown.getBoundingClientRect();
                if (!r.width && !r.height) return [];
                const cs = getComputedStyle(el);
                const box = [r.x, r.y, r.width, r.height].map(v => Math.round(v)).join(',');
                const type = el.matches('svg.icon') ? '' : ` ${cs.fontFamily} ${cs.fontSize}/${cs.lineHeight} ${cs.fontWeight} ${cs.letterSpacing}`;
                return [`${i} ${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} ${box}${type}`];
            });
        });
        const sameInBothStyles = async (where) => {
            await setStyle('minimal');
            const minimal = await measure();
            await setStyle('cheerful');
            const cheerful = await measure();
            await setStyle('minimal');
            expect(cheerful, `${where}: Cheerful moved or resized something`).toEqual(minimal);
        };
        const show = (view, signedIn) => page.evaluate(([v, s]) => {
            document.body.dataset.signedIn = s;
            window.AppHelpers.switchView(v);
        }, [view, signedIn]);

        for (const [width, height] of [[390, 844], [1280, 800]]) {
            await page.setViewportSize({ width, height });
            for (const dark of [false, true]) {
                await page.evaluate((d) => document.documentElement.classList.toggle('dark-mode', d), dark);
                const where = `${width}px ${dark ? 'dark' : 'light'}`;
                await show('view-login', 'false');
                await sameInBothStyles(`${where} sign-in`);
                await show('view-dashboard', 'true');
                await sameInBothStyles(`${where} dashboard`);
                await show('view-setup', 'true');
                await sameInBothStyles(`${where} settings`);
                await show('view-dashboard', 'true');
                await page.click('#hamburger-btn');
                await sameInBothStyles(`${where} drawer`);
                await page.keyboard.press('Escape');
                await page.click('#current-plan-badge');
                await sameInBothStyles(`${where} plans`);
                await page.keyboard.press('Escape');
            }
        }
        // The policy, template and gear pages too.
        for (const doc of ['privacy.html', 'pricing-policy.html', 'refund-policy.html', 'planner.html', 'gear.html']) {
            await page.goto(`${baseURL || 'http://localhost:3000'}/${doc}`);
            for (const [width, height] of [[390, 844], [1280, 800]]) {
                await page.setViewportSize({ width, height });
                await sameInBothStyles(`${width}px ${doc}`);
            }
        }
    });

    test('Theme menu closes with Escape (from the button or the menu) and when Tab leaves it', async ({ page }) => {
        const menu = page.locator('#theme-dropdown');
        await page.click('#theme-btn');
        await expect(menu).toHaveClass(/active/);
        await page.keyboard.press('Escape');
        await expect(menu).not.toHaveClass(/active/);
        await expect(page.locator('#theme-btn')).toBeFocused();

        await page.click('#theme-btn');
        await page.locator('[data-style-choice="minimal"]').focus();
        await page.keyboard.press('Escape');
        await expect(menu).not.toHaveClass(/active/);
        await expect(page.locator('#theme-btn')).toBeFocused();

        await page.click('#theme-btn');
        await page.locator('[data-style-choice="cheerful"]').focus();
        await page.keyboard.press('Tab');
        await expect(menu).not.toHaveClass(/active/);
        await expect(page.locator('#theme-btn')).toHaveAttribute('aria-expanded', 'false');
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

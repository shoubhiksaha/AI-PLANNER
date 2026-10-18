// Shared helpers for the emulator end-to-end suite (project demo-ai-planner).
const path = require('path');
const { expect } = require('@playwright/test');

const PROJECT = 'demo-ai-planner';
const AUTH = `http://127.0.0.1:9099`;
const FIRESTORE = `http://127.0.0.1:8080`;
const OWNER = { Authorization: 'Bearer owner' }; // emulator admin bypass
const FIXTURES = path.join(__dirname, '..', '..', 'fixtures');
const fixture = (name) => path.join(FIXTURES, name);

let counter = 0;
const uniqueEmail = (tag) => `e2e-${tag}-${Date.now()}-${++counter}@aiplanner.test`;

async function resetEmulators(request) {
    await request.delete(`${FIRESTORE}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`);
    await request.delete(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`);
}

/** Create an Auth emulator user. Production requires a verified email (S-03). */
async function createUser(request, { email, password = 'e2e-password-123', verified = true }) {
    const res = await request.post(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`, {
        headers: OWNER,
        data: { email, password, emailVerified: verified, displayName: 'E2E Tester' },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    return { email, password };
}

/** Collects page errors and CSP violations so every test can assert a clean console. */
function watchConsole(page) {
    const problems = [];
    page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
        const text = msg.text();
        if (msg.type() === 'error' && /Content Security Policy|Refused to (load|connect|execute|frame)/i.test(text)) {
            problems.push(`csp: ${text}`);
        }
    });
    return problems;
}

/** Sign in through the app's emulator-only e2eLogin hook and wait for the dashboard. */
async function signIn(page, user, { googleToken = 'e2e-google-token' } = {}) {
    await page.goto('/');
    await page.waitForFunction(() => typeof window.e2eLogin === 'function');
    await page.evaluate(([u, p, t]) => window.e2eLogin(u, p, t), [user.email, user.password, googleToken]);
    await expect(page.locator('#view-dashboard')).toBeVisible();
}

async function addPhoto(page, file) {
    await page.locator('#drop-zone input[type="file"]:not([capture])').first().setInputFiles(fixture(file));
}

function decodeFields(fields = {}) {
    const out = {};
    for (const [k, v] of Object.entries(fields)) {
        if ('stringValue' in v) out[k] = v.stringValue;
        else if ('integerValue' in v) out[k] = Number(v.integerValue);
        else if ('doubleValue' in v) out[k] = v.doubleValue;
        else if ('booleanValue' in v) out[k] = v.booleanValue;
        else if ('nullValue' in v) out[k] = null;
        else if ('timestampValue' in v) out[k] = v.timestampValue;
        else if ('mapValue' in v) out[k] = decodeFields(v.mapValue.fields);
        else if ('arrayValue' in v) out[k] = (v.arrayValue.values || []).map(x => decodeFields({ x }).x);
        else out[k] = v;
    }
    return out;
}

async function getDoc(request, docPath) {
    const res = await request.get(`${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents/${docPath}`, { headers: OWNER });
    if (res.status() === 404) return null;
    expect(res.ok(), await res.text()).toBeTruthy();
    return decodeFields((await res.json()).fields);
}

async function listDocs(request, collectionPath) {
    const res = await request.get(`${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents/${collectionPath}?pageSize=300`, { headers: OWNER });
    if (res.status() === 404) return [];
    expect(res.ok(), await res.text()).toBeTruthy();
    return ((await res.json()).documents || []).map(d => ({ id: d.name.split('/').pop(), ...decodeFields(d.fields) }));
}

/** Calls the backend's fake Google/Notion clients recorded for this user (C10). */
const writes = (calls, method) => calls.filter(c => c.method === method);
async function externalCalls(request, email) {
    return (await listDocs(request, '__e2eCalls')).filter(c => c.email === email);
}

const userDoc = (request, email) => getDoc(request, `users/${encodeURIComponent(email)}`);

async function openDrawerItem(page, action) {
    // The hamburger lives on the dashboard; return there from sub-views first.
    if (!(await page.locator('#hamburger-btn').isVisible())) {
        for (const back of ['#back-to-dash-btn', '#back-to-dash-btn-reports', '#back-to-dash-from-adv', '#back-to-dash-from-setup']) {
            const btn = page.locator(back);
            if (await btn.isVisible()) { await btn.click(); break; }
        }
        await expect(page.locator('#hamburger-btn')).toBeVisible();
    }
    await page.click('#hamburger-btn');
    await page.click(`[data-drawer="${action}"]`);
}

module.exports = {
    PROJECT, fixture, uniqueEmail, resetEmulators, createUser, watchConsole, signIn, addPhoto,
    getDoc, listDocs, externalCalls, writes, userDoc, openDrawerItem,
};

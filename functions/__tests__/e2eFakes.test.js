/**
 * C10: emulator end-to-end mode. The fakes are used only when BOTH
 * FUNCTIONS_EMULATOR=true and E2E_FAKE_EXTERNALS=true; then a full sync runs
 * with no network I/O and every external call lands in `__e2eCalls`.
 * Firestore is the in-memory fake from helpers/.
 */
const { createFakeFirestore } = require('./helpers/fakeFirestore');

jest.mock('mock-firebase-admin-backing', () => {
    const { FieldValue, FieldPath } = require('./helpers/fakeFirestore');
    return {
        initializeApp: jest.fn(),
        firestore: Object.assign(jest.fn(() => global.__fakeDb), { FieldValue, FieldPath }),
        auth: jest.fn(() => ({ verifyIdToken: global.__verifyIdToken })),
        appCheck: jest.fn(() => ({ verifyToken: jest.fn() })),
    };
}, { virtual: true });
jest.mock('firebase-admin/app', () => require('./helpers/adminMock').app());
jest.mock('firebase-admin/firestore', () => require('./helpers/adminMock').firestore());
jest.mock('firebase-admin/auth', () => require('./helpers/adminMock').auth());
jest.mock('firebase-admin/app-check', () => require('./helpers/adminMock').appCheck());
jest.mock('firebase-functions/v2/https', () => ({ onRequest: (_opts, handler) => handler }));
jest.mock('firebase-functions/params', () => ({
    defineString: (name) => ({ value: () => (global.__params[name] ?? '') }),
    defineSecret: (name) => ({ value: () => (global.__params[name] ?? '') }),
}));
// Real clients are replaced by sentinels so a fake-mode test fails loudly if one is touched.
jest.mock('googleapis', () => ({ google: { __real: 'googleapis' } }));
jest.mock('@notionhq/client', () => ({ Client: jest.fn(function RealNotionClient() { this.__real = 'notion'; }) }));
jest.mock('notion-multipart-uploader', () => ({ uploadToNotion: jest.fn(async () => { throw new Error('real Notion upload used'); }) }));
jest.mock('@google-cloud/kms', () => ({
    KeyManagementServiceClient: jest.fn(() => ({
        encrypt: jest.fn(async () => { throw new Error('real KMS used'); }),
        decrypt: jest.fn(async () => { throw new Error('real KMS used'); }),
    })),
}));

const {
    isFakeExternalsEnabled,
    getE2EFakes,
    RED_PIXEL_PNG_BASE64,
    E2E_GOOGLE_TOKEN,
    aiFixture,
} = require('../testing/e2eFakes');

const EMAIL = 'e2e@example.com';
const JPEG = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64');
const RED_PNG = `data:image/png;base64,${RED_PIXEL_PNG_BASE64}`;
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const ORIGINAL_ENV = { ...process.env };

function setEnv({ emulator, fake }) {
    delete process.env.FUNCTIONS_EMULATOR;
    delete process.env.E2E_FAKE_EXTERNALS;
    if (emulator !== undefined) process.env.FUNCTIONS_EMULATOR = emulator;
    if (fake !== undefined) process.env.E2E_FAKE_EXTERNALS = fake;
}

function makeReq(body, headers = {}) {
    return {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        get(name) { return this.headers[String(name).toLowerCase()]; },
        body: { idToken: 'firebase-id-token', ...body },
    };
}

function makeRes() {
    return { status: jest.fn().mockReturnThis(), send: jest.fn(), set: jest.fn() };
}

beforeEach(() => {
    global.__fakeDb = createFakeFirestore();
    global.__params = { NOTION_ENCRYPTION_KEY_V2: 'e2e-notion-secret', REQUIRE_APP_CHECK: 'false', ALLOW_CUSTOM_BYOK_URLS: 'false' };
    global.__verifyIdToken = jest.fn(async () => ({ email: EMAIL, email_verified: true, uid: 'u-e2e', auth_time: Math.floor(Date.now() / 1000) }));
    global.fetch = jest.fn(async () => { throw new Error('network access in a test'); });
});

afterAll(() => {
    process.env = ORIGINAL_ENV;
});

describe('fake-externals gate (double env)', () => {
    test.each([
        [{}, false],
        [{ FUNCTIONS_EMULATOR: 'true' }, false],
        [{ E2E_FAKE_EXTERNALS: 'true' }, false],
        [{ FUNCTIONS_EMULATOR: 'false', E2E_FAKE_EXTERNALS: 'true' }, false],
        [{ FUNCTIONS_EMULATOR: 'true', E2E_FAKE_EXTERNALS: '1' }, false],
        [{ FUNCTIONS_EMULATOR: 'true', E2E_FAKE_EXTERNALS: 'true' }, true],
    ])('env %j → %s', (env, expected) => {
        expect(isFakeExternalsEnabled(env)).toBe(expected);
        expect(getE2EFakes(env) !== null).toBe(expected);
    });

    test('OFF when only E2E_FAKE_EXTERNALS=true (FUNCTIONS_EMULATOR unset): real clients are used', () => {
        setEnv({ fake: 'true' });
        const { getGoogleApis } = require('../sync/google');
        const { createNotionClient } = require('../services/notion');
        expect(getGoogleApis()).toEqual({ __real: 'googleapis' });
        expect(createNotionClient('ntn_x').__real).toBe('notion');
    });

    test('OFF when only FUNCTIONS_EMULATOR=true: real clients are used', () => {
        setEnv({ emulator: 'true' });
        const { getGoogleApis } = require('../sync/google');
        const { createNotionClient } = require('../services/notion');
        expect(getGoogleApis()).toEqual({ __real: 'googleapis' });
        expect(createNotionClient('ntn_x').__real).toBe('notion');
    });

    test('OFF: the AI step goes to the real provider path (and its network), not the fixtures', async () => {
        setEnv({ fake: 'true' });
        global.__params.GEMINI_API_KEY = 'real-key';
        const { getPlannerDataFromImages } = require('../services/gemini');
        await expect(getPlannerDataFromImages([{ mimeType: 'image/jpeg', base64Data: 'AA==' }], 'morning', null, { deadline: Date.now() + 6000 }))
            .rejects.toThrow();
        expect(global.fetch).toHaveBeenCalled();
    });
});

describe('fake mode ON (FUNCTIONS_EMULATOR=true + E2E_FAKE_EXTERNALS=true)', () => {
    let fns;
    beforeAll(() => {
        setEnv({ emulator: 'true', fake: 'true' });
        fns = require('../index');
    });

    const calls = () => [...global.__fakeDb._store.entries()]
        .filter(([path]) => path.startsWith('__e2eCalls/'))
        .map(([, doc]) => doc);
    const user = () => global.__fakeDb._read(`users/${EMAIL}`);
    const seedUser = (extra = {}) => global.__fakeDb._seed(`users/${EMAIL}`, {
        tier: 'pro', tierCredits: 10, boosterCredits: 0, lastTierCreditRenewalAt: today(), timeZone: 'Asia/Kolkata', ...extra,
    });

    test('morning: userinfo accepts the e2e token, fixtures sync 2 events + 3 tasks, every call is logged', async () => {
        seedUser();
        const res = makeRes();
        await fns.syncPlanner(makeReq({ syncType: 'morning', googleToken: E2E_GOOGLE_TOKEN, images: [JPEG] }), res);

        expect(res.status).toHaveBeenCalledWith(200);
        const body = res.send.mock.calls[0][0];
        expect(body).toEqual(expect.objectContaining({ counts: { events: 2, reminders: 0, tasks: 3 }, creditsCharged: 1, warnings: [] }));
        expect(global.fetch).not.toHaveBeenCalled();

        const log = calls();
        expect(log.every(c => c.email === EMAIL && c.at instanceof Date && typeof c.summary === 'string')).toBe(true);
        const methods = log.map(c => `${c.service}.${c.method}`);
        expect(methods).toEqual(expect.arrayContaining(['oauth2.userinfo.get', 'ai.generateContent', 'calendar.events.insert', 'tasks.tasks.insert']));
        expect(log.filter(c => c.method === 'events.insert').map(c => c.summary)).toEqual(['E2E Standup', 'E2E Design review']);
        expect(log.filter(c => c.method === 'tasks.insert')).toHaveLength(3);
    });

    test('any other Google token → 401 GOOGLE_TOKEN_EXPIRED and nothing is charged', async () => {
        seedUser();
        const res = makeRes();
        await fns.syncPlanner(makeReq({ syncType: 'morning', googleToken: 'stale-token', images: [JPEG] }), res);
        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'GOOGLE_TOKEN_EXPIRED', creditRefunded: false }));
        expect(user().tierCredits).toBe(10);
    });

    test('red-pixel first image → server-side AI failure: 502, credit refunded, history failed', async () => {
        seedUser();
        const res = makeRes();
        const clientRequestId = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
        await fns.syncPlanner(makeReq({ syncType: 'morning', googleToken: E2E_GOOGLE_TOKEN, images: [RED_PNG], clientRequestId }), res);
        expect(res.status).toHaveBeenCalledWith(502);
        expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'AI_UNAVAILABLE', creditRefunded: true }));
        expect(user().tierCredits).toBe(10);
        expect(global.__fakeDb._read(`users/${EMAIL}/syncHistory/${clientRequestId}`)).toEqual(expect.objectContaining({
            status: 'failed', refunded: true, creditsDeducted: { tier: 1, booster: 0 }
        }));
    });

    test('evening: 1 completed task, 1 expense, 1 health entry', async () => {
        seedUser();
        const res = makeRes();
        await fns.syncPlanner(makeReq({ syncType: 'evening', googleToken: E2E_GOOGLE_TOKEN, images: [JPEG] }), res);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.send.mock.calls[0][0].counts).toEqual({ completedTasks: 1, expenses: 1, health: 1 });
        expect(user().spreadsheetId).toMatch(/^sheet-/);
        expect(calls().map(c => c.method)).toEqual(expect.arrayContaining(['spreadsheets.create', 'values.append', 'tasks.patch']));
    });

    test('setupNotion stores a v3 key via the fake validator; journal (2 paragraphs) and voice note (1) reach the fake Notion', async () => {
        seedUser();
        const setupRes = makeRes();
        await fns.setupNotion(makeReq({ notionKey: 'ntn_e2e_fake_token_1234567890', notionDbId: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6' }), setupRes);
        expect(setupRes.status).toHaveBeenCalledWith(200);
        expect(user().notionKey).toMatch(/^v3:/);

        const journalRes = makeRes();
        await fns.syncPlanner(makeReq({ syncType: 'journal', images: [JPEG] }), journalRes);
        expect(journalRes.status).toHaveBeenCalledWith(200);
        expect(journalRes.send.mock.calls[0][0].warnings).toEqual([]);

        const voiceRes = makeRes();
        await fns.syncPlanner(makeReq({ syncType: 'voice_note', images: ['data:audio/webm;base64,' + Buffer.from('fake-audio').toString('base64')] }), voiceRes);
        expect(voiceRes.status).toHaveBeenCalledWith(200);

        const pages = calls().filter(c => c.method === 'pages.create').map(c => c.summary);
        expect(pages).toEqual([
            expect.stringMatching(/^Journal - .* \(2 paragraphs\)$/),
            expect.stringMatching(/^Voice Note - .* \(1 paragraph\)$/),
        ]);
        expect(calls().filter(c => c.method === 'fileUploads.send')).toHaveLength(2);
        expect(calls().every(c => c.email === EMAIL)).toBe(true);
    });

    test('setupBYOK wraps with the fake KMS and the stored key is used for the next sync (no credit)', async () => {
        seedUser({ tierCredits: 0 });
        const setupRes = makeRes();
        await fns.setupBYOK(makeReq({ apiKey: 'sk-e2e-byok-key-1234567890', provider: 'openai', modelName: 'gpt-4o' }), setupRes);
        expect(setupRes.status).toHaveBeenCalledWith(200);
        expect(user().byokKmsData).toEqual(expect.objectContaining({ version: 3, provider: 'openai' }));

        const res = makeRes();
        await fns.syncPlanner(makeReq({ syncType: 'morning', googleToken: E2E_GOOGLE_TOKEN, images: [JPEG] }), res);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.send.mock.calls[0][0].creditsCharged).toBe(0);
        expect(calls().map(c => `${c.service}.${c.method}`)).toEqual(expect.arrayContaining(['kms.encrypt', 'kms.decrypt']));
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('fixtures have the documented shapes', () => {
        const morning = aiFixture('morning', '2026-01-01');
        expect(morning.schedule.filter(s => s.block)).toHaveLength(2);
        expect(morning.todos).toHaveLength(3);
        expect(morning.totals).toEqual({ blocks: 2, reminders: 0, todos: 3 });
        expect(aiFixture('journal_transcribe', 'd').transcription.split('\n')).toHaveLength(2);
        expect(aiFixture('voice_note', 'd').transcription.split('\n')).toHaveLength(1);
        expect(aiFixture('unknown', 'd')).toEqual({});
    });
});

// 1. Mock Firebase Admin
const mockSet = jest.fn();
const mockGet = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();
const mockAdd = jest.fn();
// syncHistory/{id} documents (idempotency records)
const mockHistorySet = jest.fn();
const mockHistoryGet = jest.fn().mockResolvedValue({ exists: false });
const mockHistoryDoc = jest.fn(() => ({ set: mockHistorySet, get: mockHistoryGet }));
const mockCollectionInner = jest.fn(() => ({
    add: mockAdd,
    doc: mockHistoryDoc,
    get: jest.fn().mockResolvedValue({ docs: [], forEach: jest.fn() }),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
}));
const mockBatch = {
    delete: jest.fn(),
    update: jest.fn(),
    commit: jest.fn().mockResolvedValue(undefined)
};
const mockDoc = jest.fn(() => ({
    set: mockSet,
    get: mockGet,
    update: mockUpdate,
    delete: mockDelete,
    collection: mockCollectionInner
}));

// Rate limit collection always returns { exists: false } (first request = allowed)
const mockRateLimitSet = jest.fn();
const mockRateLimitGet = jest.fn().mockResolvedValue({ exists: false });
const mockRateLimitDoc = jest.fn(() => ({
    set: mockRateLimitSet,
    get: mockRateLimitGet,
}));

const mockCollection = jest.fn((name) => {
    if (name === 'rateLimits') return {
        doc: mockRateLimitDoc,
        where: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({ empty: true, docs: [], forEach: jest.fn() })
    };
    return {
        doc: mockDoc,
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        startAfter: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({ empty: true, docs: [], forEach: jest.fn() })
    };
});

const mockVerifyIdToken = jest.fn();
const mockVerifyAppCheckToken = jest.fn();
const verifiedUser = (extra = {}) => ({
    email: 'test@example.com',
    email_verified: true,
    uid: '123',
    auth_time: Math.floor(Date.now() / 1000),
    ...extra
});

jest.mock('mock-firebase-admin-backing', () => {
    const FieldValue = {
        serverTimestamp: jest.fn(() => 'mockTimestamp'),
        increment: jest.fn((n) => `mockIncrement(${n})`),
        delete: jest.fn(() => 'mockDelete'),
        arrayUnion: jest.fn((v) => `mockArrayUnion(${v})`)
    };

    // Firestore-like transaction: writes are buffered and only applied on commit.
    // Setting global.__txConflicts = N makes the next N commits that write a user
    // document "lose" to a concurrent writer, so the callback is re-run (as
    // Firestore does on contention) and the buffered writes are discarded.
    const mockTransactionGet = jest.fn(async (ref) => ref.get());
    const mockRunTransaction = jest.fn(async (callback) => {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const writes = [];
            let writesUserDoc = false;
            const t = {
                get: mockTransactionGet,
                set: (ref, data, opts) => {
                    if (ref.set === mockSet) writesUserDoc = true;
                    writes.push(() => ref.set(data, opts));
                },
                update: (ref, data) => { writes.push(() => ref.update(data)); }
            };
            const result = await callback(t);
            if (writesUserDoc && global.__txConflicts > 0) {
                global.__txConflicts -= 1;
                continue;
            }
            for (const write of writes) await write();
            return result;
        }
    });

    return {
        initializeApp: jest.fn(),
        firestore: Object.assign(jest.fn(() => ({
            collection: mockCollection,
            runTransaction: mockRunTransaction,
            batch: jest.fn(() => mockBatch),
            FieldPath: { documentId: jest.fn(() => '_id') }
        })), { FieldValue, FieldPath: { documentId: jest.fn(() => '_id') } }),
        auth: jest.fn(() => ({
            verifyIdToken: mockVerifyIdToken,
            deleteUser: jest.fn().mockResolvedValue(undefined)
        })),
        appCheck: jest.fn(() => ({ verifyToken: mockVerifyAppCheckToken }))
    };
}, { virtual: true });
jest.mock('firebase-admin/app', () => require('./helpers/adminMock').app());
jest.mock('firebase-admin/firestore', () => require('./helpers/adminMock').firestore());
jest.mock('firebase-admin/auth', () => require('./helpers/adminMock').auth());
jest.mock('firebase-admin/app-check', () => require('./helpers/adminMock').appCheck());

// 2. Mock Firebase Functions
jest.mock('firebase-functions/v2/https', () => ({
    // Return the handler itself so we can call myFunctions.setupNotion(req, res) directly
    onRequest: jest.fn((options, handler) => handler)
}));

// Per-test parameter overrides via global.__params (e.g. REQUIRE_APP_CHECK=true).
jest.mock('firebase-functions/params', () => ({
    defineString: jest.fn((name) => ({ value: () => (global.__params && global.__params[name] !== undefined ? global.__params[name] : 'test-string') })),
    defineSecret: jest.fn((name) => ({ value: () => (global.__params && global.__params[name] !== undefined ? global.__params[name] : 'test-encryption-key-for-jest') }))
}));

// 3. Mock Google APIs
const mockGetUserInfo = jest.fn();
const mockCalendarInsert = jest.fn();
const mockCalendarList = jest.fn().mockResolvedValue({ data: { items: [] } });
const mockTasksInsert = jest.fn();
const mockTasksList = jest.fn();
const mockTasksPatch = jest.fn();
const mockSheetsCreate = jest.fn();
const mockSheetsUpdate = jest.fn();
const mockSheetsAppend = jest.fn();
const mockSheetsBatchUpdate = jest.fn();
const mockSheetsGet = jest.fn().mockResolvedValue({ data: { values: [] } });
// Google Drive (notes destination): an empty Drive where every create gets a fresh id.
const mockDriveList = jest.fn().mockResolvedValue({ data: { files: [] } });
const mockDriveGet = jest.fn().mockResolvedValue({ data: { id: 'cached', trashed: false } });
let mockDriveIdCounter = 0;
const mockDriveCreate = jest.fn(async () => {
    const id = `drive-${++mockDriveIdCounter}`;
    return { data: { id, webViewLink: `https://drive.google.com/file/d/${id}/view` } };
});
const mockDriveUpdate = jest.fn().mockResolvedValue({ data: {} });

jest.mock('googleapis', () => ({
    google: {
        auth: { OAuth2: jest.fn(() => ({ setCredentials: jest.fn() })) },
        oauth2: jest.fn(() => ({ userinfo: { get: mockGetUserInfo } })),
        calendar: jest.fn(() => ({ events: { insert: mockCalendarInsert, list: mockCalendarList } })),
        tasks: jest.fn(() => ({
            tasks: { insert: mockTasksInsert, list: mockTasksList, patch: mockTasksPatch }
        })),
        sheets: jest.fn(() => ({
            spreadsheets: {
                create: mockSheetsCreate,
                batchUpdate: mockSheetsBatchUpdate,
                values: { update: mockSheetsUpdate, append: mockSheetsAppend, get: mockSheetsGet }
            }
        })),
        drive: jest.fn(() => ({ files: { list: mockDriveList, get: mockDriveGet, create: mockDriveCreate, update: mockDriveUpdate } }))
    },
    // Export mocks to modify in tests
    _mockGetUserInfo: mockGetUserInfo,
    _mockTasksList: mockTasksList,
    _mockSheetsCreate: mockSheetsCreate
}));

// 4. Mock Notion
const mockNotionDatabasesRetrieve = jest.fn().mockResolvedValue({ data_sources: [{ id: 'mock-data-source-id' }] });
const mockNotionDataSourcesQuery = jest.fn().mockResolvedValue({ results: [] });
const mockNotionPagesCreate = jest.fn().mockResolvedValue({ id: 'page-1' });
const mockNotionBlocksAppend = jest.fn().mockResolvedValue({});
jest.mock('notion-multipart-uploader', () => ({
    uploadToNotion: jest.fn().mockResolvedValue('file-upload-123')
}));
jest.mock('@notionhq/client', () => ({
    Client: jest.fn(() => ({
        databases: { retrieve: mockNotionDatabasesRetrieve },
        dataSources: { query: mockNotionDataSourcesQuery },
        pages: { create: mockNotionPagesCreate },
        blocks: { children: { append: mockNotionBlocksAppend } }
    }))
}));

global.fetch = jest.fn();

const mockGenerateAndWrapDEK = jest.fn();
const mockUnwrapAndDecrypt = jest.fn();
jest.mock('../services/kms', () => ({
    generateAndWrapDEK: mockGenerateAndWrapDEK,
    unwrapAndDecrypt: mockUnwrapAndDecrypt
}));

// Import the functions after mocking
const myFunctions = require('../index');
const { _mockGetUserInfo, _mockTasksList, _mockSheetsCreate } = require('googleapis');

describe('index.js Integration Tests', () => {
    let req, res;

    beforeEach(() => {
        jest.clearAllMocks();
        global.__params = {};
        global.__txConflicts = 0;
        // Reset rate limit mock — always allow (first request in window)
        mockRateLimitGet.mockResolvedValue({ exists: false });
        mockHistoryGet.mockResolvedValue({ exists: false });
        mockNotionPagesCreate.mockResolvedValue({ id: 'page-1' });
        req = {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            get: function (name) { return this.headers[(name || '').toLowerCase()]; },
            body: {}
        };
        res = {
            status: jest.fn().mockReturnThis(),
            send: jest.fn(),
            json: jest.fn(),
            set: jest.fn()
        };

        // Default successful token verification
        mockVerifyIdToken.mockResolvedValue(verifiedUser());
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({})
        });
    });

    afterEach(() => {
        if (global.gc) {
            global.gc();
        }
    });

    describe('setupNotion', () => {
        test('rejects GET requests with 405', async () => {
            req.method = 'GET';
            await myFunctions.setupNotion(req, res);
            expect(res.status).toHaveBeenCalledWith(405);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Method not allowed.", errorCode: "BAD_REQUEST" }));
        });

        test('rejects missing token with 401 AUTH_INVALID', async () => {
            req.body = null;
            await myFunctions.setupNotion(req, res);
            expect(res.status).toHaveBeenCalledWith(401);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "AUTH_INVALID" }));
        });

        test('rejects invalid body with 400', async () => {
            req.body = { idToken: 'valid-firebase-id-token', notionKey: 'short' };
            await myFunctions.setupNotion(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Invalid setup payload" }));
        });

        test('stores encrypted Notion key on success', async () => {
            req.body = {
                notionKey: 'secret_1234567890abcdef1234',
                notionDbId: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
                idToken: 'valid-firebase-id-token'
            };
            mockVerifyIdToken.mockResolvedValue(verifiedUser());

            await myFunctions.setupNotion(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ success: true, text: "Notion setup saved securely." }));
            expect(mockCollection).toHaveBeenCalledWith('users');
            expect(mockDoc).toHaveBeenCalledWith('test@example.com');
            expect(mockSet).toHaveBeenCalledWith({
                notionKey: expect.stringMatching(/^v3:/), // Encrypted and bound to the user
                notionDbId: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'
            }, { merge: true });

            // Ensure the stored key is NOT the plaintext, and only the owner's AAD opens it
            const setArg = mockSet.mock.calls[0][0];
            expect(setArg.notionKey).not.toBe('secret_1234567890abcdef1234');
            const { deriveKey, decryptBoundGcm, keyBindingAad } = require('../utils');
            const k = deriveKey('test-encryption-key-for-jest');
            expect(decryptBoundGcm(setArg.notionKey, k, keyBindingAad('test@example.com', 'notionKey'))).toBe('secret_1234567890abcdef1234');
            expect(() => decryptBoundGcm(setArg.notionKey, k, keyBindingAad('other@example.com', 'notionKey'))).toThrow();
        });

        test('stores encrypted modern ntn_ Notion token on success', async () => {
            const notionKey = 'ntn_dummy1234567890abcdefghijklmnopqrstuvwxyzA';
            req.body = {
                notionKey,
                notionDbId: '395cd42c5cd5809e8d8ae8c4456b38ab',
                idToken: 'valid-firebase-id-token'
            };
            mockVerifyIdToken.mockResolvedValue(verifiedUser());

            await myFunctions.setupNotion(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            const setArg = mockSet.mock.calls[0][0];
            expect(setArg.notionKey).toMatch(/^v3:/);
            expect(setArg.notionKey).not.toBe(notionKey);
            expect(setArg.notionDbId).toBe('395cd42c5cd5809e8d8ae8c4456b38ab');
        });

        test('handles Firebase ID token lookup failure', async () => {
            req.body = {
                notionKey: 'secret_1234567890abcdef1234',
                notionDbId: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
                idToken: 'invalid-firebase-id-token'
            };
            mockVerifyIdToken.mockRejectedValue(new Error('Invalid credentials'));

            await myFunctions.setupNotion(req, res);

            expect(res.status).toHaveBeenCalledWith(401);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "AUTH_INVALID" }));
            expect(mockSet).not.toHaveBeenCalled();
        });

        test('returns 429 when rate limit exceeded', async () => {
            req.body = { idToken: 'valid-firebase-id-token', notionKey: 'secret_1234567890abcdef1234567890abcdef', notionDbId: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6' };
            mockVerifyIdToken.mockResolvedValue(verifiedUser());
            mockRateLimitGet.mockResolvedValue({ exists: true, data: () => ({ count: 100, windowStart: Date.now() }) });
            await myFunctions.setupNotion(req, res);
            expect(res.status).toHaveBeenCalledWith(429);
            expect(res.set).toHaveBeenCalledWith('Retry-After', expect.any(String));
        });
    });

    describe('setupBYOK', () => {
        test('rejects GET requests with 405', async () => {
            req.method = 'GET';
            await myFunctions.setupBYOK(req, res);
            expect(res.status).toHaveBeenCalledWith(405);
        });

        test('rejects missing or invalid body with 400', async () => {
            req.body = { idToken: 'valid-firebase-id-token' };
            await myFunctions.setupBYOK(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Invalid setup payload" }));
        });

        test('stores KMS wrapped BYOK configuration on success', async () => {
            req.body = {
                apiKey: 'sk-abcdefg123456789012345',
                provider: 'openai',
                modelName: 'gpt-4o',
                idToken: 'valid-firebase-id-token'
            };
            mockVerifyIdToken.mockResolvedValue(verifiedUser());

            mockGenerateAndWrapDEK.mockResolvedValue({
                wrappedDek: 'wrappedD3k',
                encryptedKey: 'encryptedK3y',
                iv: 'iv123',
                authTag: 'auth123'
            });

            await myFunctions.setupBYOK(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(mockSet).toHaveBeenCalledWith({
                byokKmsData: expect.objectContaining({
                    wrappedDek: 'wrappedD3k',
                    provider: 'openai'
                }),
                geminiKey: 'mockDelete',
                byokConfig: 'mockDelete'
            }, { merge: true });
            // The local encryption is bound to the signed-in user (S-16).
            const { aad } = mockGenerateAndWrapDEK.mock.calls[0][1];
            expect(aad.toString('utf8')).toBe('aiplanner:v3:test@example.com:byok');
        });

        test('returns 429 when rate limit exceeded', async () => {
            req.body = { idToken: 'valid-firebase-id-token', apiKey: 'test' };
            mockVerifyIdToken.mockResolvedValue(verifiedUser());
            mockRateLimitGet.mockResolvedValue({ exists: true, data: () => ({ count: 100, windowStart: Date.now() }) });
            await myFunctions.setupBYOK(req, res);
            expect(res.status).toHaveBeenCalledWith(429);
            expect(res.set).toHaveBeenCalledWith('Retry-After', expect.any(String));
        });
    });

    describe('byokSession', () => {
        test('DELETE clears BYOK cookies with Max-Age=0', async () => {
            req.method = 'DELETE';
            await myFunctions.byokSession(req, res);
            expect(res.status).toHaveBeenCalledWith(200);
            // Should set two expiry cookies
            const setCookieCall = res.set.mock.calls.find(c => c[0] === 'Set-Cookie');
            expect(setCookieCall).toBeDefined();
            const cookies = setCookieCall[1];
            expect(cookies).toHaveLength(2);
            expect(cookies[0]).toContain('byok_token=;');
            expect(cookies[0]).toContain('Max-Age=0');
            expect(cookies[1]).toContain('byok_meta=;');
        });

        test('rejects GET with 405', async () => {
            req.method = 'GET';
            await myFunctions.byokSession(req, res);
            expect(res.status).toHaveBeenCalledWith(405);
        });

        test('rejects missing API key with 400 BYOK_INVALID', async () => {
            req.body = { idToken: 'valid-firebase-id-token' };
            await myFunctions.byokSession(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'BYOK_INVALID' }));
        });

        test('rejects an invalid provider with 400 BYOK_INVALID', async () => {
            req.body = { idToken: 'valid-firebase-id-token', apiKey: 'sk-abcdefg123456789012345', provider: 'nope' };
            await myFunctions.byokSession(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'BYOK_INVALID' }));
        });

        test('validates the config and sets NO cookies and writes nothing (C1)', async () => {
            req.body = {
                idToken: 'valid-firebase-id-token',
                apiKey: 'sk-abcdefg123456789012345',
                provider: 'openai',
                modelName: 'gpt-4o'
            };
            mockVerifyIdToken.mockResolvedValue(verifiedUser());

            await myFunctions.byokSession(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.send).toHaveBeenCalledWith({ valid: true, provider: 'openai', modelName: 'gpt-4o' });

            const setCookieCall = res.set.mock.calls.find(c => c[0] === 'Set-Cookie');
            expect(setCookieCall).toBeUndefined();
            expect(res.set).not.toHaveBeenCalledWith('Access-Control-Allow-Credentials', expect.anything());

            // CRITICAL: must NOT write to Firestore
            expect(mockSet).not.toHaveBeenCalled();
        });

        test('returns 429 when rate limit exceeded', async () => {
            req.body = { idToken: 'valid-firebase-id-token', apiKey: 'sk-abcdefg123456789012345' };
            mockVerifyIdToken.mockResolvedValue(verifiedUser());
            mockRateLimitGet.mockResolvedValue({ exists: true, data: () => ({ count: 100, windowStart: Date.now() }) });
            await myFunctions.byokSession(req, res);
            expect(res.status).toHaveBeenCalledWith(429);
            expect(res.set).toHaveBeenCalledWith('Retry-After', expect.any(String));
        });
    });

    describe('exportUserData', () => {
        test('rejects missing token', async () => {
            await myFunctions.exportUserData(req, res);
            expect(res.status).toHaveBeenCalledWith(401);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "AUTH_INVALID" }));
        });

        test('rejects invalid token', async () => {
            req.body.token = 'invalid-google-oauth-token-string';
            mockVerifyIdToken.mockRejectedValue(new Error('Auth error'));

            await myFunctions.exportUserData(req, res);
            expect(res.status).toHaveBeenCalledWith(401);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "AUTH_INVALID" }));
        });

        test('exports expected schema for user with data', async () => {
            req.body.token = 'valid-google-oauth-token-string';
            mockGet.mockResolvedValue({
                exists: true,
                data: () => ({ notionKey: 'v2:enc:data', notionDbId: 'test-db-id', updatedAt: '2025-01-01' })
            });

            await myFunctions.exportUserData(req, res);

            expect(res.status).toHaveBeenCalledWith(200);

            const responseData = res.send.mock.calls[0][0];
            expect(responseData).toHaveProperty('email', 'test@example.com');
            expect(responseData).toHaveProperty('data.notionDbId', 'test-db-id');
            expect(responseData).toHaveProperty('data.notionConfigured', true);
            expect(responseData.data).toHaveProperty('syncHistory');
        });

        test('handles user not found gracefully', async () => {
            req.body.token = 'valid-google-oauth-token-string';
            mockGet.mockResolvedValue({
                exists: false,
                data: () => null
            });

            await myFunctions.exportUserData(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            const responseData = res.send.mock.calls[0][0];
            expect(responseData.data).toStrictEqual({});
            expect(responseData.accountExists).toBe(false);
        });

        test('returns 429 when rate limit exceeded', async () => {
            req.body.token = 'valid-token';
            mockRateLimitGet.mockResolvedValue({ exists: true, data: () => ({ count: 100, windowStart: Date.now() }) });
            await myFunctions.exportUserData(req, res);
            expect(res.status).toHaveBeenCalledWith(429);
        });
    });

    describe('deleteUserAccount', () => {
        test('rejects missing token', async () => {
            await myFunctions.deleteUserAccount(req, res);
            expect(res.status).toHaveBeenCalledWith(401);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "AUTH_INVALID" }));
        });

        test('successfully deletes user document', async () => {
            req.body.token = 'valid-google-oauth-token-string';

            await myFunctions.deleteUserAccount(req, res);

            expect(mockCollection).toHaveBeenCalledWith('users');
            expect(mockDoc).toHaveBeenCalledWith('test@example.com');
            // The batch commit executes the cascading delete
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.send).toHaveBeenCalledWith({ success: true, text: "Your account data has been permanently deleted." });
        });

        test('returns 429 when rate limit exceeded', async () => {
            req.body.token = 'valid-token';
            mockRateLimitGet.mockResolvedValue({ exists: true, data: () => ({ count: 100, windowStart: Date.now() }) });
            await myFunctions.deleteUserAccount(req, res);
            expect(res.status).toHaveBeenCalledWith(429);
        });
    });

    describe('syncPlanner', () => {
        const validImageData = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64');
        const { deriveKey, encrypt } = require('../utils');
        const testKey = deriveKey('test-encryption-key-for-jest');
        const validEncryptedKey = encrypt('secret_fake_notion_key_value', testKey);

        beforeEach(() => {
            delete global.__geminiMockText;
            req.body = {
                idToken: 'valid-firebase-id-token',
                googleToken: 'valid-google-oauth-token-string',
                syncType: 'morning',
                images: [validImageData]
            };
            mockVerifyIdToken.mockResolvedValue(verifiedUser());
            _mockGetUserInfo.mockResolvedValue({ data: { email: 'test@example.com' } });

            // Default calendar/tasks list mocks for dedup (empty = no existing items)
            mockCalendarList.mockResolvedValue({ data: { items: [] } });
            _mockTasksList.mockResolvedValue({ data: { items: [] } });

            // Default user exists
            mockGet.mockResolvedValue({
                exists: true,
                data: () => ({ notionKey: validEncryptedKey, notionDbId: 'test-db-id', spreadsheetId: 'test-sheet-id' })
            });

            // Dynamic fetch mock for both Gemini REST API and Notion upload
            global.fetch.mockImplementation(async (url) => {
                // Notion API mock
                if (url.includes('notion.com/v1/file_uploads')) {
                    return { ok: true, json: async () => ({ id: 'mock-file-id', upload_url: 'https://mock-upload-url.com' }) };
                }
                if (url.includes('mock-upload-url.com')) {
                    return { ok: true, text: async () => 'Upload successful' };
                }

                if (url.includes('generativelanguage')) {
                    // Gemini REST API Mock Response
                    // We can return different data based on req.body.syncType,
                    // but since the mock is set per test, we'll provide a default that tests can override.
                    let textJSON = JSON.stringify({
                        date: "2025-01-01",
                        schedule: [{ time: "9 AM", task: "Meeting", block: true, reminder: false }],
                        todos: [{ task: "Buy milk", done: false }]
                    });

                    if (req.body.syncType === 'evening') {
                        textJSON = JSON.stringify({
                            date: "2025-01-01",
                            todos: [{ task: "Buy milk", done: true }],
                            expenses: [{ item: "Food", amount: 10 }],
                            health: { exercise: "Run", water: 5, sleep: 7, energy: 4 },
                            brainDump: "Good day"
                        });
                    } else if (req.body.syncType === 'journal') {
                        textJSON = JSON.stringify({ date: "15-January-2025" });
                    }

                    // Allow tests to override this logic via global.__geminiMockText
                    if (global.__geminiMockText) {
                        if (global.__geminiMockText === 'SERVER_ERROR') {
                            return { ok: false, status: 500, text: async () => 'Internal Server Error' };
                        }
                        textJSON = global.__geminiMockText;
                    }

                    return {
                        ok: true,
                        json: async () => ({
                            candidates: [{
                                content: { parts: [{ text: textJSON }] }
                            }]
                        })
                    };
                } else if (url.includes('notion')) {
                    // Realistic Notion 2-step upload mock (matches production contract)
                    return {
                        ok: true,
                        text: async () => JSON.stringify({ id: 'file-upload-123', upload_url: 'https://s3.us-west-2.amazonaws.com/notion-upload/fake', url: 'https://prod-files-secure.s3.us-west-2.amazonaws.com/fake.jpg' }),
                        json: async () => ({ id: 'file-upload-123', upload_url: 'https://s3.us-west-2.amazonaws.com/notion-upload/fake', url: 'https://prod-files-secure.s3.us-west-2.amazonaws.com/fake.jpg' })
                    };
                }
                return { ok: true, json: async () => ({}) };
            });
        });
        test('returns 413 Payload Too Large when body size exceeds 28MB', async () => {
            req.body.syncType = 'morning';
            req.body.token = 'valid-token';
            req.body = { data: "A".repeat(30_000_000) };
            req.rawBody = Buffer.alloc(30_000_000); // Mock Firebase's raw bytes buffer
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(413);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Payload too large. Max 28MB allowed." }));
        });

        test('returns 429 when rate limit exceeded', async () => {
            mockRateLimitGet.mockResolvedValue({ exists: true, data: () => ({ count: 100, windowStart: Date.now() }) });
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(429);
            expect(res.set).toHaveBeenCalledWith('Retry-After', expect.any(String));
        });

        test('bypasses credit deduction for stateless BYOK user', async () => {
            req.body.syncType = 'morning';
            req.headers['x-byok-token'] = 'sk-mock-12345678901234567890';
            // Re-mock to assert transaction doesn't throw on 0 credits
            const currentMonth = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 7);
            const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
            mockGet.mockResolvedValue({
                exists: true,
                data: () => ({ tierCredits: 0, boosterCredits: 0, tier: 'free', subscriptionRenewalDate: currentMonth, lastTierCreditRenewalAt: today })
            });

            // Mock response corresponding to OpenAI / UniversalAIAdapter structure
            global.fetch.mockImplementation(async (url) => {
                if (url.includes('notion.com')) {
                    return { ok: true, json: async () => ({ id: 'mock', upload_url: 'mock' }), text: async () => '{"id":"mock"}' };
                }
                return {
                    ok: true,
                    json: async () => ({
                        choices: [{
                            message: {
                                content: JSON.stringify({
                                    date: "2025-01-01",
                                    schedule: [{ time: "9 AM", task: "Meeting", block: true, reminder: false }],
                                    todos: [{ task: "Buy milk", done: false }]
                                })
                            }
                        }]
                    })
                };
            });

            await myFunctions.syncPlanner(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            // Inspect the set arguments from the transaction block updateObj
            // tierCredits shouldn't be negative and shouldn't be deducted
            const setCalls = mockSet.mock.calls;
            const txCall = setCalls.find(c => c[0] && c[0].tierCredits !== undefined);
            if (txCall) {
                // If it was written back, it should not have deducted
                expect(txCall[0].tierCredits).toBe(0);
            }
        });

        test('returns 500 when KMS envelope decryption fails (fail closed)', async () => {
            req.body.syncType = 'morning';
            mockGet.mockResolvedValue({
                exists: true,
                data: () => ({
                    tierCredits: 10,
                    byokKmsData: {
                        encryptedKey: 'mock', wrappedDek: 'mock', iv: 'mock', authTag: 'mock', provider: 'openai'
                    }
                })
            });

            // Make the mock decryption throw
            mockUnwrapAndDecrypt.mockRejectedValueOnce(new Error('KMS failure'));

            await myFunctions.syncPlanner(req, res);

            expect(res.status).toHaveBeenCalledWith(500);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "INTERNAL", creditRefunded: false }));
            // Assert that no fallback Gemini/default API was called
            expect(global.fetch).not.toHaveBeenCalled();
        });

        test('rejects request with invalid token', async () => {
            req.body.idToken = null;
            delete req.body.googleToken;
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(401);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "AUTH_INVALID" }));
        });

        test('rejects request with invalid syncType', async () => {
            req.body.syncType = 'invalid-mode';
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Invalid syncType" }));
        });

        test('rejects request with invalid image data', async () => {
            req.body.images = ['not-a-data-url'];
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Invalid image data format, size, or too many images (max 5)." }));
        });

        test('processes journal sync successfully', async () => {
            req.body.syncType = 'journal';
            req.body.images = [validImageData];
            global.__geminiMockText = JSON.stringify({ date: "15-January-2025" });

            await myFunctions.syncPlanner(req, res);

            expect(mockNotionPagesCreate).toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("Journal synced to Notion") }));
        });

        test('journal sync to Notion fails gracefully if user has no Notion settings', async () => {
            req.body.syncType = 'journal';
            mockGet.mockResolvedValue({ exists: true, data: () => ({ notesDestination: 'notion' }) });

            await myFunctions.syncPlanner(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Notion not setup. Please provide keys." }));
            expect(mockNotionPagesCreate).not.toHaveBeenCalled();
        });

        test('processes morning sync successfully', async () => {
            req.body.syncType = 'morning';

            await myFunctions.syncPlanner(req, res);

            expect(global.fetch).toHaveBeenCalled();
            expect(mockCalendarInsert).toHaveBeenCalled();
            expect(mockTasksInsert).toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ text: "Morning Sync Complete! Created 1 events, 0 reminders, and 1 tasks." }));
        });

        test('persists the client timezone on the user document during sync', async () => {
            req.body.syncType = 'morning';
            req.body.timeZone = 'America/New_York';

            await myFunctions.syncPlanner(req, res);

            // The credit/gamification transaction writes the resolved timezone so the
            // separate streak transaction and monthly renewal use the user's local day.
            const tzWrite = mockSet.mock.calls.find(c => c[0] && c[0].timeZone === 'America/New_York');
            expect(tzWrite).toBeDefined();
            expect(res.status).toHaveBeenCalledWith(200);
        });

        test('morning sync does not crash when planner date is invalid', async () => {
            req.body.syncType = 'morning';
            global.fetch.mockImplementation(async (url) => {
                if (url.includes('generativelanguage')) {
                    return {
                        ok: true,
                        json: async () => ({
                            candidates: [{
                                content: {
                                    parts: [{
                                        text: JSON.stringify({
                                            date: "not-a-real-date",
                                            schedule: [{ time: "9 AM", task: "Meeting", block: true, reminder: false }],
                                            todos: [{ task: "Task without parseable date", done: false }]
                                        })
                                    }]
                                }
                            }]
                        })
                    };
                }
                return { ok: true, json: async () => ({}) };
            });

            await myFunctions.syncPlanner(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(mockCalendarInsert).not.toHaveBeenCalled(); // parseDateTime returns null for invalid date
            expect(mockTasksInsert).toHaveBeenCalledWith(expect.objectContaining({
                requestBody: expect.not.objectContaining({ due: expect.any(String) })
            }));
        });

        test('morning sync continues when Google Tasks insert fails', async () => {
            req.body.syncType = 'morning';
            mockTasksInsert.mockRejectedValue(new Error('Tasks API unavailable'));

            await myFunctions.syncPlanner(req, res);

            expect(mockCalendarInsert).toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({
                text: "Morning Sync Complete! Created 1 events, 0 reminders, and 0 tasks."
            }));
        });

        test('processes evening sync successfully', async () => {
            req.body.syncType = 'evening';
            global.__geminiMockText = JSON.stringify({ date: "2025-01-01", todos: [{ task: "Buy milk", done: true }], expenses: [{ item: "Food", amount: 10 }], health: { exercise: "Run", water: 5, sleep: 7, energy: 4 }, brainDump: "Good day" });
            _mockTasksList.mockResolvedValue({ data: { items: [{ id: 'task-123', title: 'Buy milk' }] } });

            await myFunctions.syncPlanner(req, res);

            expect(mockTasksPatch).toHaveBeenCalledWith(expect.objectContaining({ task: 'task-123', requestBody: { status: 'completed' } }));
            expect(mockSheetsAppend).toHaveBeenCalledTimes(2); // Expenses and Health
            expect(mockNotionPagesCreate).toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("Night Sync Complete") }));
        });

        test('evening sync creates spreadsheet if missing', async () => {
            req.body.syncType = 'evening';
            // User has no spreadsheetId
            mockGet.mockResolvedValue({
                exists: true,
                data: () => ({ notionKey: 'v2:enc:data', notionDbId: 'test-db-id' })
            });
            global.__geminiMockText = JSON.stringify({ date: "2025-01-01", todos: [], expenses: [], health: {} });
            _mockSheetsCreate.mockResolvedValue({ data: { spreadsheetId: 'new-sheet-id' } });
            _mockTasksList.mockResolvedValue({ data: { items: [] } });

            await myFunctions.syncPlanner(req, res);

            expect(_mockSheetsCreate).toHaveBeenCalled();
            expect(mockSheetsUpdate).toHaveBeenCalledTimes(2); // Headers
            expect(mockSet).toHaveBeenCalledWith({ spreadsheetId: 'new-sheet-id' }, { merge: true });
            expect(res.status).toHaveBeenCalledWith(200);
        });

        test('returns 500 when Gemini throws an exception', async () => {
            req.body.syncType = 'morning';
            global.__geminiMockText = 'SERVER_ERROR';

            await myFunctions.syncPlanner(req, res);

            expect(res.status).toHaveBeenCalledWith(502);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "AI_UNAVAILABLE", creditRefunded: true }));
        });

        // --- Audit Report Section B: Additional endpoint tests ---

        test('morning sync creates calendar event at 9:30 for "9:30 AM" schedule item', async () => {
            req.body.syncType = 'morning';
            // Override fetch to return a schedule with 9:30 AM
            global.fetch.mockImplementation(async (url) => {
                if (url.includes('generativelanguage')) {
                    return {
                        ok: true,
                        json: async () => ({
                            candidates: [{
                                content: {
                                    parts: [{
                                        text: JSON.stringify({
                                            date: "2025-01-01",
                                            schedule: [{ time: "9:30 AM", task: "Standup", block: true, reminder: true }],
                                            todos: []
                                        })
                                    }]
                                }
                            }]
                        })
                    };
                }
                return { ok: true, json: async () => ({}) };
            });

            await myFunctions.syncPlanner(req, res);

            expect(mockCalendarInsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    resource: expect.objectContaining({
                        summary: 'Standup',
                        start: expect.objectContaining({ dateTime: expect.stringContaining('09:30') }),
                        end: expect.objectContaining({ dateTime: expect.stringContaining('10:30') }),
                    })
                })
            );
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({
                text: expect.stringContaining("1 events, 1 reminders")
            }));
        });

        test('journal sync handles Notion upload failure gracefully', async () => {
            req.body.syncType = 'journal';
            global.__geminiMockText = JSON.stringify({ date: "15-January-2025" });
            
            // Make the package throw an error to simulate upload failure
            const { uploadToNotion } = require('notion-multipart-uploader');
            uploadToNotion.mockRejectedValueOnce(new Error('Internal Server Error: rate limited'));

            await myFunctions.syncPlanner(req, res);

            // uploadFileToNotion throws → caught by outer catch → returns 500 and refunds
            expect(res.status).toHaveBeenCalledWith(500);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "INTERNAL", creditRefunded: true }));
        });

        test('journal sync handles Notion init response missing upload_url', async () => {
            req.body.syncType = 'journal';
            global.__geminiMockText = JSON.stringify({ date: "15-January-2025" });
            
            // Make the package throw an error to simulate missing URL or other invalid upload shapes
            const { uploadToNotion } = require('notion-multipart-uploader');
            uploadToNotion.mockRejectedValueOnce(new Error('Notion Init Upload Failed'));

            await myFunctions.syncPlanner(req, res);

            // fetch(undefined) for upload step should cause an error
            expect(res.status).toHaveBeenCalledWith(500);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "INTERNAL", creditRefunded: true }));
        });

        test('rejects request from unauthorized CORS origin', async () => {
            req.headers.origin = 'https://evil-site.com';
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "ORIGIN_NOT_ALLOWED" }));
        });

        test('handles OPTIONS preflight request', async () => {
            req.method = 'OPTIONS';
            req.headers.origin = 'https://ai-planner-project-467800.web.app';
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(204);
        });

        // --- Audit Report Section C: External API contract tests ---

        test('handles Google Tasks list with missing items array', async () => {
            req.body.syncType = 'evening';
            global.__geminiMockText = JSON.stringify({
                date: "2025-01-01",
                todos: [{ task: "Buy milk", done: true }],
                expenses: [],
                health: {}
            });
            // Tasks API returns no items key
            _mockTasksList.mockResolvedValue({ data: {} });

            await myFunctions.syncPlanner(req, res);

            // Should complete without crashing (graceful degradation)
            expect(mockTasksPatch).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(200);
        });

        test('handles empty schedule array gracefully in morning sync', async () => {
            req.body.syncType = 'morning';
            global.fetch.mockImplementation(async (url) => {
                if (url.includes('generativelanguage')) {
                    return {
                        ok: true,
                        json: async () => ({
                            candidates: [{
                                content: {
                                    parts: [{
                                        text: JSON.stringify({
                                            date: "2025-01-01",
                                            schedule: [],
                                            todos: []
                                        })
                                    }]
                                }
                            }]
                        })
                    };
                }
                return { ok: true, json: async () => ({}) };
            });

            await myFunctions.syncPlanner(req, res);

            expect(mockCalendarInsert).not.toHaveBeenCalled();
            expect(mockTasksInsert).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({
                text: "Morning Sync Complete! Created 0 events, 0 reminders, and 0 tasks."
            }));
        });

        test('handles evening sync with no expenses or health data', async () => {
            req.body.syncType = 'evening';
            global.__geminiMockText = JSON.stringify({
                date: "2025-01-01",
                todos: [],
                expenses: [],
                health: {}
            });
            _mockTasksList.mockResolvedValue({ data: { items: [] } });

            await myFunctions.syncPlanner(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            const responseText = res.send.mock.calls[0][0].text;
            expect(responseText).toContain("Night Sync");
        });

        // --- Branch coverage: RATE_LIMIT safe error message ---
        test('returns "AI Service Busy" when Gemini throws RATE_LIMIT', async () => {
            req.body.syncType = 'morning';
            global.fetch.mockImplementation(async (url) => {
                if (url.includes('generativelanguage')) {
                    throw new Error('RATE_LIMIT exceeded');
                }
                return { ok: true, json: async () => ({}) };
            });

            await myFunctions.syncPlanner(req, res);

            expect(res.status).toHaveBeenCalledWith(502);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "AI_UNAVAILABLE" }));
        });

        // --- Branch coverage: journal date extraction failure fallback ---
        test('uses today date when Gemini date extraction fails', async () => {
            req.body.syncType = 'journal';
            req.body.images = [validImageData];
            let callCount = 0;
            global.fetch.mockImplementation(async (url) => {
                if (url.includes('generativelanguage')) {
                    callCount++;
                    if (callCount === 1) {
                        throw new Error('Gemini unavailable');
                    }
                    return {
                        ok: true,
                        json: async () => ({
                            candidates: [{ content: { parts: [{ text: JSON.stringify({ date: "15-January-2025" }) }] } }]
                        })
                    };
                }
                if (url.includes('notion') || url.includes('s3')) {
                    return {
                        ok: true,
                        text: async () => JSON.stringify({ id: 'file-upload-123', upload_url: 'https://s3.us-west-2.amazonaws.com/notion-upload/fake' }),
                        json: async () => ({ id: 'file-upload-123', upload_url: 'https://s3.us-west-2.amazonaws.com/notion-upload/fake' })
                    };
                }
                return { ok: true, json: async () => ({}) };
            });

            await myFunctions.syncPlanner(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({
                text: expect.stringContaining('Journal synced to Notion!')
            }));
        });

        // --- Branch coverage: non-Error throw handling ---
        test('handles non-Error throw (string) without secondary crash', async () => {
            req.body.syncType = 'morning';
            global.fetch.mockImplementation(async (url) => {
                if (url.includes('generativelanguage')) {
                    throw 'unexpected string error';  // Not an Error object
                }
                return { ok: true, json: async () => ({}) };
            });

            await myFunctions.syncPlanner(req, res);

            expect(res.status).toHaveBeenCalledWith(502);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "AI_UNAVAILABLE" }));
        });

        // --- Branch coverage: plannerData.error path (line 341) ---
        test('returns 400 when Gemini returns error object for morning sync', async () => {
            req.body.syncType = 'morning';
            global.fetch.mockImplementation(async (url) => {
                if (url.includes('generativelanguage')) {
                    return {
                        ok: true,
                        json: async () => ({
                            candidates: [{ content: { parts: [{ text: JSON.stringify({ error: "Could not parse image" }) }] } }]
                        })
                    };
                }
                return { ok: true, json: async () => ({}) };
            });
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({
                errorCode: "INVALID_IMAGE",
                error: expect.stringContaining("Could not parse image")
            }));
        });

        // --- Branch coverage: evening plannerData.error (line 360) ---
        test('returns 400 when Gemini returns error for evening sync', async () => {
            req.body.syncType = 'evening';
            global.fetch.mockImplementation(async (url) => {
                if (url.includes('generativelanguage')) {
                    return {
                        ok: true,
                        json: async () => ({
                            candidates: [{ content: { parts: [{ text: JSON.stringify({ error: "Image too blurry" }) }] } }]
                        })
                    };
                }
                return { ok: true, json: async () => ({}) };
            });
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
        });

        // --- Branch coverage: evening Notion sync error (lines 415-416) ---
        test('evening sync handles Notion sync error gracefully', async () => {
            req.body.syncType = 'evening';
            mockNotionPagesCreate.mockRejectedValue(new Error('Notion API Rate Limited'));
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(200);
            const responseText = res.send.mock.calls[0][0].text;
            expect(responseText).toContain("Night Sync");
            expect(responseText).toContain("(Notion not saved:");
            expect(responseText).toContain("Notion API Rate Limited");
        });

        test('evening sync reports observable Notion message when brainDump text is missing', async () => {
            req.body.syncType = 'evening';
            global.__geminiMockText = JSON.stringify({
                date: "2025-01-01",
                todos: [],
                expenses: [{ item: "Coffee", amount: 5 }],
                health: { exercise: "Walk", water: 4, sleep: 7, energy: 3 },
            });
            _mockTasksList.mockResolvedValue({ data: { items: [] } });

            await myFunctions.syncPlanner(req, res);

            const responseText = res.send.mock.calls[0][0].text;
            expect(responseText).toContain("Night Sync Complete");
            expect(responseText).toMatch(/Saved Visual Brain Dump to Notion|Notion: Brain Dump page already exists|\(Notion not saved:/);
        });

        // --- Branch coverage: missing Notion keys (line 424) ---
        test('evening sync skips Notion when Notion is chosen but keys are missing', async () => {
            req.body.syncType = 'evening';
            mockGet.mockResolvedValue({
                exists: true,
                data: () => ({ spreadsheetId: 'test-sheet-id', notesDestination: 'notion' })  // No notionKey, no notionDbId
            });
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(200);
            const body = res.send.mock.calls[0][0];
            expect(body.text).toContain("Skipped Notion");
            expect(body.notes).toContain("Notion isn't connected, so the brain dump wasn't saved.");
            expect(body.savedTo).toBeUndefined();
            expect(mockDriveCreate).not.toHaveBeenCalled();
        });

        // --- Branch coverage: Sheets API errors (lines 433-434, 750-751, 779-780) ---
        test('evening sync handles Sheets API errors gracefully', async () => {
            req.body.syncType = 'evening';
            mockSheetsAppend.mockRejectedValue(new Error('Sheets API error'));
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(200);
        });

        test('evening sync refunds the credit and warns the user when a sheet write fails', async () => {
            req.body.syncType = 'evening';
            global.__geminiMockText = JSON.stringify({ date: '2025-01-01', todos: [], expenses: [{ item: 'Coffee', amount: 5 }], health: {} });
            _mockTasksList.mockResolvedValue({ data: { items: [] } });
            // No Notion configured, so the failed sheet write means nothing synced at all.
            mockGet.mockResolvedValue({ exists: true, data: () => ({ spreadsheetId: 'test-sheet-id', tierCredits: 5 }) });
            // Genuine Sheets API failure on append (dedup .get returns empty, so it tries to append)
            mockSheetsAppend.mockRejectedValue(new Error('Sheets API down'));

            const streakSpy = jest.spyOn(myFunctions, 'applyGamificationMilestones');

            await myFunctions.syncPlanner(req, res);

            // Still returns 200 so the user keeps whatever partially synced, but the
            // response surfaces the failure and the deducted credit is refunded.
            expect(res.status).toHaveBeenCalledWith(200);
            const responseText = res.send.mock.calls[0][0].text;
            expect(responseText).toContain('Could not sync: Expenses');
            expect(responseText).toContain('refunded');
            expect(streakSpy).not.toHaveBeenCalled();

            const refundCall = mockUpdate.mock.calls.find(c => c[0] && c[0].tierCredits === 'mockIncrement(1)');
            expect(refundCall).toBeDefined();

            streakSpy.mockRestore();
        });

        // --- Branch coverage: 429 retry loop (lines 553-560) ---
        test('handles 429 rate limit with retry and eventual success', async () => {
            req.body.syncType = 'morning';
            let callCount = 0;
            global.fetch.mockImplementation(async (url) => {
                if (url.includes('generativelanguage')) {
                    callCount++;
                    if (callCount === 1) return { ok: false, status: 429 };
                    return {
                        ok: true,
                        json: async () => ({
                            candidates: [{
                                content: {
                                    parts: [{
                                        text: JSON.stringify({
                                            date: "2025-01-01", schedule: [{ time: "10 AM", task: "Standup", block: false, reminder: true }], todos: []
                                        })
                                    }]
                                }
                            }]
                        })
                    };
                }
                return { ok: true, json: async () => ({}) };
            });
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(200);
            expect(callCount).toBeGreaterThanOrEqual(2);
        }, 15000);

        // --- Branch coverage: Gemini 4xx API error (lines 563-564) ---
        test('handles Gemini 400 image rejection as INVALID_IMAGE and refunds (never charge a sync that synced nothing)', async () => {
            req.body.syncType = 'morning';
            mockGet.mockResolvedValue({
                exists: true,
                data: () => ({ tierCredits: 10, boosterCredits: 0, tier: 'free', subscriptionRenewalDate: '2025-06', lastTierCreditRenewalAt: '2025-06-01' })
            });
            global.fetch.mockImplementation(async (url) => {
                if (url.includes('generativelanguage')) {
                    return { ok: false, status: 400, text: async () => 'Bad Request: invalid image' };
                }
                return { ok: true, json: async () => ({}) };
            });
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'INVALID_IMAGE', creditRefunded: true }));
            const refundCall = mockUpdate.mock.calls.find(c => c[0] && c[0].tierCredits === 'mockIncrement(1)');
            expect(refundCall).toBeDefined();
            // A rejected image is not retried on every fallback model.
            expect(global.fetch.mock.calls.filter(c => String(c[0]).includes('generativelanguage'))).toHaveLength(1);
        });

        // --- Branch coverage: Notion placeholder key (lines 789-790) ---
        test('evening sync skips Notion when API key is placeholder', async () => {
            req.body.syncType = 'evening';
            const placeholderKey = encrypt('YOUR_NOTION_KEY', testKey);
            mockGet.mockResolvedValue({
                exists: true,
                data: () => ({ notionKey: placeholderKey, notionDbId: 'test-db-id', spreadsheetId: 'test-sheet-id' })
            });
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(200);
        });

        // --- Branch coverage: plaintext notionKey triggers migration (lines 74, 101, 110) ---
        test('evening sync migrates plaintext notionKey to encrypted', async () => {
            req.body.syncType = 'evening';
            // Plaintext key (no ":" in it) triggers the needsMigration=true path
            mockGet.mockResolvedValue({
                exists: true,
                data: () => ({ notionKey: 'secret_plaintext_notion_key', notionDbId: 'test-db-id', spreadsheetId: 'test-sheet-id' })
            });
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(200);
            // Verify that set was called (migration writes encrypted key)
            expect(mockSet).toHaveBeenCalled();
        });

        // --- Branch coverage: corrupted notionKey triggers decryption error catch (lines 75-77) ---
        test('evening sync handles corrupted notionKey gracefully', async () => {
            req.body.syncType = 'evening';
            // v2: prefix but invalid base64/crypto data will cause decryption to throw
            mockGet.mockResolvedValue({
                exists: true,
                data: () => ({ notionKey: 'v2:totally:invalid:crypto:data', notionDbId: 'test-db-id', spreadsheetId: 'test-sheet-id' })
            });
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(200);
            // Should skip Notion (decryption failed, key is null)
            const responseText = res.send.mock.calls[0][0].text;
            expect(responseText).toContain("Skipped Notion");
        });

        // --- Branch coverage: Firebase ID token returns no email ---
        test('returns error when Firebase ID token has no email', async () => {
            mockVerifyIdToken.mockResolvedValue({}); // No email field
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(401);
        });

        // --- Branch coverage: Google Token identity mismatch ---
        test('returns 403 when Google Token email does not match Firebase ID email', async () => {
            mockVerifyIdToken.mockResolvedValue(verifiedUser());
            _mockGetUserInfo.mockResolvedValue({ data: { email: 'malicious@example.com' } });
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "GOOGLE_ACCOUNT_MISMATCH", creditRefunded: false }));
        });

        // --- Branch coverage: legacy CBC notionKey path (lines 57, 70-71) ---
        test('evening sync processes legacy CBC-encrypted notionKey', async () => {
            req.body.syncType = 'evening';
            // A key with ":" but no "v2:" prefix triggers the CBC decrypt path
            // This will fail decryption (wrong format) and fall to the catch
            mockGet.mockResolvedValue({
                exists: true,
                data: () => ({ notionKey: 'legacy:cbc:encrypted:key', notionDbId: 'test-db-id', spreadsheetId: 'test-sheet-id' })
            });
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(200);
        });

        test('evening sync successfully decrypts valid legacy CBC notionKey', async () => {
            req.body.syncType = 'evening';

            // Generate a valid legacy CBC encryption payload
            const crypto = require('crypto');
            const iv = crypto.randomBytes(16);
            const key = Buffer.alloc(32);
            Buffer.from('test-encryption-key-for-jest').copy(key);
            const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
            let encrypted = cipher.update('secret_legacy_valid_key');
            encrypted = Buffer.concat([encrypted, cipher.final()]);
            const legacyKeyData = iv.toString('hex') + ':' + encrypted.toString('hex');

            mockGet.mockResolvedValue({
                exists: true,
                data: () => ({ notionKey: legacyKeyData, notionDbId: 'test-db-id', spreadsheetId: 'test-sheet-id' })
            });

            await myFunctions.syncPlanner(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
        });
    });

    // --- Audit Report Section B: Additional GDPR endpoint edge cases ---
    describe('exportUserData - additional', () => {
        test('rejects non-POST request with 405', async () => {
            req.method = 'GET';
            req.body.token = 'valid-google-oauth-token-string';
            await myFunctions.exportUserData(req, res);
            expect(res.status).toHaveBeenCalledWith(405);
        });

        test('returns 401 when token has no email', async () => {
            req.body.token = 'valid-google-oauth-token-string';
            mockVerifyIdToken.mockResolvedValue({ uid: '123' }); // no email
            await myFunctions.exportUserData(req, res);
            expect(res.status).toHaveBeenCalledWith(401);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "AUTH_INVALID" }));
        });
    });

    describe('deleteUserAccount - additional', () => {
        test('rejects non-POST request with 405', async () => {
            req.method = 'GET';
            req.body.token = 'valid-google-oauth-token-string';
            await myFunctions.deleteUserAccount(req, res);
            expect(res.status).toHaveBeenCalledWith(405);
        });

        test('returns 401 when token has no email', async () => {
            req.body.token = 'valid-google-oauth-token-string';
            mockVerifyIdToken.mockResolvedValue({ uid: '123' }); // no email
            await myFunctions.deleteUserAccount(req, res);
            expect(res.status).toHaveBeenCalledWith(401);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "AUTH_INVALID" }));
        });
    });

    // --- Branch coverage: syncPlanner method & content-type guards ---
    describe('syncPlanner - request validation branches', () => {
        test('rejects non-POST syncPlanner with 405', async () => {
            req.method = 'GET';
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(405);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Method not allowed.", errorCode: "BAD_REQUEST" }));
        });

        test('rejects non-JSON content-type for syncPlanner with 415', async () => {
            req.headers['content-type'] = 'text/plain';
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(415);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "BAD_REQUEST" }));
        });
    });

    // --- Branch coverage: deleteUserAccount catch block ---
    describe('deleteUserAccount - error handling', () => {
        test('returns 500 when Firestore delete throws', async () => {
            req.body.token = 'valid-google-oauth-token-string';
            mockVerifyIdToken.mockResolvedValue(verifiedUser());
            mockGet.mockResolvedValue({ exists: true });
            // Make Firestore delete throw
            mockBatch.commit.mockRejectedValueOnce(new Error('Firestore unavailable'));

            await myFunctions.deleteUserAccount(req, res);

            expect(res.status).toHaveBeenCalledWith(500);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Failed to delete account." }));
        });
    });

    // --- Branch coverage: content-type guards for all endpoints ---
    describe('content-type validation branches', () => {
        test('setupNotion rejects non-JSON content-type with 415', async () => {
            req.headers['content-type'] = 'text/plain';
            await myFunctions.setupNotion(req, res);
            expect(res.status).toHaveBeenCalledWith(415);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Content-Type must be application/json.", errorCode: "BAD_REQUEST" }));
        });

        test('exportUserData rejects non-JSON content-type with 415', async () => {
            req.headers['content-type'] = 'text/html';
            await myFunctions.exportUserData(req, res);
            expect(res.status).toHaveBeenCalledWith(415);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Content-Type must be application/json.", errorCode: "BAD_REQUEST" }));
        });

        test('deleteUserAccount rejects non-JSON content-type with 415', async () => {
            req.headers['content-type'] = 'multipart/form-data';
            await myFunctions.deleteUserAccount(req, res);
            expect(res.status).toHaveBeenCalledWith(415);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Content-Type must be application/json.", errorCode: "BAD_REQUEST" }));
        });
    });

    describe('logClientError', () => {
        test('rejects GET requests with 405', async () => {
            req.method = 'GET';
            await myFunctions.logClientError(req, res);
            expect(res.status).toHaveBeenCalledWith(405);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Method not allowed.", errorCode: "BAD_REQUEST" }));
        });

        test('accepts valid error payload and logs it', async () => {
            req.body = {
                message: "ReferenceError: foo is not defined",
                stack: "at bar (app.js:10:5)",
                url: "localhost:8081",
                userEmail: "crash_tester@example.com"
            };

            await myFunctions.logClientError(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.send).toHaveBeenCalledWith({ success: true });
        });
    });

    describe('adminGrantCredits', () => {
        test('rejects request with missing or invalid token with 403', async () => {
            req.method = 'POST';
            req.headers['x-credits-grant-token'] = 'wrong-token';
            req.body = { confirm: 'GRANT-CREDITS-25', amount: 25, grantId: 'grant-test-1' };

            await myFunctions.adminGrantCredits(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Forbidden" }));
        });

        test('rejects request with invalid confirm phrase with 400', async () => {
            req.method = 'POST';
            req.headers['x-credits-grant-token'] = 'test-encryption-key-for-jest';
            req.body = { confirm: 'WRONG-PHRASE', amount: 25, grantId: 'grant-test-1' };

            await myFunctions.adminGrantCredits(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Invalid confirm phrase" }));
        });

        test('confirm phrase must name the exact amount (S-11)', async () => {
            req.headers['x-credits-grant-token'] = 'test-encryption-key-for-jest';
            req.body = { confirm: 'GRANT-CREDITS-25', amount: 500, grantId: 'grant-test-1' };

            await myFunctions.adminGrantCredits(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Invalid confirm phrase" }));
        });

        test('requires a grantId', async () => {
            req.headers['x-credits-grant-token'] = 'test-encryption-key-for-jest';
            req.body = { confirm: 'GRANT-CREDITS-25', amount: 25 };

            await myFunctions.adminGrantCredits(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Invalid grantId" }));
        });

        test('rejects request with invalid amount with 400', async () => {
            req.method = 'POST';
            req.headers['x-credits-grant-token'] = 'test-encryption-key-for-jest';
            req.body = { confirm: 'GRANT-CREDITS-25', amount: -5, grantId: 'grant-test-1' };

            await myFunctions.adminGrantCredits(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Invalid amount" }));
        });

        test('successfully executes credit grant when token and payload are valid', async () => {
            req.method = 'POST';
            req.headers['x-credits-grant-token'] = 'test-encryption-key-for-jest';
            req.body = { confirm: 'GRANT-CREDITS-25', amount: 25, dryRun: true, grantId: 'grant-test-1' };

            await myFunctions.adminGrantCredits(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
        });
    });


    // ======================================================================
    // Audit remediation coverage
    // ======================================================================
    describe('audit remediation', () => {
        const validImageData = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64');
        const { deriveKey, encrypt } = require('../utils');
        const testKey = deriveKey('test-encryption-key-for-jest');
        const validEncryptedKey = encrypt('secret_fake_notion_key_value', testKey);
        const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

        const geminiOk = (obj) => ({
            ok: true,
            json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] })
        });
        const morningPage = (extra = {}) => ({
            date: '2025-01-01',
            schedule: [{ time: '9 AM', task: 'Meeting', block: true, reminder: false }],
            todos: [{ task: 'Buy milk', done: false }],
            ...extra
        });
        const useGemini = (obj) => {
            global.fetch.mockImplementation(async (url) => {
                if (String(url).includes('generativelanguage')) return geminiOk(obj);
                return { ok: true, json: async () => ({}) };
            });
        };
        const refundCalls = () => mockUpdate.mock.calls.filter(c => c[0] && (c[0].tierCredits || c[0].boosterCredits));
        const deductionWrites = () => mockSet.mock.calls.filter(c => c[0] && typeof c[0].tierCredits === 'number' && c[0].tierCredits < 10);

        beforeEach(() => {
            // Earlier suites leave rejecting implementations behind; reset them.
            mockTasksInsert.mockReset().mockResolvedValue({});
            mockTasksPatch.mockReset().mockResolvedValue({});
            mockCalendarInsert.mockReset().mockResolvedValue({});
            mockSheetsAppend.mockReset().mockResolvedValue({});
            mockSheetsUpdate.mockReset().mockResolvedValue({});
            mockSheetsBatchUpdate.mockReset().mockResolvedValue({});
            mockSheetsGet.mockReset().mockResolvedValue({ data: { values: [] } });
            mockGet.mockReset();
            req.body = {
                idToken: 'valid-firebase-id-token',
                googleToken: 'valid-google-oauth-token-string',
                syncType: 'morning',
                images: [validImageData]
            };
            _mockGetUserInfo.mockResolvedValue({ data: { email: 'test@example.com' } });
            mockCalendarList.mockResolvedValue({ data: { items: [] } });
            _mockTasksList.mockResolvedValue({ data: { items: [] } });
            mockGet.mockResolvedValue({
                exists: true,
                data: () => ({ tierCredits: 10, boosterCredits: 0, tier: 'free', lastTierCreditRenewalAt: today(), spreadsheetId: 'sheet-1' })
            });
            useGemini(morningPage());
        });

        describe('S-02: transaction retries never leave a phantom refund', () => {
            test('a retried credit transaction that ends in 402 does not refund the earlier attempt', async () => {
                // Attempt 1 reads 1 credit and deducts it, then loses to a concurrent
                // sync; the retry reads 0 credits and rejects with 402.
                let reads = 0;
                mockGet.mockImplementation(async () => {
                    reads += 1;
                    const credits = reads <= 2 ? 1 : 0; // pre-read + attempt 1 see 1 credit
                    return { exists: true, data: () => ({ tierCredits: credits, boosterCredits: 0, tier: 'free', lastTierCreditRenewalAt: today() }) };
                });
                global.__txConflicts = 1;

                await myFunctions.syncPlanner(req, res);

                expect(res.status).toHaveBeenCalledWith(402);
                expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'INSUFFICIENT_CREDITS', creditRefunded: false }));
                expect(refundCalls()).toHaveLength(0);
                // The discarded attempt's deduction was never committed either.
                expect(deductionWrites()).toHaveLength(0);
            });

            test('a retried transaction that succeeds charges exactly once', async () => {
                global.__txConflicts = 1;
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(200);
                expect(res.send.mock.calls[0][0].creditsCharged).toBe(1);
                expect(refundCalls()).toHaveLength(0);
            });
        });

        describe('C4: response shape and idempotency', () => {
            test('success returns text, counts, creditsCharged and warnings', async () => {
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(200);
                const body = res.send.mock.calls[0][0];
                expect(body).toEqual(expect.objectContaining({
                    text: expect.stringContaining('Morning Sync Complete'),
                    counts: { events: 1, reminders: 0, tasks: 1 },
                    creditsCharged: 1,
                    warnings: []
                }));
            });

            test('uses clientRequestId as the syncHistory id and records the result', async () => {
                const id = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
                req.body.clientRequestId = id;
                await myFunctions.syncPlanner(req, res);
                expect(mockHistoryDoc).toHaveBeenCalledWith(id);
                expect(mockHistorySet).toHaveBeenCalledWith(expect.objectContaining({ status: 'processing' }), { merge: true });
                expect(mockHistorySet).toHaveBeenCalledWith(expect.objectContaining({
                    status: 'success',
                    counts: { events: 1, reminders: 0, tasks: 1 },
                    creditsCharged: 1
                }), { merge: true });
            });

            test('a retry with a completed clientRequestId returns the stored result and charges nothing', async () => {
                req.body.clientRequestId = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
                mockHistoryGet.mockResolvedValue({
                    exists: true,
                    data: () => ({ status: 'success', message: 'Morning Sync Complete! Created 1 events', counts: { events: 1 }, warnings: [] })
                });
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(200);
                expect(res.send).toHaveBeenCalledWith({
                    text: 'Morning Sync Complete! Created 1 events',
                    counts: { events: 1 },
                    warnings: [],
                    notes: [],
                    creditsCharged: 0,
                    duplicate: true
                });
                expect(deductionWrites()).toHaveLength(0);
                expect(mockCalendarInsert).not.toHaveBeenCalled();
                expect(global.fetch).not.toHaveBeenCalled();
            });

            test('a retry while the first attempt is still processing gets 409 and no charge', async () => {
                req.body.clientRequestId = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
                mockHistoryGet.mockResolvedValue({ exists: true, data: () => ({ status: 'processing', startedAtMs: Date.now() - 1000 }) });
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(409);
                expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'SYNC_IN_PROGRESS', creditRefunded: false }));
                expect(deductionWrites()).toHaveLength(0);
            });

            test('an invalid clientRequestId is ignored (auto id)', async () => {
                req.body.clientRequestId = 'not-a-uuid';
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(200);
                expect(mockHistoryDoc).not.toHaveBeenCalledWith('not-a-uuid');
            });
        });

        describe('C3 / auth', () => {
            test('email_verified false returns 403 EMAIL_NOT_VERIFIED on syncPlanner', async () => {
                mockVerifyIdToken.mockResolvedValue(verifiedUser({ email_verified: false }));
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(403);
                expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'EMAIL_NOT_VERIFIED' }));
                expect(global.fetch).not.toHaveBeenCalled();
            });

            test.each(['setupNotion', 'setupBYOK', 'updateProfile', 'exportUserData', 'deleteUserAccount', 'refreshStaleStreak'])(
                'email_verified missing returns 403 EMAIL_NOT_VERIFIED on %s', async (endpoint) => {
                    mockVerifyIdToken.mockResolvedValue({ email: 'test@example.com', uid: '123' });
                    req.body = { idToken: 'tok', token: 'tok' };
                    await myFunctions[endpoint](req, res);
                    expect(res.status).toHaveBeenCalledWith(403);
                    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'EMAIL_NOT_VERIFIED' }));
                });

            test('expired Google token returns 401 GOOGLE_TOKEN_EXPIRED before any charge (B-02)', async () => {
                const err = new Error('Request had invalid authentication credentials.');
                err.code = 401;
                _mockGetUserInfo.mockRejectedValue(err);
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(401);
                expect(res.send).toHaveBeenCalledWith(expect.objectContaining({
                    errorCode: 'GOOGLE_TOKEN_EXPIRED',
                    error: 'Your Google connection expired. Reconnect Google to continue.',
                    creditRefunded: false
                }));
                expect(deductionWrites()).toHaveLength(0);
            });

            test('missing googleToken on a morning sync returns 401 GOOGLE_TOKEN_EXPIRED', async () => {
                delete req.body.googleToken;
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(401);
                expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'GOOGLE_TOKEN_EXPIRED' }));
            });

            test('rate limit returns 429 RATE_LIMITED', async () => {
                mockRateLimitGet.mockResolvedValue({ exists: true, data: () => ({ count: 100, windowStart: Date.now() }) });
                await myFunctions.updateProfile(req, res);
                expect(res.status).toHaveBeenCalledWith(429);
                expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'RATE_LIMITED' }));
            });

            test('plan limit returns 403 PLAN_LIMIT and insufficient credits 402', async () => {
                req.body.images = [validImageData, validImageData];
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(403);
                expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'PLAN_LIMIT', creditRefunded: false }));
            });
        });

        describe('REQUIRE_APP_CHECK=true (flag on)', () => {
            beforeEach(() => { global.__params = { REQUIRE_APP_CHECK: 'true' }; });

            test('rejects a request without an App Check token', async () => {
                await myFunctions.updateProfile(req, res);
                expect(res.status).toHaveBeenCalledWith(401);
                expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'AUTH_INVALID' }));
                expect(mockVerifyIdToken).not.toHaveBeenCalled();
            });

            test('rejects an invalid App Check token', async () => {
                req.headers['x-firebase-appcheck'] = 'bad';
                mockVerifyAppCheckToken.mockRejectedValue(new Error('bad token'));
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(401);
            });

            // Every HTTP export, with a request that gets past method/content-type/body
            // pre-checks, so the only thing that can stop it is App Check.
            const appCheckCases = {
                updateProfile: () => ({ body: { idToken: 'tok', updates: {} } }),
                refreshStaleStreak: () => ({ body: { idToken: 'tok' } }),
                setupNotion: () => ({ body: { idToken: 'tok', action: 'delete' } }),
                setupBYOK: () => ({ body: { idToken: 'tok', action: 'delete' } }),
                byokSession: () => ({ body: { idToken: 'tok', apiKey: 'sk-abcdefghijklmnopqrstuvwxyz' } }),
                byokSessionDelete: () => ({ fn: 'byokSession', method: 'DELETE', body: {} }),
                exportUserData: () => ({ body: { token: 'tok' } }),
                deleteUserAccount: () => ({ body: { token: 'tok' } }),
                syncPlanner: () => ({ body: { idToken: 'tok', syncType: 'morning', images: [] } }),
                logClientError: () => ({ body: { message: 'boom' } }),
                createCashfreeOrder: () => ({ body: { idToken: 'tok', price: 19, phone: '9876543210' } }),
                adminGrantCredits: () => ({ body: { grantId: 'grant-abc-1', amount: 25, confirm: 'GRANT-CREDITS-25' } }),
            };
            const NOT_HTTP_OR_EXEMPT = ['cashfreeWebhook', 'reconcileStuckSyncs'];
            const TEST_ONLY = ['applyGamificationMilestones', 'runGamificationAfterSync', 'needsTierCreditRenewal', 'calendarDayDiff',
                'checkFeaturesAndCredits', 'computePurchaseGrant', 'computeEntitlementRevocation', 'buildNewUserDoc'];

            test('every exported endpoint is classified (new endpoints must join this audit)', () => {
                const covered = new Set([...Object.keys(appCheckCases).map(k => appCheckCases[k]().fn || k), ...NOT_HTTP_OR_EXEMPT, ...TEST_ONLY]);
                expect(Object.keys(myFunctions).filter(name => !covered.has(name))).toEqual([]);
            });

            test.each(Object.keys(appCheckCases))('%s rejects a request without an App Check token (401)', async (name) => {
                const { fn = name, method = 'POST', body } = appCheckCases[name]();
                req.method = method;
                req.body = body;
                await myFunctions[fn](req, res);
                expect(res.status).toHaveBeenCalledWith(401);
                expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: 'App Check token required.', errorCode: 'AUTH_INVALID' }));
                expect(mockVerifyIdToken).not.toHaveBeenCalled();
            });

            test.each(Object.keys(appCheckCases))('%s verifies a supplied App Check token before anything else', async (name) => {
                const { fn = name, method = 'POST', body } = appCheckCases[name]();
                req.method = method;
                req.body = body;
                req.headers['x-firebase-appcheck'] = 'forged';
                mockVerifyAppCheckToken.mockRejectedValue(new Error('bad token'));
                await myFunctions[fn](req, res);
                expect(mockVerifyAppCheckToken).toHaveBeenCalledWith('forged');
                expect(res.status).toHaveBeenCalledWith(401);
                expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: 'App Check verification failed.' }));
            });

            test.each(Object.keys(appCheckCases).filter(n => n !== 'adminGrantCredits' && n !== 'byokSessionDelete'))(
                '%s answers the CORS preflight (OPTIONS) without App Check', async (name) => {
                    const { fn = name } = appCheckCases[name]();
                    req.method = 'OPTIONS';
                    req.headers.origin = 'https://planner.analogdigital.tech';
                    req.body = undefined;
                    await myFunctions[fn](req, res);
                    expect(res.status).toHaveBeenCalledWith(204);
                    expect(mockVerifyAppCheckToken).not.toHaveBeenCalled();
                });

            test('cashfreeWebhook never requires App Check (server-to-server)', async () => {
                req.rawBody = Buffer.from('{}');
                req.body = {};
                await myFunctions.cashfreeWebhook(req, res);
                expect(mockVerifyAppCheckToken).not.toHaveBeenCalled();
                expect(res.send).not.toHaveBeenCalledWith(expect.objectContaining({ error: 'App Check token required.' }));
                expect(res.status).not.toHaveBeenCalledWith(401); // it reaches its own config/signature checks
            });

            test('adminGrantCredits with a valid App Check token proceeds to its own grant-token check', async () => {
                req.headers['x-firebase-appcheck'] = 'good';
                mockVerifyAppCheckToken.mockResolvedValue({ appId: 'app' });
                req.body = appCheckCases.adminGrantCredits().body;
                await myFunctions.adminGrantCredits(req, res);
                expect(res.status).toHaveBeenCalledWith(403);
            });

            test('accepts a valid App Check token', async () => {
                req.headers['x-firebase-appcheck'] = 'good';
                mockVerifyAppCheckToken.mockResolvedValue({ appId: 'app' });
                req.body = { idToken: 'tok', updates: { displayName: 'Sam' } };
                await myFunctions.updateProfile(req, res);
                expect(mockVerifyAppCheckToken).toHaveBeenCalledWith('good');
                expect(res.status).toHaveBeenCalledWith(200);
            });
        });

        describe('C5 CORS', () => {
            test('allowed origin gets ACAO but never Allow-Credentials', async () => {
                req.headers.origin = 'https://planner.analogdigital.tech';
                await myFunctions.syncPlanner(req, res);
                expect(res.set).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'https://planner.analogdigital.tech');
                expect(res.set).not.toHaveBeenCalledWith('Access-Control-Allow-Credentials', expect.anything());
            });

            test.each([
                ['staging', 'https://planner.analogdigital.tech'],
                ['staging', 'https://ai-planner-project-467800.web.app'],
                ['production', 'https://staging-planner.analogdigital.tech'],
                ['production', 'https://ai-planner-staging.web.app'],
                ['', 'https://ai-planner-staging.web.app'],
                ['', 'http://localhost:5000'],
            ])('APP_ENVIRONMENT=%j rejects origin %s with 403 ORIGIN_NOT_ALLOWED (round 3)', async (environment, origin) => {
                global.__params.APP_ENVIRONMENT = environment;
                req.headers.origin = origin;
                await myFunctions.updateProfile(req, res);
                expect(res.status).toHaveBeenCalledWith(403);
                expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'ORIGIN_NOT_ALLOWED' }));
                expect(mockVerifyIdToken).not.toHaveBeenCalled();
            });

            test.each([
                ['staging', 'https://ai-planner-staging.web.app'],
                ['staging', 'http://localhost:5000'],
                ['production', 'https://planner.analogdigital.tech'],
                ['', 'https://planner.analogdigital.tech'],
            ])('APP_ENVIRONMENT=%j accepts its own origin %s', async (environment, origin) => {
                global.__params.APP_ENVIRONMENT = environment;
                req.headers.origin = origin;
                req.method = 'OPTIONS';
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(204);
                expect(res.set).toHaveBeenCalledWith('Access-Control-Allow-Origin', origin);
            });

            test('handlers open the FIRESTORE_DATABASE_ID database', async () => {
                global.__params.FIRESTORE_DATABASE_ID = 'staging';
                const adminBacking = require('mock-firebase-admin-backing');
                adminBacking.firestore.mockClear();
                req.body = { idToken: 'tok', updates: { displayName: 'Sam' } };
                await myFunctions.updateProfile(req, res);
                expect(res.status).toHaveBeenCalledWith(200);
                expect(adminBacking.firestore.mock.calls.length).toBeGreaterThan(0);
                expect(adminBacking.firestore.mock.calls.every(args => args[1] === 'staging')).toBe(true);
            });

            test('preflight advertises the X-BYOK-* headers', async () => {
                req.method = 'OPTIONS';
                req.headers.origin = 'https://ai-planner-project-467800.web.app';
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(204);
                const allowHeaders = res.set.mock.calls.find(c => c[0] === 'Access-Control-Allow-Headers')[1];
                expect(allowHeaders).toContain('X-BYOK-Token');
                expect(allowHeaders).toContain('X-Firebase-AppCheck');
            });
        });

        describe('C6: updateProfile', () => {
            test('creates the user document with full Free defaults when missing', async () => {
                mockGet.mockResolvedValue({ exists: false, data: () => undefined });
                req.body = { idToken: 'tok', updates: { displayName: '  Sam  ', timeZone: 'UTC' } };
                await myFunctions.updateProfile(req, res);
                expect(res.status).toHaveBeenCalledWith(200);
                expect(res.send).toHaveBeenCalledWith({ success: true, created: true });
                const created = mockSet.mock.calls[0][0];
                expect(created).toEqual(expect.objectContaining({
                    tier: 'free', tierCredits: 15, boosterCredits: 0,
                    currentStreak: 0, highestStreak: 0, streakFreezes: 0, lastAwardedStreak: 0,
                    timeZone: 'UTC', displayName: 'Sam',
                    lastTierCreditRenewalAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)
                }));
            });

            test('creates defaults even with no updates', async () => {
                mockGet.mockResolvedValue({ exists: false, data: () => undefined });
                req.body = { idToken: 'tok' };
                await myFunctions.updateProfile(req, res);
                expect(res.status).toHaveBeenCalledWith(200);
                expect(mockSet.mock.calls[0][0]).toEqual(expect.objectContaining({ tierCredits: 15, timeZone: 'Asia/Kolkata' }));
            });

            test('merges only allowed fields into an existing profile', async () => {
                mockGet.mockResolvedValue({ exists: true, data: () => ({ tierCredits: 3 }) });
                req.body = { idToken: 'tok', updates: { dedupTasks: false, tierCredits: 9999, timeZone: 'Asia/Kolkata' } };
                await myFunctions.updateProfile(req, res);
                expect(res.send).toHaveBeenCalledWith({ success: true, created: false });
                expect(mockSet).toHaveBeenCalledWith({ dedupTasks: false, timeZone: 'Asia/Kolkata' }, { merge: true });
            });

            test('B-09: unknown time zones are ignored, valid ones Intl reports are kept', async () => {
                mockGet.mockResolvedValue({ exists: true, data: () => ({}) });
                req.body = { idToken: 'tok', updates: { timeZone: 'Mars/Olympus_Mons', displayName: 'A' } };
                await myFunctions.updateProfile(req, res);
                expect(mockSet).toHaveBeenCalledWith({ displayName: 'A' }, { merge: true });
            });

            test('rejects invalid display names', async () => {
                req.body = { idToken: 'tok', updates: { displayName: 42 } };
                await myFunctions.updateProfile(req, res);
                expect(res.status).toHaveBeenCalledWith(400);
                expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'BAD_REQUEST' }));
            });

            test.each(['drive', 'notion'])('saves notesDestination "%s" (Notion may be chosen before it is connected)', async (destination) => {
                mockGet.mockResolvedValue({ exists: true, data: () => ({}) });
                req.body = { idToken: 'tok', updates: { notesDestination: destination } };
                await myFunctions.updateProfile(req, res);
                expect(res.status).toHaveBeenCalledWith(200);
                expect(mockSet).toHaveBeenCalledWith({ notesDestination: destination }, { merge: true });
            });

            test.each(['dropbox', 'Drive', 42, null])('rejects notesDestination %j', async (destination) => {
                req.body = { idToken: 'tok', updates: { notesDestination: destination } };
                await myFunctions.updateProfile(req, res);
                expect(res.status).toHaveBeenCalledWith(400);
                expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'BAD_REQUEST', error: 'Choose Google Drive or Notion.' }));
                expect(mockSet).not.toHaveBeenCalled();
            });
        });

        describe('notes destination: journal, voice notes and brain dumps to Google Drive or Notion', () => {
            const freeUser = (extra = {}) => ({ tierCredits: 10, boosterCredits: 0, tier: 'free', lastTierCreditRenewalAt: today(), spreadsheetId: 'sheet-1', ...extra });
            const useUser = (data) => mockGet.mockResolvedValue({ exists: true, data: () => data });
            const driveCreates = () => mockDriveCreate.mock.calls.map(([arg]) => ({
                name: arg.requestBody.name,
                mimeType: arg.requestBody.mimeType || arg.media?.mimeType,
                parent: arg.requestBody.parents[0],
                body: typeof arg.media?.body === 'string' ? arg.media.body : undefined,
            }));
            const FOLDER = 'application/vnd.google-apps.folder';
            const DOC = 'application/vnd.google-apps.document';
            const audioData = 'data:audio/webm;base64,' + Buffer.from('fake-audio-bytes').toString('base64');

            beforeEach(() => {
                mockDriveList.mockReset().mockResolvedValue({ data: { files: [] } });
                mockDriveGet.mockReset().mockResolvedValue({ data: { id: 'cached', trashed: false } });
                mockDriveUpdate.mockClear();
                mockNotionPagesCreate.mockClear();
            });

            // Drive accepts the uploads but fails to write the Google Doc.
            const failDocWrites = () => {
                const upload = mockDriveCreate.getMockImplementation();
                mockDriveCreate.mockImplementation(async (arg) => {
                    if (arg.requestBody.mimeType === DOC) throw Object.assign(new Error('Drive backend error'), { code: 500 });
                    return upload(arg);
                });
                return () => mockDriveCreate.mockImplementation(upload);
            };
            const uploadedPhotoIds = async () => {
                const ids = [];
                for (const [i, [arg]] of mockDriveCreate.mock.calls.entries()) {
                    if (arg.media?.mimeType === 'image/jpeg') ids.push((await mockDriveCreate.mock.results[i].value).data.id);
                }
                return ids;
            };

            test('journal goes to Google Drive by default when Notion is not connected (no Notion needed)', async () => {
                req.body.syncType = 'journal';
                useUser(freeUser());
                useGemini({ date: '15-January-2025' });

                await myFunctions.syncPlanner(req, res);

                expect(res.status).toHaveBeenCalledWith(200);
                expect(_mockGetUserInfo).toHaveBeenCalled();
                expect(mockNotionPagesCreate).not.toHaveBeenCalled();
                const created = driveCreates();
                expect(created.slice(0, 2)).toEqual([
                    expect.objectContaining({ name: 'AI Planner', mimeType: FOLDER, parent: 'root' }),
                    expect.objectContaining({ name: 'Journal', mimeType: FOLDER }),
                ]);
                const journalFolder = mockDriveCreate.mock.results[1].value;
                const folderId = (await journalFolder).data.id;
                expect(created[2]).toEqual(expect.objectContaining({ name: '2025-01-15 Journal 1.jpg', mimeType: 'image/jpeg', parent: folderId }));
                expect(created).toHaveLength(3); // free plan: no transcription, so no Doc

                const body = res.send.mock.calls[0][0];
                expect(body).toEqual(expect.objectContaining({
                    counts: { journalPages: 1 },
                    savedTo: 'drive',
                    links: { drive: `https://drive.google.com/drive/folders/${folderId}` },
                    notes: [],
                    creditsCharged: 1,
                }));
                expect(mockSet).toHaveBeenCalledWith({ driveFolders: { root: expect.any(String), journal: folderId } }, { merge: true });
                expect(mockHistorySet).toHaveBeenCalledWith(expect.objectContaining({
                    status: 'success', savedTo: 'drive', links: body.links, notes: []
                }), { merge: true });
            });

            test('journal to Drive needs the Google token: 401 before any charge, nothing written', async () => {
                req.body.syncType = 'journal';
                delete req.body.googleToken;
                useUser(freeUser());

                await myFunctions.syncPlanner(req, res);

                expect(res.status).toHaveBeenCalledWith(401);
                expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'GOOGLE_TOKEN_EXPIRED', creditRefunded: false }));
                expect(deductionWrites()).toHaveLength(0);
                expect(mockDriveCreate).not.toHaveBeenCalled();
            });

            test('Pro journal to Drive saves the transcription as a Google Doc linking every photo', async () => {
                req.body.syncType = 'journal';
                req.body.images = [validImageData, validImageData];
                useUser(freeUser({ tier: 'pro' }));
                useGemini({ date: '2025-03-04', transcription: 'Dear diary.\nA good day.' });

                await myFunctions.syncPlanner(req, res);

                expect(res.status).toHaveBeenCalledWith(200);
                const created = driveCreates();
                const photos = created.filter(c => c.mimeType === 'image/jpeg');
                expect(photos.map(p => p.name)).toEqual(['2025-03-04 Journal 1.jpg', '2025-03-04 Journal 2.jpg']);
                const doc = created.find(c => c.mimeType === DOC);
                expect(doc.name).toBe('2025-03-04 Journal');
                expect(doc.body).toMatch(/^Dear diary\.\nA good day\.\n\nPhotos:\nhttps:\/\/drive\.google\.com\/file\/d\/drive-\d+\/view\nhttps:\/\/drive\.google\.com\/file\/d\/drive-\d+\/view$/);
                const body = res.send.mock.calls[0][0];
                expect(body.counts).toEqual({ journalPages: 2 });
                expect(body.notes).toEqual(['The transcription was saved as a Google Doc next to it.']);
                expect(mockDriveUpdate).not.toHaveBeenCalled();
            });

            test('when the journal Doc cannot be written, its photos go to the Drive trash so a retry does not duplicate them', async () => {
                req.body.syncType = 'journal';
                req.body.images = [validImageData, validImageData];
                useUser(freeUser({ tier: 'pro' }));
                useGemini({ date: '2025-03-04', transcription: 'Dear diary.' });
                const restore = failDocWrites();
                try {
                    await myFunctions.syncPlanner(req, res);
                } finally {
                    restore();
                }

                expect(res.status).not.toHaveBeenCalledWith(200);
                const photoIds = await uploadedPhotoIds();
                expect(photoIds).toHaveLength(2);
                expect(mockDriveUpdate.mock.calls.map(([arg]) => arg)).toEqual(
                    photoIds.map(fileId => ({ fileId, requestBody: { trashed: true } })));
            });

            test('a journal the AI could not read is still saved to Drive with a warning', async () => {
                req.body.syncType = 'journal';
                useUser(freeUser({ tier: 'pro' }));
                global.fetch.mockImplementation(async (url) => {
                    if (String(url).includes('generativelanguage')) return { ok: false, status: 503, text: async () => 'overloaded' };
                    return { ok: true, json: async () => ({}) };
                });

                await myFunctions.syncPlanner(req, res);

                expect(res.status).toHaveBeenCalledWith(200);
                const body = res.send.mock.calls[0][0];
                expect(body.warnings).toContain("We couldn't read this page, so it was saved to Google Drive with today's date and no transcription.");
                expect(driveCreates().filter(c => c.mimeType === DOC)).toHaveLength(0);
                expect(driveCreates().find(c => c.mimeType === 'image/jpeg').name).toBe(`${today()} Journal 1.jpg`);
            });

            test('an explicit Drive choice wins over a connected Notion', async () => {
                req.body.syncType = 'journal';
                useUser(freeUser({ notionKey: validEncryptedKey, notionDbId: 'db-1', notesDestination: 'drive' }));
                useGemini({ date: '2025-01-15' });

                await myFunctions.syncPlanner(req, res);

                expect(res.status).toHaveBeenCalledWith(200);
                expect(res.send.mock.calls[0][0].savedTo).toBe('drive');
                expect(mockNotionPagesCreate).not.toHaveBeenCalled();
            });

            test('journal to a connected Notion is unchanged and reports savedTo "notion" (no Google token needed)', async () => {
                req.body.syncType = 'journal';
                delete req.body.googleToken;
                useUser(freeUser({ notionKey: validEncryptedKey, notionDbId: 'db-1' }));
                useGemini({ date: '15-January-2025' });

                await myFunctions.syncPlanner(req, res);

                expect(res.status).toHaveBeenCalledWith(200);
                expect(mockNotionPagesCreate).toHaveBeenCalled();
                expect(mockDriveCreate).not.toHaveBeenCalled();
                expect(_mockGetUserInfo).not.toHaveBeenCalled();
                expect(res.send.mock.calls[0][0]).toEqual(expect.objectContaining({ savedTo: 'notion', counts: { journalPages: 1 }, notes: [] }));
            });

            test('voice note to Drive: the recording plus a transcript Doc, counted as a voice note', async () => {
                req.body.syncType = 'voice_note';
                req.body.images = [audioData];
                useUser(freeUser({ tier: 'pro' }));
                useGemini({ transcription: 'Call the plumber.' });

                await myFunctions.syncPlanner(req, res);

                expect(res.status).toHaveBeenCalledWith(200);
                const created = driveCreates();
                expect(created.map(c => c.name)).toEqual([
                    'AI Planner', 'Voice notes', `${today()} Voice note.webm`, `${today()} Voice note`,
                ]);
                expect(created[3].body).toMatch(/^Call the plumber\.\n\nRecording:\nhttps:\/\/drive\.google\.com\/file\/d\//);
                expect(res.send.mock.calls[0][0]).toEqual(expect.objectContaining({ counts: { voiceNotes: 1 }, savedTo: 'drive' }));
            });

            test('evening brain dump goes to Drive (Doc + page photo) when Notion is not connected', async () => {
                req.body.syncType = 'evening';
                useUser(freeUser());
                useGemini({ date: '2025-01-01', todos: [], expenses: [{ item: 'Food', amount: 10 }], health: {}, brainDump: 'Call mum.\nBook tickets.' });

                await myFunctions.syncPlanner(req, res);

                expect(res.status).toHaveBeenCalledWith(200);
                const created = driveCreates();
                expect(created.map(c => c.name)).toEqual([
                    'AI Planner', 'Brain dumps', '2025-01-01 Brain dump.jpg', '2025-01-01 Brain dump',
                ]);
                expect(created[3]).toEqual(expect.objectContaining({ mimeType: DOC }));
                expect(created[3].body).toMatch(/^Call mum\.\nBook tickets\.\n\nPhoto: https:\/\/drive\.google\.com\/file\/d\//);
                const body = res.send.mock.calls[0][0];
                expect(body.counts).toEqual({ completedTasks: 0, expenses: 1, health: 0, brainDump: 1 });
                expect(body.notes).toEqual(['Brain dump saved to Google Drive.']);
                expect(body.savedTo).toBe('drive');
                expect(body.links.drive).toMatch(/^https:\/\/drive\.google\.com\/drive\/folders\/drive-\d+$/);
                expect(mockNotionPagesCreate).not.toHaveBeenCalled();
            });

            test('an evening page without a brain dump writes nothing to Drive and adds no note', async () => {
                req.body.syncType = 'evening';
                useUser(freeUser());
                useGemini({ date: '2025-01-01', todos: [], expenses: [{ item: 'Food', amount: 10 }], health: {} });

                await myFunctions.syncPlanner(req, res);

                expect(res.status).toHaveBeenCalledWith(200);
                expect(mockDriveCreate).not.toHaveBeenCalled();
                const body = res.send.mock.calls[0][0];
                expect(body.notes).toEqual([]);
                expect(body.savedTo).toBeUndefined();
                expect(body.counts.brainDump).toBeUndefined();
            });

            test('a brain dump already saved for that date is not written twice', async () => {
                req.body.syncType = 'evening';
                useUser(freeUser({ driveFolders: { root: 'root-1', brainDump: 'bd-1' } }));
                useGemini({ date: '2025-01-01', todos: [], expenses: [{ item: 'Food', amount: 10 }], health: {}, brainDump: 'Again.' });
                mockDriveList.mockImplementation(async ({ q }) => ({
                    data: { files: q.includes("name = '2025-01-01 Brain dump'") && q.includes("'bd-1' in parents") ? [{ id: 'doc-1' }] : [] }
                }));

                await myFunctions.syncPlanner(req, res);

                expect(res.status).toHaveBeenCalledWith(200);
                expect(mockDriveCreate).not.toHaveBeenCalled();
                const body = res.send.mock.calls[0][0];
                expect(body.notes).toEqual(['Brain dump for this date was already saved to Google Drive.']);
                expect(body.counts.brainDump).toBeUndefined();
                expect(body.links).toEqual({ drive: 'https://drive.google.com/drive/folders/bd-1' });
            });

            test('a Drive failure on the brain dump is reported, the rest is kept and charged', async () => {
                req.body.syncType = 'evening';
                useUser(freeUser());
                useGemini({ date: '2025-01-01', todos: [], expenses: [{ item: 'Food', amount: 10 }], health: {}, brainDump: 'Ideas.' });
                mockDriveCreate.mockRejectedValueOnce(Object.assign(new Error('Drive quota exceeded'), { code: 403 }));

                await myFunctions.syncPlanner(req, res);

                expect(res.status).toHaveBeenCalledWith(200);
                const body = res.send.mock.calls[0][0];
                expect(body.warnings).toEqual(expect.arrayContaining(['Could not sync: Google Drive. Everything else was saved.']));
                expect(body.creditsCharged).toBe(1);
                expect(body.savedTo).toBeUndefined();
            });

            test('when the brain-dump Doc cannot be written, its photo goes to the Drive trash', async () => {
                req.body.syncType = 'evening';
                useUser(freeUser());
                useGemini({ date: '2025-01-01', todos: [], expenses: [{ item: 'Food', amount: 10 }], health: {}, brainDump: 'Ideas.' });
                const restore = failDocWrites();
                try {
                    await myFunctions.syncPlanner(req, res);
                } finally {
                    restore();
                }

                expect(res.status).toHaveBeenCalledWith(200);
                expect(res.send.mock.calls[0][0].warnings).toEqual(expect.arrayContaining(['Could not sync: Google Drive. Everything else was saved.']));
                const [photoId] = await uploadedPhotoIds();
                expect(mockDriveUpdate).toHaveBeenCalledWith({ fileId: photoId, requestBody: { trashed: true } });
                expect(mockDriveUpdate).toHaveBeenCalledTimes(1);
            });

            test('evening with a connected Notion keeps the brain dump in Notion', async () => {
                req.body.syncType = 'evening';
                useUser(freeUser({ notionKey: validEncryptedKey, notionDbId: 'db-1' }));
                useGemini({ date: '2025-01-01', todos: [], expenses: [], health: {}, brainDump: 'Notion please.' });
                global.fetch.mockImplementation(async (url) => {
                    if (String(url).includes('generativelanguage')) {
                        return geminiOk({ date: '2025-01-01', todos: [], expenses: [], health: {}, brainDump: 'Notion please.' });
                    }
                    return {
                        ok: true,
                        text: async () => JSON.stringify({ id: 'file-upload-123', upload_url: 'https://s3.example/fake' }),
                        json: async () => ({ id: 'file-upload-123', upload_url: 'https://s3.example/fake' }),
                    };
                });

                await myFunctions.syncPlanner(req, res);

                expect(res.status).toHaveBeenCalledWith(200);
                expect(mockNotionPagesCreate).toHaveBeenCalled();
                expect(mockDriveCreate).not.toHaveBeenCalled();
                const body = res.send.mock.calls[0][0];
                expect(body.savedTo).toBe('notion');
                expect(body.counts.brainDump).toBe(1);
                expect(body.notes).toEqual(['Brain dump saved to Notion.']);
            });

            test('morning lists the events and tasks it created', async () => {
                useUser(freeUser());
                useGemini(morningPage({ todos: [{ task: 'Buy milk', done: false }, { task: 'Call bank', done: false }] }));

                await myFunctions.syncPlanner(req, res);

                expect(res.status).toHaveBeenCalledWith(200);
                expect(res.send.mock.calls[0][0].items).toEqual({
                    events: [{ title: 'Meeting', start: '2025-01-01T09:00:00' }],
                    tasks: ['Buy milk', 'Call bank'],
                });
            });

            test('morning notes the duplicates it skipped', async () => {
                useUser(freeUser());
                useGemini(morningPage());
                _mockTasksList.mockResolvedValue({ data: { items: [{ title: 'Buy milk', due: '2025-01-01T00:00:00.000Z' }] } });

                await myFunctions.syncPlanner(req, res);

                const body = res.send.mock.calls[0][0];
                expect(body.items.tasks).toEqual([]);
                expect(body.notes).toEqual(['Skipped 1 task already in your calendar or task list.']);
            });

            test('morning keeps event and task titles out of the stored history (privacy policy: Zero Storage)', async () => {
                req.body.clientRequestId = '7a2d4c6e-8f10-4b32-9c54-a6b8c0d2e4f6';
                useUser(freeUser());
                useGemini(morningPage({ todos: [{ task: 'Buy milk', done: false }] }));

                await myFunctions.syncPlanner(req, res);

                expect(res.send.mock.calls[0][0].items.tasks).toEqual(['Buy milk']);
                const writes = mockHistorySet.mock.calls.map(c => c[0]);
                expect(writes.some(w => w.status === 'success')).toBe(true);
                writes.forEach(w => expect(w).not.toHaveProperty('items'));
            });

            test('a retried request replays savedTo, links and notes from history', async () => {
                req.body.clientRequestId = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
                mockHistoryGet.mockResolvedValue({
                    exists: true,
                    data: () => ({
                        status: 'success', message: 'Journal saved to Google Drive.', counts: { journalPages: 1 }, warnings: [],
                        notes: ['n'], savedTo: 'drive', links: { drive: 'https://drive.google.com/drive/folders/f1' },
                    })
                });

                await myFunctions.syncPlanner(req, res);

                expect(res.send).toHaveBeenCalledWith({
                    text: 'Journal saved to Google Drive.',
                    counts: { journalPages: 1 },
                    warnings: [],
                    notes: ['n'],
                    savedTo: 'drive',
                    links: { drive: 'https://drive.google.com/drive/folders/f1' },
                    creditsCharged: 0,
                    duplicate: true,
                });
            });
        });

        describe('B-23: refreshStaleStreak', () => {
            test('resets a lapsed streak inside a transaction', async () => {
                mockGet.mockResolvedValue({ exists: true, data: () => ({ currentStreak: 5, streakFreezes: 0, lastSyncDate: '2020-01-01', timeZone: 'UTC' }) });
                req.body = { idToken: 'tok' };
                await myFunctions.refreshStaleStreak(req, res);
                expect(res.send).toHaveBeenCalledWith({ refreshed: true, currentStreak: 0 });
                expect(mockSet).toHaveBeenCalledWith({ currentStreak: 0, lastAwardedStreak: 0 }, { merge: true });
            });

            test('keeps an active streak (ISO lastSyncDate is normalised)', async () => {
                mockGet.mockResolvedValue({ exists: true, data: () => ({ currentStreak: 4, lastSyncDate: new Date().toISOString(), timeZone: 'UTC' }) });
                req.body = { idToken: 'tok' };
                await myFunctions.refreshStaleStreak(req, res);
                expect(res.send).toHaveBeenCalledWith({ refreshed: false, currentStreak: 4 });
                expect(mockSet).not.toHaveBeenCalled();
            });

            test('returns 0 for a missing profile', async () => {
                mockGet.mockResolvedValue({ exists: false });
                req.body = { idToken: 'tok' };
                await myFunctions.refreshStaleStreak(req, res);
                expect(res.send).toHaveBeenCalledWith({ refreshed: false, currentStreak: 0 });
            });
        });

        describe('B-09: timezone handling in syncPlanner', () => {
            test.each(['UTC', 'Etc/UTC', 'Asia/Kolkata', 'Europe/Kyiv'])('accepts %s', async (tz) => {
                req.body.timeZone = tz;
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(200);
                expect(mockSet.mock.calls.find(c => c[0] && c[0].timeZone === tz)).toBeDefined();
            });

            test('falls back for an invalid zone', async () => {
                req.body.timeZone = 'Not/AZone';
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(200);
                expect(mockSet.mock.calls.find(c => c[0] && c[0].timeZone === 'Not/AZone')).toBeUndefined();
            });
        });

        describe('refund policy (B-07, B-08, B-12, UX #4)', () => {
            test('journal to Notion without a Notion connection fails before any credit is deducted', async () => {
                req.body.syncType = 'journal';
                mockGet.mockResolvedValue({
                    exists: true,
                    data: () => ({ tierCredits: 10, boosterCredits: 0, tier: 'free', lastTierCreditRenewalAt: today(), notesDestination: 'notion' })
                });
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(400);
                expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'NOTION_NOT_CONFIGURED', creditRefunded: false }));
                expect(deductionWrites()).toHaveLength(0);
                expect(global.fetch).not.toHaveBeenCalled();
            });

            test('server-side Gemini misconfiguration refunds and returns 502', async () => {
                global.fetch.mockImplementation(async (url) => {
                    if (String(url).includes('generativelanguage')) {
                        return { ok: false, status: 400, text: async () => '{"error":{"status":"INVALID_ARGUMENT","message":"API key not valid. Please pass a valid API key.","details":[{"reason":"API_KEY_INVALID"}]}}' };
                    }
                    return { ok: true, json: async () => ({}) };
                });
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(502);
                expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'AI_UNAVAILABLE', creditRefunded: true }));
                expect(refundCalls()).toHaveLength(1);
            });

            test('the Gemini key is sent as a header, never in the URL (S-06)', async () => {
                await myFunctions.syncPlanner(req, res);
                const call = global.fetch.mock.calls.find(c => String(c[0]).includes('generativelanguage'));
                expect(call[0]).not.toContain('key=');
                expect(call[1].headers['x-goog-api-key']).toBe('test-encryption-key-for-jest');
            });

            test('count mismatch syncs anyway with a warning', async () => {
                useGemini(morningPage({ totals: { blocks: 3, reminders: null, todos: 1 } }));
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(200);
                const body = res.send.mock.calls[0][0];
                expect(body.warnings).toEqual([expect.stringContaining('3 blocked events but we found 1')]);
                expect(body.creditsCharged).toBe(1);
            });

            test('absent totals skip the count check', async () => {
                useGemini(morningPage({ totals: { blocks: null, reminders: null, todos: null } }));
                await myFunctions.syncPlanner(req, res);
                expect(res.send.mock.calls[0][0].warnings).toEqual([]);
            });

            test('an AI "error" with extracted data is downgraded to a warning', async () => {
                useGemini(morningPage({ error: 'I counted 7 blocked events, but the planner says 8.' }));
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(200);
                expect(res.send.mock.calls[0][0].warnings[0]).toContain('I counted 7 blocked events');
            });

            test('a morning sync that creates nothing is refunded', async () => {
                useGemini({ date: '2025-01-01', schedule: [], todos: [] });
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(200);
                const body = res.send.mock.calls[0][0];
                expect(body.creditsCharged).toBe(0);
                expect(body.warnings).toContain('Nothing new was found to sync, so no credit was used.');
                expect(refundCalls()).toHaveLength(1);
            });

            test('evening partial failure keeps the credit when something synced', async () => {
                req.body.syncType = 'evening';
                useGemini({ date: '2025-01-01', todos: [{ task: 'Buy milk', done: true }], expenses: [{ item: 'Coffee', amount: 5 }], health: {} });
                _mockTasksList.mockResolvedValue({ data: { items: [{ id: 't1', title: 'Buy milk' }] } });
                mockSheetsAppend.mockRejectedValue(new Error('Sheets down'));
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(200);
                const body = res.send.mock.calls[0][0];
                expect(body.text).toContain('Could not sync: Expenses');
                expect(body.text).toContain('Everything else was saved');
                expect(body.creditsCharged).toBe(1);
                expect(refundCalls()).toHaveLength(0);
            });

            test('B-12: a deleted spreadsheet is recreated and the rows are written', async () => {
                req.body.syncType = 'evening';
                useGemini({ date: '2025-01-01', todos: [], expenses: [{ item: 'Coffee', amount: 5 }], health: {} });
                const notFound = Object.assign(new Error('Requested entity was not found.'), { code: 404 });
                mockSheetsGet.mockRejectedValueOnce(notFound);
                _mockSheetsCreate.mockResolvedValue({ data: { spreadsheetId: 'new-sheet' } });
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(200);
                expect(mockSet).toHaveBeenCalledWith({ spreadsheetId: 'mockDelete' }, { merge: true });
                expect(mockSet).toHaveBeenCalledWith({ spreadsheetId: 'new-sheet' }, { merge: true });
                expect(mockSheetsAppend).toHaveBeenCalledWith(expect.objectContaining({ spreadsheetId: 'new-sheet' }));
                expect(res.send.mock.calls[0][0].counts.expenses).toBe(1);
            });

            test('B-11: a task without a title does not fail the evening sync', async () => {
                req.body.syncType = 'evening';
                useGemini({ date: '2025-01-01', todos: [{ task: 'Buy milk', done: true }], expenses: [], health: {} });
                _mockTasksList.mockResolvedValue({ data: { items: [{ id: 'x' }, { id: 't1', title: 'Buy milk', due: '2025-01-01T00:00:00.000Z' }, { id: 't2', title: 'Buy milk', due: '2024-12-01T00:00:00.000Z' }] } });
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(200);
                expect(mockTasksPatch).toHaveBeenCalledTimes(1);
                expect(mockTasksPatch).toHaveBeenCalledWith(expect.objectContaining({ task: 't1' }));
            });
        });

        describe('BYOK (C1, B-13, B-14, S-19)', () => {
            test('a junk X-BYOK-Token header is rejected with 400 BYOK_INVALID and no charge', async () => {
                req.headers['x-byok-token'] = 'short';
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(400);
                expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'BYOK_INVALID', creditRefunded: false }));
                expect(deductionWrites()).toHaveLength(0);
            });

            test('BYOK headers without a key fail closed instead of charging credits (B-01)', async () => {
                req.headers['x-byok-provider'] = 'openai';
                req.headers['x-byok-model'] = 'gpt-4o';
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(400);
                expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'BYOK_INVALID', creditRefunded: false }));
                expect(deductionWrites()).toHaveLength(0);
            });

            test('legacy geminiKey / byokConfig fields do not waive credits', async () => {
                mockGet.mockResolvedValue({
                    exists: true,
                    data: () => ({ tierCredits: 0, boosterCredits: 0, tier: 'free', lastTierCreditRenewalAt: today(), geminiKey: 'legacy', byokConfig: { apiKey: 'legacy' } })
                });
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(402);
                expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'INSUFFICIENT_CREDITS' }));
            });

            test('a stored config rejected by policy falls back to credits with a warning', async () => {
                mockGet.mockResolvedValue({
                    exists: true,
                    data: () => ({
                        tierCredits: 5, tier: 'free', lastTierCreditRenewalAt: today(),
                        byokKmsData: { encryptedKey: 'e', wrappedDek: 'w', iv: 'i', authTag: 'a', provider: 'openai', modelName: 'gpt-4o', baseUrl: 'https://llm.example.com/v1' }
                    })
                });
                mockUnwrapAndDecrypt.mockResolvedValueOnce('sk-stored-key-1234567890');
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(200);
                const body = res.send.mock.calls[0][0];
                expect(body.creditsCharged).toBe(1);
                expect(body.warnings[0]).toContain('no longer supported');
                // Platform Gemini was used, not the custom URL.
                expect(global.fetch.mock.calls.some(c => String(c[0]).includes('generativelanguage'))).toBe(true);
            });

            test('a valid stored KMS key is used and no credit is charged', async () => {
                mockGet.mockResolvedValue({
                    exists: true,
                    data: () => ({
                        tierCredits: 0, tier: 'free', lastTierCreditRenewalAt: today(),
                        byokKmsData: { encryptedKey: 'e', wrappedDek: 'w', iv: 'i', authTag: 'a', provider: 'openai', modelName: 'gpt-4o' }
                    })
                });
                mockUnwrapAndDecrypt.mockResolvedValueOnce('sk-stored-key-1234567890');
                global.fetch.mockImplementation(async () => ({
                    ok: true,
                    json: async () => ({ choices: [{ message: { content: JSON.stringify(morningPage()) } }] })
                }));
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(200);
                expect(res.send.mock.calls[0][0].creditsCharged).toBe(0);
                expect(global.fetch.mock.calls[0][0]).toContain('openai.com');
            });

            test('a v3 stored key is unwrapped with the owner AAD and not re-wrapped', async () => {
                mockGet.mockResolvedValue({
                    exists: true,
                    data: () => ({
                        tierCredits: 0, tier: 'free', lastTierCreditRenewalAt: today(),
                        byokKmsData: { encryptedKey: 'e', wrappedDek: 'w', iv: 'i', authTag: 'a', provider: 'openai', modelName: 'gpt-4o', version: 3 }
                    })
                });
                mockUnwrapAndDecrypt.mockResolvedValueOnce('sk-stored-key-1234567890');
                global.fetch.mockImplementation(async () => ({
                    ok: true,
                    json: async () => ({ choices: [{ message: { content: JSON.stringify(morningPage()) } }] })
                }));
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(200);
                expect(mockUnwrapAndDecrypt.mock.calls[0][4].aad.toString('utf8')).toBe('aiplanner:v3:test@example.com:byok');
                expect(mockGenerateAndWrapDEK).not.toHaveBeenCalled();
            });

            test('a legacy (unbound) stored key is lazily re-wrapped as v3 in the same request', async () => {
                const legacy = { encryptedKey: 'e', wrappedDek: 'w', iv: 'i', authTag: 'a', provider: 'openai', modelName: 'gpt-4o' };
                mockGet.mockResolvedValue({
                    exists: true,
                    data: () => ({ tierCredits: 0, tier: 'free', lastTierCreditRenewalAt: today(), byokKmsData: legacy })
                });
                mockUnwrapAndDecrypt.mockResolvedValueOnce('sk-stored-key-1234567890');
                mockGenerateAndWrapDEK.mockResolvedValueOnce({ encryptedKey: 'e3', wrappedDek: 'w3', iv: 'i3', authTag: 'a3', version: 3 });
                global.fetch.mockImplementation(async () => ({
                    ok: true,
                    json: async () => ({ choices: [{ message: { content: JSON.stringify(morningPage()) } }] })
                }));
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(200);
                expect(mockUnwrapAndDecrypt.mock.calls[0][4]).toEqual({});
                expect(mockGenerateAndWrapDEK).toHaveBeenCalledWith('sk-stored-key-1234567890', { aad: expect.any(Buffer) });
                expect(mockSet).toHaveBeenCalledWith({
                    byokKmsData: { ...legacy, encryptedKey: 'e3', wrappedDek: 'w3', iv: 'i3', authTag: 'a3', version: 3 }
                }, { merge: true });
            });

            test('a failed v3 re-wrap never fails the sync', async () => {
                mockGet.mockResolvedValue({
                    exists: true,
                    data: () => ({
                        tierCredits: 0, tier: 'free', lastTierCreditRenewalAt: today(),
                        byokKmsData: { encryptedKey: 'e', wrappedDek: 'w', iv: 'i', authTag: 'a', provider: 'openai', modelName: 'gpt-4o' }
                    })
                });
                mockUnwrapAndDecrypt.mockResolvedValueOnce('sk-stored-key-1234567890');
                mockGenerateAndWrapDEK.mockRejectedValueOnce(new Error('KMS quota'));
                global.fetch.mockImplementation(async () => ({
                    ok: true,
                    json: async () => ({ choices: [{ message: { content: JSON.stringify(morningPage()) } }] })
                }));
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(200);
                expect(res.send.mock.calls[0][0].creditsCharged).toBe(0);
                expect(mockSet).not.toHaveBeenCalledWith(expect.objectContaining({ byokKmsData: expect.anything() }), { merge: true });
            });

            test('BYOK provider rejecting the key maps to 400 BYOK_INVALID', async () => {
                req.headers['x-byok-token'] = 'sk-header-key-1234567890';
                global.fetch.mockImplementation(async () => ({ ok: false, status: 401, text: async () => 'bad key' }));
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(400);
                expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'BYOK_INVALID' }));
            });

            test('journal extraction failure saves the page but awards no streak (S-19)', async () => {
                req.body.syncType = 'journal';
                mockGet.mockResolvedValue({
                    exists: true,
                    data: () => ({ tierCredits: 5, tier: 'free', lastTierCreditRenewalAt: today(), notionKey: validEncryptedKey, notionDbId: 'db' })
                });
                global.fetch.mockImplementation(async (url) => {
                    if (String(url).includes('generativelanguage')) return { ok: false, status: 503, text: async () => 'down' };
                    return { ok: true, json: async () => ({}) };
                });
                const streakSpy = jest.spyOn(myFunctions, 'applyGamificationMilestones');
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(200);
                const body = res.send.mock.calls[0][0];
                expect(body.warnings[0]).toContain("couldn't read this page");
                expect(body.creditsCharged).toBe(1);
                // No gamification transaction ran (only the credit transaction).
                expect(mockSet.mock.calls.some(c => c[0] && c[0].lastSyncDate)).toBe(false);
                streakSpy.mockRestore();
            });

            test('setupBYOK action:delete removes the stored and legacy key fields (C2)', async () => {
                req.body = { idToken: 'tok', action: 'delete' };
                await myFunctions.setupBYOK(req, res);
                expect(res.status).toHaveBeenCalledWith(200);
                expect(res.send).toHaveBeenCalledWith({ deleted: true });
                expect(mockSet).toHaveBeenCalledWith({ byokKmsData: 'mockDelete', geminiKey: 'mockDelete', byokConfig: 'mockDelete' }, { merge: true });
            });

            test('setupNotion action:delete removes Notion settings (C2)', async () => {
                req.body = { idToken: 'tok', action: 'delete' };
                await myFunctions.setupNotion(req, res);
                expect(res.status).toHaveBeenCalledWith(200);
                expect(res.send).toHaveBeenCalledWith({ deleted: true });
                expect(mockSet).toHaveBeenCalledWith({ notionKey: 'mockDelete', notionDbId: 'mockDelete' }, { merge: true });
            });

            test('setupBYOK rejects an invalid config with 400 BYOK_INVALID', async () => {
                req.body = { idToken: 'tok', apiKey: 'sk-abcdefg123456789012345', provider: 'azure' };
                await myFunctions.setupBYOK(req, res);
                expect(res.status).toHaveBeenCalledWith(400);
                expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'BYOK_INVALID' }));
            });
        });

        describe('B-10: Notion chunking', () => {
            test('long transcriptions are split into ≤2000-char blocks and ≤100 children per request', async () => {
                req.body.syncType = 'journal';
                mockGet.mockResolvedValue({
                    exists: true,
                    data: () => ({ tierCredits: 5, tier: 'pro', lastTierCreditRenewalAt: today(), notionKey: validEncryptedKey, notionDbId: 'db' })
                });
                const lines = Array.from({ length: 150 }, (_, i) => `Line ${i}`);
                lines.push('x'.repeat(4500));
                useGemini({ date: '15-January-2025', transcription: lines.join('\n') });

                await myFunctions.syncPlanner(req, res);

                expect(res.status).toHaveBeenCalledWith(200);
                const createArgs = mockNotionPagesCreate.mock.calls[0][0];
                expect(createArgs.children).toHaveLength(100);
                const appended = mockNotionBlocksAppend.mock.calls.flatMap(c => c[0].children);
                expect(mockNotionBlocksAppend.mock.calls.every(c => c[0].block_id === 'page-1' && c[0].children.length <= 100)).toBe(true);
                const all = [...createArgs.children, ...appended];
                // 1 image + 150 lines + 3 chunks of the long line
                expect(all).toHaveLength(154);
                const texts = all.filter(b => b.type === 'paragraph').map(b => b.paragraph.rich_text[0].text.content);
                expect(Math.max(...texts.map(t => t.length))).toBeLessThanOrEqual(2000);
            });
        });

        describe('C11: syncHistory lifecycle for interrupted-sync refunds', () => {
            const historyWrites = () => mockHistorySet.mock.calls.map(c => c[0]);

            test('reserves the record as processing with startedAt, creditsDeducted and refunded:false', async () => {
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(200);
                expect(historyWrites()[0]).toEqual(expect.objectContaining({
                    status: 'processing',
                    startedAt: 'mockTimestamp',
                    creditsDeducted: { tier: 1, booster: 0 },
                    refunded: false,
                    failureReason: 'mockDelete',
                    reconciledAt: 'mockDelete'
                }));
                expect(historyWrites().pop()).toEqual(expect.objectContaining({ status: 'success', creditsCharged: 1, refunded: false }));
            });

            test('a failure after deduction refunds and finalises as failed with refunded:true', async () => {
                global.fetch.mockImplementation(async (url) => (String(url).includes('generativelanguage')
                    ? { ok: false, status: 500, text: async () => 'boom' }
                    : { ok: true, json: async () => ({}) }));
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(502);
                expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'AI_UNAVAILABLE', creditRefunded: true }));
                expect(refundCalls()).toHaveLength(1);
                // The refund and refunded:true are written together (same transaction).
                expect(historyWrites()).toContainEqual({ refunded: true });
                expect(historyWrites().pop()).toEqual(expect.objectContaining({ status: 'failed', refunded: true, creditRefunded: true, errorCode: 'AI_UNAVAILABLE' }));
            });

            test('the request never refunds a record the reconciler already refunded', async () => {
                global.fetch.mockImplementation(async (url) => (String(url).includes('generativelanguage')
                    ? { ok: false, status: 500, text: async () => 'boom' }
                    : { ok: true, json: async () => ({}) }));
                // First read (reservation) sees no record; the refund transaction sees refunded:true.
                mockHistoryGet
                    .mockResolvedValueOnce({ exists: false })
                    .mockResolvedValue({ exists: true, data: () => ({ status: 'failed', refunded: true }) });
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(502);
                expect(refundCalls()).toHaveLength(0);
            });

            test('re-reserving a stale processing record returns the dead attempt\'s credit first', async () => {
                req.body.clientRequestId = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
                mockGet.mockResolvedValue({
                    exists: true,
                    data: () => ({ tierCredits: 0, boosterCredits: 0, tier: 'free', lastTierCreditRenewalAt: today(), spreadsheetId: 'sheet-1' })
                });
                mockHistoryGet.mockResolvedValue({
                    exists: true,
                    data: () => ({ status: 'processing', startedAtMs: Date.now() - 10 * 60 * 1000, creditsDeducted: { tier: 1, booster: 0 }, refunded: false })
                });
                await myFunctions.syncPlanner(req, res);
                // Without the carried-back credit the user (0 credits) would get 402.
                expect(res.status).toHaveBeenCalledWith(200);
                expect(res.send.mock.calls[0][0].creditsCharged).toBe(1);
                expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ tierCredits: 0, boosterCredits: 0 }), { merge: true });
            });

            test('a stale record that was already refunded is not refunded again', async () => {
                req.body.clientRequestId = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
                mockGet.mockResolvedValue({
                    exists: true,
                    data: () => ({ tierCredits: 0, boosterCredits: 0, tier: 'free', lastTierCreditRenewalAt: today() })
                });
                mockHistoryGet.mockResolvedValue({
                    exists: true,
                    data: () => ({ status: 'processing', startedAtMs: Date.now() - 10 * 60 * 1000, creditsDeducted: { tier: 1, booster: 0 }, refunded: true })
                });
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(402);
            });

            test('a sync that synced nothing is refunded and finalised as success with refunded:true', async () => {
                useGemini({ date: '2025-01-01', schedule: [], todos: [] });
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(200);
                expect(res.send.mock.calls[0][0].creditsCharged).toBe(0);
                expect(historyWrites().pop()).toEqual(expect.objectContaining({ status: 'success', creditsCharged: 0, refunded: true }));
            });
        });

        describe('C8: HEIC photos', () => {
            const heic = require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'sample.heic'));
            const geminiBodies = () => global.fetch.mock.calls
                .filter(c => String(c[0]).includes('generativelanguage'))
                .map(c => JSON.parse(c[1].body));

            test('a real HEIC is converted to JPEG before the AI step and the sync succeeds', async () => {
                req.body.images = [`data:image/heic;base64,${heic.toString('base64')}`];
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(200);
                expect(res.send.mock.calls[0][0].creditsCharged).toBe(1);
                const parts = geminiBodies()[0].contents[0].parts.filter(p => p.inlineData);
                expect(parts).toHaveLength(1);
                expect(parts[0].inlineData.mimeType).toBe('image/jpeg');
                expect(Buffer.from(parts[0].inlineData.data, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
            });

            test('a fake-brand "HEIC" is rejected with 400 INVALID_IMAGE before any charge', async () => {
                const fake = Buffer.alloc(48);
                fake.writeUInt32BE(16, 0);
                fake.write('ftypisom', 4, 'latin1');
                req.body.images = [`data:image/heic;base64,${fake.toString('base64')}`];
                await myFunctions.syncPlanner(req, res);
                expect(res.status).toHaveBeenCalledWith(400);
                expect(res.send).toHaveBeenCalledWith({
                    error: "We couldn't read this HEIC photo. Try exporting it as JPEG.",
                    errorCode: 'INVALID_IMAGE',
                    creditRefunded: false
                });
                expect(deductionWrites()).toHaveLength(0);
                expect(mockHistorySet).not.toHaveBeenCalled();
            });

            test('an undecodable HEIF container is rejected with 400 INVALID_IMAGE before any charge', async () => {
                jest.spyOn(console, 'log').mockImplementation(() => {});
                try {
                    const broken = Buffer.concat([heic.subarray(0, 36), Buffer.alloc(200, 1)]);
                    req.body.images = [`data:image/heic;base64,${broken.toString('base64')}`];
                    await myFunctions.syncPlanner(req, res);
                    expect(res.status).toHaveBeenCalledWith(400);
                    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'INVALID_IMAGE', creditRefunded: false }));
                    expect(deductionWrites()).toHaveLength(0);
                    expect(refundCalls()).toHaveLength(0);
                    expect(geminiBodies()).toHaveLength(0);
                } finally {
                    console.log.mockRestore();
                }
            });
        });

        describe('S-17: deleteUserAccount', () => {
            test('requires a recent sign-in', async () => {
                mockVerifyIdToken.mockResolvedValue(verifiedUser({ auth_time: Math.floor(Date.now() / 1000) - 3600 }));
                req.body = { token: 'tok' };
                await myFunctions.deleteUserAccount(req, res);
                expect(res.status).toHaveBeenCalledWith(401);
                expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'REAUTH_REQUIRED' }));
                expect(mockBatch.commit).not.toHaveBeenCalled();
            });

            test('anonymises payment records instead of deleting them', async () => {
                const defaultImpl = mockCollection.getMockImplementation();
                const orderRef = { id: 'order_1' };
                mockCollection.mockImplementation((name) => {
                    if (name === 'cashfree_orders') {
                        return { where: () => ({ get: async () => ({ docs: [{ ref: orderRef }] }) }) };
                    }
                    return defaultImpl(name);
                });
                try {
                    req.body = { token: 'tok' };
                    await myFunctions.deleteUserAccount(req, res);
                    expect(res.status).toHaveBeenCalledWith(200);
                    expect(mockBatch.update).toHaveBeenCalledWith(orderRef, expect.objectContaining({ userEmail: null, userId: null, userDeleted: true }));
                    expect(mockBatch.delete).not.toHaveBeenCalledWith(orderRef);
                } finally {
                    mockCollection.mockImplementation(defaultImpl);
                }
            });
        });

        describe('S-11: adminGrantCredits', () => {
            test('applies a grant with set(merge) and a grantId ledger', async () => {
                const defaultImpl = mockCollection.getMockImplementation();
                const fresh = { ref: { id: 'a' }, data: () => ({}) };
                const already = { ref: { id: 'b' }, data: () => ({ appliedCreditGrants: ['grant-xyz-1'] }) };
                let page = 0;
                const usersQuery = {
                    orderBy: () => usersQuery, limit: () => usersQuery, startAfter: () => usersQuery,
                    get: async () => (page++ === 0 ? { empty: false, docs: [fresh, already] } : { empty: true, docs: [] })
                };
                const lockSet = jest.fn();
                mockCollection.mockImplementation((name) => {
                    if (name === 'users') return usersQuery;
                    if (name === 'adminCreditGrants') return { doc: () => ({ get: async () => ({ exists: false }), set: lockSet }) };
                    return defaultImpl(name);
                });
                const batchSet = jest.fn();
                const batchCommit = jest.fn().mockResolvedValue();
                const adminBacking = require('mock-firebase-admin-backing');
                const originalFirestore = adminBacking.firestore.getMockImplementation();
                adminBacking.firestore.mockImplementation(() => ({ ...originalFirestore(), batch: () => ({ set: batchSet, commit: batchCommit }) }));
                try {
                    req.headers['x-credits-grant-token'] = 'test-encryption-key-for-jest';
                    req.body = { confirm: 'GRANT-CREDITS-25', amount: 25, grantId: 'grant-xyz-1' };
                    await myFunctions.adminGrantCredits(req, res);
                    expect(res.status).toHaveBeenCalledWith(200);
                    expect(res.send.mock.calls[0][0].stats).toEqual(expect.objectContaining({ usersScanned: 2, writesQueued: 1, alreadyGranted: 1 }));
                    expect(batchSet).toHaveBeenCalledTimes(1);
                    expect(batchSet).toHaveBeenCalledWith(fresh.ref, { boosterCredits: 'mockIncrement(25)', appliedCreditGrants: 'mockArrayUnion(grant-xyz-1)' }, { merge: true });
                    expect(lockSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }), { merge: true });
                } finally {
                    mockCollection.mockImplementation(defaultImpl);
                    adminBacking.firestore.mockImplementation(originalFirestore);
                }
            });
        });
    });
});

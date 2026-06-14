const admin = require('firebase-admin');

// 1. Mock Firebase Admin
const mockSet = jest.fn();
const mockGet = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();
const mockAdd = jest.fn();
const mockCollectionInner = jest.fn(() => ({
    add: mockAdd,
    get: jest.fn().mockResolvedValue({ docs: [], forEach: jest.fn() }),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
}));
const mockBatch = {
    delete: jest.fn(),
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
        get: jest.fn().mockResolvedValue({ docs: [], forEach: jest.fn() })
    };
    return { doc: mockDoc };
});

const mockVerifyIdToken = jest.fn();

jest.mock('firebase-admin', () => {
    const FieldValue = {
        serverTimestamp: jest.fn(() => 'mockTimestamp'),
        increment: jest.fn((n) => `mockIncrement(${n})`)
    };

    const mockTransactionGet = jest.fn(async (ref) => ref.get());
    const mockTransactionSet = jest.fn((ref, data, opts) => ref.set(data, opts));
    const mockRunTransaction = jest.fn(async (callback) => {
        const t = { get: mockTransactionGet, set: mockTransactionSet };
        return await callback(t);
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
        }))
    };
});

// 2. Mock Firebase Functions
jest.mock('firebase-functions/v2/https', () => ({
    // Return the handler itself so we can call myFunctions.setupNotion(req, res) directly
    onRequest: jest.fn((options, handler) => handler)
}));

jest.mock('firebase-functions/params', () => ({
    defineString: jest.fn(() => ({ value: () => 'test-string' })),
    defineSecret: jest.fn(() => ({ value: () => 'test-encryption-key-for-jest' }))
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
const mockSheetsGet = jest.fn().mockResolvedValue({ data: { values: [] } });

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
                values: { update: mockSheetsUpdate, append: mockSheetsAppend, get: mockSheetsGet }
            }
        }))
    },
    // Export mocks to modify in tests
    _mockGetUserInfo: mockGetUserInfo,
    _mockTasksList: mockTasksList,
    _mockSheetsCreate: mockSheetsCreate
}));

// 4. Mock Gemini and Notion
const mockGenerateContent = jest.fn();
jest.mock('@google/generative-ai', () => ({
    GoogleGenerativeAI: jest.fn(() => ({
        getGenerativeModel: jest.fn(() => ({
            generateContent: mockGenerateContent
        }))
    }))
}));

const mockNotionDbQuery = jest.fn().mockResolvedValue({ results: [] });
const mockNotionPagesCreate = jest.fn();
jest.mock('@notionhq/client', () => ({
    Client: jest.fn(() => ({
        databases: { query: mockNotionDbQuery },
        pages: { create: mockNotionPagesCreate }
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
        // Reset rate limit mock — always allow (first request in window)
        mockRateLimitGet.mockResolvedValue({ exists: false });
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
        mockVerifyIdToken.mockResolvedValue({ email: 'test@example.com', uid: '123' });
    });

    describe('setupNotion', () => {
        test('rejects GET requests with 405', async () => {
            req.method = 'GET';
            await myFunctions.setupNotion(req, res);
            expect(res.status).toHaveBeenCalledWith(405);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Method not allowed" }));
        });

        test('rejects missing or invalid body with 400', async () => {
            req.body = null;
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
            mockVerifyIdToken.mockResolvedValue({ email: 'test@example.com' });

            await myFunctions.setupNotion(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ success: true, text: "Notion setup saved securely." }));
            expect(mockCollection).toHaveBeenCalledWith('users');
            expect(mockDoc).toHaveBeenCalledWith('test@example.com');
            expect(mockSet).toHaveBeenCalledWith({
                notionKey: expect.stringMatching(/^v2:/), // Should be encrypted
                notionDbId: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'
            }, { merge: true });

            // Ensure the stored key is NOT the plaintext
            const setArg = mockSet.mock.calls[0][0];
            expect(setArg.notionKey).not.toBe('secret_1234567890abcdef1234');
        });

        test('handles Firebase ID token lookup failure', async () => {
            req.body = {
                notionKey: 'secret_1234567890abcdef1234',
                notionDbId: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
                idToken: 'invalid-firebase-id-token'
            };
            mockVerifyIdToken.mockRejectedValue(new Error('Invalid credentials'));

            await myFunctions.setupNotion(req, res);

            expect(res.status).toHaveBeenCalledWith(500);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Failed to securely save keys." }));
            expect(mockSet).not.toHaveBeenCalled();
        });

        test('returns 429 when rate limit exceeded', async () => {
            req.body = { idToken: 'valid-firebase-id-token', notionKey: 'secret_1234567890abcdef1234567890abcdef', notionDbId: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6' };
            mockVerifyIdToken.mockResolvedValue({ email: 'test@example.com' });
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
            req.body = null;
            await myFunctions.setupBYOK(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Invalid setup payload" }));
        });

        test('stores KMS wrapped BYOK configuration on success', async () => {
            req.body = {
                apiKey: 'sk-abcdefg1234567',
                provider: 'openai',
                modelName: 'gpt-4o',
                idToken: 'valid-firebase-id-token'
            };
            mockVerifyIdToken.mockResolvedValue({ email: 'test@example.com' });

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
                })
            }, { merge: true });
        });

        test('returns 429 when rate limit exceeded', async () => {
            req.body = { idToken: 'valid-firebase-id-token', apiKey: 'test' };
            mockVerifyIdToken.mockResolvedValue({ email: 'test@example.com' });
            mockRateLimitGet.mockResolvedValue({ exists: true, data: () => ({ count: 100, windowStart: Date.now() }) });
            await myFunctions.setupBYOK(req, res);
            expect(res.status).toHaveBeenCalledWith(429);
            expect(res.set).toHaveBeenCalledWith('Retry-After', expect.any(String));
        });
    });

    describe('exportUserData', () => {
        test('rejects missing token', async () => {
            await myFunctions.exportUserData(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Missing token" }));
        });

        test('rejects invalid token', async () => {
            req.body.token = 'invalid-google-oauth-token-string';
            mockVerifyIdToken.mockRejectedValue(new Error('Auth error'));

            await myFunctions.exportUserData(req, res);
            expect(res.status).toHaveBeenCalledWith(500);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Failed to export data." }));
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
            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Missing token" }));
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
        const validImageData = 'data:image/jpeg;base64,' + Buffer.from('fake-image').toString('base64');
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
            mockVerifyIdToken.mockResolvedValue({ email: 'test@example.com' });
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
        test('returns 413 Payload Too Large when body size exceeds 100MB', async () => {
            req.body.syncType = 'morning';
            req.body.token = 'valid-token';
            req.body = { data: "A".repeat(101_000_000) };
            req.rawBody = Buffer.alloc(101_000_001); // Mock Firebase's raw bytes buffer
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(413);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Payload too large. Max 100MB allowed." }));
        });

        test('returns 429 when rate limit exceeded', async () => {
            mockRateLimitGet.mockResolvedValue({ exists: true, data: () => ({ count: 100, windowStart: Date.now() }) });
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(429);
            expect(res.set).toHaveBeenCalledWith('Retry-After', expect.any(String));
        });

        test('bypasses credit deduction for stateless BYOK user', async () => {
            req.body.syncType = 'morning';
            req.headers['x-byok-token'] = 'sk-mock-123';
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
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Internal Server Error" }));
            // Assert that no fallback Gemini/default API was called
            expect(global.fetch).not.toHaveBeenCalled();
        });

        test('rejects request with invalid token', async () => {
            req.body.idToken = null;
            delete req.body.googleToken;
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(401);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Unauthorized" }));
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

        test('journal sync fails gracefully if user has no Notion settings', async () => {
            req.body.syncType = 'journal';
            mockGet.mockResolvedValue({ exists: false, data: () => null });

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

            expect(res.status).toHaveBeenCalledWith(500);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Internal Server Error" }));
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
            // Make Notion fetch fail with realistic error
            global.fetch.mockImplementation(async (url) => {
                if (url.includes('generativelanguage')) {
                    return {
                        ok: true,
                        json: async () => ({
                            candidates: [{
                                content: { parts: [{ text: global.__geminiMockText }] }
                            }]
                        })
                    };
                }
                // Notion upload returns 500 (init step fails)
                return {
                    ok: false,
                    status: 500,
                    text: async () => 'Internal Server Error: rate limited',
                    json: async () => ({ message: 'Upload failed' })
                };
            });

            await myFunctions.syncPlanner(req, res);

            // uploadFileToNotion throws → caught by outer catch → returns 500
            expect(res.status).toHaveBeenCalledWith(500);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Internal Server Error" }));
        });

        test('journal sync handles Notion init response missing upload_url', async () => {
            req.body.syncType = 'journal';
            global.__geminiMockText = JSON.stringify({ date: "15-January-2025" });
            // Notion returns OK but with missing upload_url (contract violation)
            global.fetch.mockImplementation(async (url) => {
                if (url.includes('generativelanguage')) {
                    return {
                        ok: true,
                        json: async () => ({
                            candidates: [{
                                content: { parts: [{ text: global.__geminiMockText }] }
                            }]
                        })
                    };
                }
                if (url.includes('notion')) {
                    // Init succeeds but returns incomplete shape
                    return {
                        ok: true,
                        text: async () => JSON.stringify({ id: 'file-123' }),
                        json: async () => ({ id: 'file-123' }) // missing upload_url
                    };
                }
                return { ok: true, json: async () => ({}) };
            });

            await myFunctions.syncPlanner(req, res);

            // fetch(undefined) for upload step should cause an error
            expect(res.status).toHaveBeenCalledWith(500);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Internal Server Error" }));
        });

        test('rejects request from unauthorized CORS origin', async () => {
            req.headers.origin = 'https://evil-site.com';
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Origin not allowed" }));
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

            expect(res.status).toHaveBeenCalledWith(500);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "AI Service Busy. Please try again." }));
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

            expect(res.status).toHaveBeenCalledWith(500);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Internal Server Error" }));
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
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Could not parse image" }));
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
        });

        // --- Branch coverage: missing Notion keys (line 424) ---
        test('evening sync skips Notion when keys are missing', async () => {
            req.body.syncType = 'evening';
            mockGet.mockResolvedValue({
                exists: true,
                data: () => ({ spreadsheetId: 'test-sheet-id' })  // No notionKey, no notionDbId
            });
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(200);
            const responseText = res.send.mock.calls[0][0].text;
            expect(responseText).toContain("Skipped Notion");
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
        test('handles Gemini 400 API error without refunding the credit', async () => {
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
            const refundCall = mockUpdate.mock.calls.find(c => c[0] && c[0].tierCredits === 'mockIncrement(1)');
            expect(refundCall).toBeUndefined();
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
            expect(res.status).toHaveBeenCalledWith(500);
        });

        // --- Branch coverage: Google Token identity mismatch ---
        test('returns 403 when Google Token email does not match Firebase ID email', async () => {
            mockVerifyIdToken.mockResolvedValue({ email: 'test@example.com' });
            _mockGetUserInfo.mockResolvedValue({ data: { email: 'malicious@example.com' } });
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.send).toHaveBeenCalledWith({ error: "Token identity mismatch" });
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
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "No email in token" }));
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
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "No email in token" }));
        });
    });

    // --- Branch coverage: syncPlanner method & content-type guards ---
    describe('syncPlanner - request validation branches', () => {
        test('rejects non-POST syncPlanner with 405', async () => {
            req.method = 'GET';
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(405);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Method Not Allowed" }));
        });

        test('rejects non-JSON content-type for syncPlanner with 415', async () => {
            req.headers['content-type'] = 'text/plain';
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(415);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Unsupported Media Type. Expected application/json" }));
        });
    });

    // --- Branch coverage: deleteUserAccount catch block ---
    describe('deleteUserAccount - error handling', () => {
        test('returns 500 when Firestore delete throws', async () => {
            req.body.token = 'valid-google-oauth-token-string';
            mockVerifyIdToken.mockResolvedValue({ email: 'test@example.com' });
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
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Content-Type must be application/json" }));
        });

        test('exportUserData rejects non-JSON content-type with 415', async () => {
            req.headers['content-type'] = 'text/html';
            await myFunctions.exportUserData(req, res);
            expect(res.status).toHaveBeenCalledWith(415);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Content-Type must be application/json" }));
        });

        test('deleteUserAccount rejects non-JSON content-type with 415', async () => {
            req.headers['content-type'] = 'multipart/form-data';
            await myFunctions.deleteUserAccount(req, res);
            expect(res.status).toHaveBeenCalledWith(415);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Content-Type must be application/json" }));
        });
    });

    describe('logClientError', () => {
        test('rejects GET requests with 405', async () => {
            req.method = 'GET';
            await myFunctions.logClientError(req, res);
            expect(res.status).toHaveBeenCalledWith(405);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Method not allowed" }));
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

});

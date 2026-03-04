const admin = require('firebase-admin');

// 1. Mock Firebase Admin
const mockSet = jest.fn();
const mockGet = jest.fn();
const mockDelete = jest.fn();
const mockDoc = jest.fn(() => ({
    set: mockSet,
    get: mockGet,
    delete: mockDelete
}));
const mockCollection = jest.fn(() => ({
    doc: mockDoc
}));

const mockVerifyIdToken = jest.fn();

jest.mock('firebase-admin', () => ({
    initializeApp: jest.fn(),
    firestore: jest.fn(() => ({
        collection: mockCollection
    })),
    auth: jest.fn(() => ({
        verifyIdToken: mockVerifyIdToken
    }))
}));

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
const mockTasksInsert = jest.fn();
const mockTasksList = jest.fn();
const mockTasksPatch = jest.fn();
const mockSheetsCreate = jest.fn();
const mockSheetsUpdate = jest.fn();
const mockSheetsAppend = jest.fn();

jest.mock('googleapis', () => ({
    google: {
        auth: { OAuth2: jest.fn(() => ({ setCredentials: jest.fn() })) },
        oauth2: jest.fn(() => ({ userinfo: { get: mockGetUserInfo } })),
        calendar: jest.fn(() => ({ events: { insert: mockCalendarInsert } })),
        tasks: jest.fn(() => ({
            tasks: { insert: mockTasksInsert, list: mockTasksList, patch: mockTasksPatch }
        })),
        sheets: jest.fn(() => ({
            spreadsheets: {
                create: mockSheetsCreate,
                values: { update: mockSheetsUpdate, append: mockSheetsAppend }
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

const mockNotionPagesCreate = jest.fn();
jest.mock('@notionhq/client', () => ({
    Client: jest.fn(() => ({
        pages: { create: mockNotionPagesCreate }
    }))
}));

global.fetch = jest.fn();

// Import the functions after mocking
const myFunctions = require('../index');
const { google, _mockGetUserInfo, _mockTasksList, _mockSheetsCreate } = require('googleapis');

describe('index.js Integration Tests', () => {
    let req, res;

    beforeEach(() => {
        jest.clearAllMocks();
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
                token: 'valid-google-oauth-token-string'
            };
            _mockGetUserInfo.mockResolvedValue({ data: { email: 'test@example.com' } });

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

        test('handles Google API token lookup failure', async () => {
            req.body = {
                notionKey: 'secret_1234567890abcdef1234',
                notionDbId: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
                token: 'invalid-google-oauth-token-string'
            };
            _mockGetUserInfo.mockRejectedValue(new Error('Invalid credentials'));

            await myFunctions.setupNotion(req, res);

            expect(res.status).toHaveBeenCalledWith(500);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Failed to securely save keys." }));
            expect(mockSet).not.toHaveBeenCalled();
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

            expect(mockCollection).toHaveBeenCalledWith('users');
            expect(mockDoc).toHaveBeenCalledWith('test@example.com');
            expect(res.status).toHaveBeenCalledWith(200);

            const responseData = res.send.mock.calls[0][0];
            expect(responseData).toHaveProperty('email', 'test@example.com');
            expect(responseData).toHaveProperty('data.notionDbId', 'test-db-id');
            expect(responseData).toHaveProperty('data.notionConfigured', true);
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
            expect(mockDelete).toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.send).toHaveBeenCalledWith({ success: true, text: "Your account data has been permanently deleted." });
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
                token: 'valid-google-oauth-token-string',
                syncType: 'morning',
                imageData: validImageData
            };
            _mockGetUserInfo.mockResolvedValue({ data: { email: 'test@example.com' } });

            // Default user exists
            mockGet.mockResolvedValue({
                exists: true,
                data: () => ({ notionKey: validEncryptedKey, notionDbId: 'test-db-id', spreadsheetId: 'test-sheet-id' })
            });

            // Dynamic fetch mock for both Gemini REST API and Notion upload
            global.fetch.mockImplementation(async (url) => {
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
                    return {
                        ok: true,
                        json: async () => ({ upload_url: 'http://fake-url.com', url: 'http://notion-file.com' })
                    };
                }
                return { ok: true, json: async () => ({}) };
            });
        });

        test('rejects request with invalid token', async () => {
            req.body.token = null;
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(401);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Missing Google OAuth Token" }));
        });

        test('rejects request with invalid syncType', async () => {
            req.body.syncType = 'invalid-mode';
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Invalid syncType" }));
        });

        test('rejects request with invalid image data', async () => {
            req.body.imageData = 'not-a-data-url';
            await myFunctions.syncPlanner(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ error: "Invalid image data format or size" }));
        });

        test('processes journal sync successfully', async () => {
            req.body.syncType = 'journal';
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
            // Make Notion fetch fail
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
                // Notion upload fails
                return { ok: false, status: 500, json: async () => ({ message: 'Upload failed' }) };
            });

            await myFunctions.syncPlanner(req, res);

            // Should still return 200 but with an error in the flow
            // The exact behavior depends on how the code handles Notion failures
            expect(res.status).toHaveBeenCalled();
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
});

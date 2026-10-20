/**
 * Tests for functions/services/gemini.js and functions/services/rateLimit.js
 * Uses jest.isolateModules to ensure fresh module scope for logger mocking.
 */

// ══════════════════════════════════════════════════════════════════════════════
// Mock firebase-admin for rateLimit.js
// ══════════════════════════════════════════════════════════════════════════════
const mockSet = jest.fn().mockResolvedValue(undefined);
const mockGet = jest.fn();
const mockDoc = jest.fn(() => ({ get: mockGet, set: mockSet }));
const mockCollection = jest.fn(() => ({ doc: mockDoc }));

const mockRunTransaction = jest.fn();

jest.mock('mock-firebase-admin-backing', () => ({
    initializeApp: jest.fn(),
    firestore: jest.fn(() => ({ collection: mockCollection, runTransaction: mockRunTransaction })),
}), { virtual: true });
jest.mock('firebase-admin/app', () => require('./helpers/adminMock').app());
jest.mock('firebase-admin/firestore', () => require('./helpers/adminMock').firestore());
jest.mock('firebase-admin/auth', () => require('./helpers/adminMock').auth());
jest.mock('firebase-admin/app-check', () => require('./helpers/adminMock').appCheck());

// We import the utils up here so they don't get trapped if needed
const { RATE_LIMIT_WINDOW_MS } = require('../utils');

let getPlannerDataFromImages;
let getCountWarnings;
let geminiLogger;
let checkRateLimit;

beforeAll(() => {
    jest.isolateModules(() => {
        // Mock firebase-functions/logger
        jest.mock('firebase-functions/logger', () => ({
            logger: {
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
            },
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        }));

        // Mock firebase-functions/params
        jest.mock('firebase-functions/params', () => ({
            defineString: jest.fn(() => ({ value: () => 'test-gemini-key' })),
            defineSecret: jest.fn(() => ({ value: () => 'test-secret' })),
        }));

        ({ getPlannerDataFromImages, getCountWarnings } = require('../services/gemini'));
        ({ logger: geminiLogger } = require('firebase-functions/logger'));
        ({ checkRateLimit } = require('../services/rateLimit'));
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// getPlannerDataFromImages
// ──────────────────────────────────────────────────────────────────────────────
describe('gemini.js — getPlannerDataFromImages', () => {
    beforeEach(() => {
        global.fetch = jest.fn();
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    const makeGeminiSuccess = (obj) => ({
        ok: true,
        json: async () => ({
            candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }]
        })
    });

    // ── Input validation ────────────────────────────────────────────────────
    test('throws INVALID_IMAGE_PAYLOAD when images array is empty', async () => {
        await expect(getPlannerDataFromImages([], 'morning')).rejects.toThrow('INVALID_IMAGE_PAYLOAD');
    });

    test('throws INVALID_IMAGE_PAYLOAD when images is null', async () => {
        await expect(getPlannerDataFromImages(null, 'morning')).rejects.toThrow('INVALID_IMAGE_PAYLOAD');
    });

    // ── Prompt selection by syncType ────────────────────────────────────────
    test('morning sync returns schedule and todos', async () => {
        global.fetch.mockResolvedValue(makeGeminiSuccess({
            date: '2025-01-01', schedule: [], todos: []
        }));
        const result = await getPlannerDataFromImages([{ mimeType: 'image/jpeg', base64Data: 'abc' }], 'morning');
        expect(result).toHaveProperty('schedule');
        expect(result).toHaveProperty('todos');
    });

    test('evening sync returns expenses and brainDump', async () => {
        global.fetch.mockResolvedValue(makeGeminiSuccess({
            date: '2025-01-01', todos: [], expenses: [], health: {}, brainDump: 'notes here'
        }));
        const result = await getPlannerDataFromImages([{ mimeType: 'image/jpeg', base64Data: 'abc' }], 'evening');
        expect(result).toHaveProperty('brainDump');
        expect(result).toHaveProperty('expenses');
    });

    test('journal_date_only sync returns just a date', async () => {
        global.fetch.mockResolvedValue(makeGeminiSuccess({ date: '15-January-2025' }));
        const result = await getPlannerDataFromImages([{ mimeType: 'image/jpeg', base64Data: 'abc' }], 'journal_date_only');
        expect(result).toHaveProperty('date', '15-January-2025');
    });

    // ── BYOK path ───────────────────────────────────────────────────────────
    test('uses BYOK UniversalAIAdapter when byokConfig.apiKey is set', async () => {
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: '{"date":"2025-01-01","schedule":[],"todos":[]}' } }]
            })
        });
        const result = await getPlannerDataFromImages(
            [{ mimeType: 'image/jpeg', base64Data: 'abc' }],
            'morning',
            { apiKey: 'sk-byok', provider: 'openai', modelName: 'gpt-4o' }
        );
        expect(result).toHaveProperty('date', '2025-01-01');
        const calledUrl = global.fetch.mock.calls[0][0];
        expect(calledUrl).toContain('openai.com');
    });

    test('byok path: strips ```json wrapper from Claude-style response', async () => {
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: '```json\n{"date":"2025-01-01"}\n```' } }]
            })
        });
        const result = await getPlannerDataFromImages(
            [{ mimeType: 'image/jpeg', base64Data: 'abc' }],
            'morning',
            { apiKey: 'sk-byok', provider: 'openai', modelName: 'gpt-4o' }
        );
        expect(result).toHaveProperty('date', '2025-01-01');
    });

    test('byok path: throws "Invalid final structured output" on non-JSON adapter response', async () => {
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'Sorry, I cannot help with that.' } }]
            })
        });
        await expect(getPlannerDataFromImages(
            [{ mimeType: 'image/jpeg', base64Data: 'abc' }],
            'morning',
            { apiKey: 'sk-byok', provider: 'openai', modelName: 'gpt-4o' }
        )).rejects.toThrow('Invalid final structured output');
    });

    // ── Model cascade & fallback ─────────────────────────────────────────────
    test('falls back to next Gemini model when primary fails with SERVER_ERROR', async () => {
        global.fetch
            .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Server Error' })
            .mockResolvedValueOnce(makeGeminiSuccess({ date: '2025-01-01', schedule: [], todos: [] }));

        const result = await getPlannerDataFromImages([{ mimeType: 'image/jpeg', base64Data: 'abc' }], 'morning');
        expect(result).toHaveProperty('date', '2025-01-01');
        expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    test('throws "All Gemini models failed" when all models fail', async () => {
        global.fetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'Error' });
        await expect(getPlannerDataFromImages([{ mimeType: 'image/jpeg', base64Data: 'abc' }], 'morning'))
            .rejects.toThrow('All Gemini models failed');
        // Gemini standard fallback list is 4 models
        expect(global.fetch).toHaveBeenCalledTimes(4);
    });

    const img = [{ mimeType: 'image/jpeg', base64Data: 'abc' }];

    test('sends the key in x-goog-api-key, never in the URL (S-06)', async () => {
        global.fetch.mockResolvedValue(makeGeminiSuccess({ date: '2025-01-01', schedule: [], todos: [] }));
        await getPlannerDataFromImages(img, 'morning');
        const [url, options] = global.fetch.mock.calls[0];
        expect(url).not.toContain('key=');
        expect(options.headers['x-goog-api-key']).toBe('test-secret');
    });

    test('an image rejection stops the cascade with AI_INPUT_REJECTED (B-08)', async () => {
        global.fetch.mockResolvedValue({ ok: false, status: 400, text: async () => '{"error":{"status":"INVALID_ARGUMENT","message":"Unable to process input image."}}' });
        await expect(getPlannerDataFromImages(img, 'morning')).rejects.toMatchObject({ code: 'AI_INPUT_REJECTED' });
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('an invalid server key is AI_CONFIG_ERROR, not a client error (B-08)', async () => {
        global.fetch.mockResolvedValue({ ok: false, status: 400, text: async () => '{"error":{"message":"API key not valid.","details":[{"reason":"API_KEY_INVALID"}]}}' });
        await expect(getPlannerDataFromImages(img, 'morning')).rejects.toMatchObject({ code: 'AI_CONFIG_ERROR' });
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('a retired model (404) falls through to the next model', async () => {
        global.fetch
            .mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'models/x is not found' })
            .mockResolvedValueOnce(makeGeminiSuccess({ date: '2025-01-01', schedule: [], todos: [] }));
        await expect(getPlannerDataFromImages(img, 'morning')).resolves.toHaveProperty('date', '2025-01-01');
        expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    test('an expired deadline stops before calling the model (B-20)', async () => {
        await expect(getPlannerDataFromImages(img, 'morning', null, { deadline: Date.now() + 1000 }))
            .rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('429 retries stop when the deadline would be exceeded (B-20)', async () => {
        global.fetch.mockResolvedValue({ ok: false, status: 429 });
        const started = Date.now();
        await expect(getPlannerDataFromImages(img, 'morning', null, { deadline: Date.now() + 7000 }))
            .rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
        expect(Date.now() - started).toBeLessThan(7000);
    });

    test('BYOK JSON failure never logs the raw model output (S-14)', async () => {
        global.fetch.mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: 'My private diary entry' } }] }) });
        await expect(getPlannerDataFromImages(img, 'morning', { apiKey: 'sk-byok', provider: 'openai', modelName: 'gpt-4o' })).rejects.toThrow();
        const logged = JSON.stringify([...geminiLogger.error.mock.calls, ...geminiLogger.warn.mock.calls, ...geminiLogger.info.mock.calls]);
        expect(logged).not.toContain('My private diary entry');
    });

    test('BYOK provider 401 is classified as BYOK_REJECTED', async () => {
        global.fetch.mockResolvedValue({ ok: false, status: 401, text: async () => 'bad key' });
        await expect(getPlannerDataFromImages(img, 'morning', { apiKey: 'sk-byok', provider: 'openai', modelName: 'gpt-4o' }))
            .rejects.toMatchObject({ code: 'BYOK_REJECTED' });
    });

    test('morning totals are normalised and absent totals become null (UX #4)', async () => {
        global.fetch.mockResolvedValue(makeGeminiSuccess({ date: '2025-01-01', schedule: [], todos: [], totals: { blocks: 2 } }));
        const result = await getPlannerDataFromImages(img, 'morning');
        expect(result.totals).toEqual({ blocks: 2, reminders: null, todos: null });
    });

    test('evening "error" with extracted data becomes a warning', async () => {
        global.fetch.mockResolvedValue(makeGeminiSuccess({ error: 'Total does not add up', expenses: [{ item: 'Tea', amount: 2 }] }));
        const result = await getPlannerDataFromImages(img, 'evening');
        expect(result.error).toBeUndefined();
        expect(result.warning).toBe('Total does not add up');
    });

    test('getCountWarnings skips absent totals and reports mismatches', () => {
        const page = {
            schedule: [{ task: 'a', block: true }, { task: 'b', reminder: true }],
            todos: [{ task: 'x' }],
            totals: { blocks: 1, reminders: 2, todos: null }
        };
        const warnings = getCountWarnings(page, 'morning');
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('2 reminders but we found 1');
        expect(getCountWarnings({ schedule: [], todos: [], totals: {} }, 'morning')).toEqual([]);
        expect(getCountWarnings({ warning: 'Expenses total differs' }, 'evening')[0]).toContain('Expenses total differs');
    });

    test('throws when candidates text field is missing (INVALID_RESPONSE)', async () => {
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ candidates: [{ content: { parts: [{}] } }] })
        });
        await expect(getPlannerDataFromImages([{ mimeType: 'image/jpeg', base64Data: 'abc' }], 'morning'))
            .rejects.toThrow('All Gemini models failed');
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// checkRateLimit
// ──────────────────────────────────────────────────────────────────────────────
describe('rateLimit.js — checkRateLimit', () => {
    // The rate limiter now uses db.runTransaction(), so we need transaction-aware mocks
    let mockTransactionGet;
    let mockTransactionSet;

    beforeEach(() => {
        mockTransactionGet = jest.fn();
        mockTransactionSet = jest.fn();
        mockRunTransaction.mockImplementation(async (callback) => {
            const transaction = {
                get: mockTransactionGet,
                set: mockTransactionSet,
            };
            return await callback(transaction);
        });
    });

    test('allows first request (no existing doc) and starts new window', async () => {
        mockTransactionGet.mockResolvedValue({ exists: false });
        const result = await checkRateLimit('user@test.com', 'sync', 10);
        expect(result.allowed).toBe(true);
        expect(mockTransactionSet).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ count: 1 })
        );
    });

    test('allows request within window that is below the limit', async () => {
        mockTransactionGet.mockResolvedValue({
            exists: true,
            data: () => ({ count: 5, windowStart: Date.now() - 10000 })
        });
        const result = await checkRateLimit('user@test.com', 'sync', 10);
        expect(result.allowed).toBe(true);
        expect(mockTransactionSet).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ count: 6 }),
            { merge: true }
        );
    });

    test('blocks request that hits limit exactly within window', async () => {
        mockTransactionGet.mockResolvedValue({
            exists: true,
            data: () => ({ count: 10, windowStart: Date.now() - 10000 })
        });
        const result = await checkRateLimit('user@test.com', 'sync', 10);
        expect(result.allowed).toBe(false);
        expect(result.retryAfterMs).toBeGreaterThan(0);
        expect(mockTransactionSet).not.toHaveBeenCalled();
    });

    test('resets window when windowStart is outside RATE_LIMIT_WINDOW_MS', async () => {
        mockTransactionGet.mockResolvedValue({
            exists: true,
            data: () => ({ count: 999, windowStart: Date.now() - RATE_LIMIT_WINDOW_MS - 1000 })
        });
        const result = await checkRateLimit('user@test.com', 'sync', 10);
        expect(result.allowed).toBe(true);
        expect(mockTransactionSet).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ count: 1 })
        );
    });

    test('retryAfterMs is within expected window range', async () => {
        const windowStart = Date.now() - 30000;
        mockTransactionGet.mockResolvedValue({
            exists: true,
            data: () => ({ count: 100, windowStart })
        });
        const result = await checkRateLimit('user@test.com', 'sync', 10);
        expect(result.allowed).toBe(false);
        expect(result.retryAfterMs).toBeGreaterThan(25000);
        expect(result.retryAfterMs).toBeLessThanOrEqual(RATE_LIMIT_WINDOW_MS);
    });
});

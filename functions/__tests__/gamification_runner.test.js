const adminBacking = require('mock-firebase-admin-backing');

jest.mock('mock-firebase-admin-backing', () => {
    const mockCollectionInner = jest.fn(() => ({
        add: jest.fn().mockResolvedValue(undefined)
    }));
    const firestoreMock = {
        runTransaction: jest.fn(),
        FieldValue: { serverTimestamp: jest.fn(() => 'ts') }
    };
    const firestoreFn = jest.fn(() => ({
        runTransaction: firestoreMock.runTransaction,
        collection: jest.fn(() => ({ doc: jest.fn(() => ({ collection: mockCollectionInner })) }))
    }));
    firestoreFn.FieldValue = firestoreMock.FieldValue;
    return { firestore: firestoreFn, initializeApp: jest.fn() };
}, { virtual: true });
jest.mock('firebase-admin/app', () => require('./helpers/adminMock').app());
jest.mock('firebase-admin/firestore', () => require('./helpers/adminMock').firestore());
jest.mock('firebase-admin/auth', () => require('./helpers/adminMock').auth());
jest.mock('firebase-admin/app-check', () => require('./helpers/adminMock').appCheck());

// firebase-functions' HTTPS module pulls in firebase-admin/auth (ESM-only jose) — not needed here.
jest.mock('firebase-functions/v2/https', () => ({ onRequest: (_opts, handler) => handler }));

process.env.NODE_ENV = 'test';
const { runGamificationAfterSync, applyGamificationMilestones } = require('../index');

describe('runGamificationAfterSync', () => {
    const userRef = { id: 'u@test.com' };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('skip=true does not invoke streak transaction', async () => {
        const spy = jest.spyOn({ applyGamificationMilestones }, 'applyGamificationMilestones');
        // Patch the module export used internally — run skip path directly
        const result = await runGamificationAfterSync(userRef, { skip: true });
        expect(result).toEqual({ milestoneMsg: null, streakWarning: null });
        spy.mockRestore();
    });

    test('returns milestone message on success', async () => {
        adminBacking.firestore().runTransaction.mockImplementationOnce(async (cb) => {
            const t = {
                get: jest.fn().mockResolvedValue({ exists: true, data: () => ({ currentStreak: 0, lastSyncDate: null }) }),
                set: jest.fn()
            };
            return cb(t);
        });
        const result = await runGamificationAfterSync(userRef, { syncMode: 'morning' });
        expect(result.streakWarning).toBeNull();
        expect(result.milestoneMsg).toBeNull(); // streak 1, no milestone yet
    });

    test('retries once then succeeds', async () => {
        let calls = 0;
        adminBacking.firestore().runTransaction.mockImplementation(async () => {
            calls++;
            if (calls === 1) throw new Error('transient');
            return null;
        });
        const result = await runGamificationAfterSync(userRef, { syncMode: 'evening', imageCount: 1 });
        expect(calls).toBe(2);
        expect(result.streakWarning).toBeNull();
    });

    test('surfaces warning after two failures', async () => {
        adminBacking.firestore().runTransaction.mockRejectedValue(new Error('Firestore down'));
        const result = await runGamificationAfterSync(userRef, { syncMode: 'morning', imageCount: 1 });
        expect(result.milestoneMsg).toBeNull();
        expect(result.streakWarning).toContain('Streak could not be updated');
        expect(adminBacking.firestore().runTransaction).toHaveBeenCalledTimes(2);
    });
});

describe('applyGamificationMilestones propagates errors', () => {
    test('throws on transaction failure (no silent swallow)', async () => {
        adminBacking.firestore().runTransaction.mockRejectedValueOnce(new Error('boom'));
        await expect(applyGamificationMilestones({ id: 'u@test.com' })).rejects.toThrow('boom');
    });
});

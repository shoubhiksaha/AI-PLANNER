const admin = require('firebase-admin');

jest.mock('firebase-admin', () => {
    const firestoreMock = { runTransaction: jest.fn() };
    return { firestore: jest.fn(() => firestoreMock), initializeApp: jest.fn() };
});

process.env.NODE_ENV = 'test';
const { applyGamificationMilestones } = require('../index');

function istDateOffset(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function mockUser(overrides = {}) {
    return {
        exists: true,
        data: () => ({
            currentStreak: 0,
            highestStreak: 0,
            streakFreezes: 0,
            dailySyncCount: 0,
            lastSyncDate: null,
            boosterCredits: 0,
            lastAwardedStreak: 0,
            timeZone: 'Asia/Kolkata',
            ...overrides
        })
    };
}

describe('Streak logic probe', () => {
    let mockTransaction;
    let mockUserRef;

    beforeEach(() => {
        mockUserRef = { id: 'u@test.com' };
        mockTransaction = { get: jest.fn(), set: jest.fn() };
        admin.firestore().runTransaction.mockImplementation(async (cb) => cb(mockTransaction));
    });

    async function runScenario(name, userOverrides) {
        mockTransaction.get.mockResolvedValueOnce(mockUser(userOverrides));
        const msg = await applyGamificationMilestones(mockUserRef);
        const written = mockTransaction.set.mock.calls[0]?.[1] || {};
        console.log('PROBE_RESULT ' + JSON.stringify({ scenario: name, msg, written }));
        return written;
    }

    test('S1: same-day re-sync does not advance streak', async () => {
        const today = istDateOffset(0);
        const out = await runScenario('S1_same_day', {
            currentStreak: 5, lastSyncDate: today, dailySyncCount: 1
        });
        expect(out.currentStreak).toBe(5);
        expect(out.dailySyncCount).toBe(2);
    });

    test('S2: future lastSyncDate does not mint freezes (fixed exploit)', async () => {
        const out = await runScenario('S2_future_date', {
            currentStreak: 5, streakFreezes: 0, lastSyncDate: istDateOffset(1)
        });
        expect(out.currentStreak).toBe(5);
        expect(out.streakFreezes).toBe(0);
    });

    test('S3: consecutive day increments streak', async () => {
        const out = await runScenario('S3_consecutive', {
            currentStreak: 5, lastSyncDate: istDateOffset(-1)
        });
        expect(out.currentStreak).toBe(6);
    });

    test('S4: 2-day gap consumes 1 freeze and sustains streak', async () => {
        const out = await runScenario('S4_one_freeze', {
            currentStreak: 10, streakFreezes: 1, lastSyncDate: istDateOffset(-2)
        });
        expect(out.currentStreak).toBe(11);
        expect(out.streakFreezes).toBe(0);
    });

    test('S5: 3-day gap with only 1 freeze breaks streak', async () => {
        const out = await runScenario('S5_break', {
            currentStreak: 10, streakFreezes: 1, lastSyncDate: istDateOffset(-3), lastAwardedStreak: 7
        });
        expect(out.currentStreak).toBe(1);
        expect(out.lastAwardedStreak).toBe(0);
    });

    test('S6: user timezone affects day boundary', async () => {
        const todayNY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        const out = await runScenario('S6_timezone', {
            timeZone: 'America/New_York', currentStreak: 3, lastSyncDate: todayNY
        });
        expect(out.currentStreak).toBe(3);
        expect(out.dailySyncCount).toBe(1); // 0 → +1 on same-day re-sync
    });
});

const adminBacking = require('mock-firebase-admin-backing');

// Mock firebase-admin completely
jest.mock('mock-firebase-admin-backing', () => {
    const firestoreMock = {
        runTransaction: jest.fn()
    };
    return {
        firestore: jest.fn(() => firestoreMock),
        initializeApp: jest.fn(),
        credential: { cert: jest.fn() }
    };
}, { virtual: true });
jest.mock('firebase-admin/app', () => require('./helpers/adminMock').app());
jest.mock('firebase-admin/firestore', () => require('./helpers/adminMock').firestore());
jest.mock('firebase-admin/auth', () => require('./helpers/adminMock').auth());
jest.mock('firebase-admin/app-check', () => require('./helpers/adminMock').appCheck());

// firebase-functions' HTTPS module pulls in firebase-admin/auth (ESM-only jose) — not needed here.
jest.mock('firebase-functions/v2/https', () => ({ onRequest: (_opts, handler) => handler }));

process.env.NODE_ENV = 'test';
// Load index, which uses our mocked admin
const { applyGamificationMilestones } = require('../index');

describe('Gamification Milestones', () => {
    let mockTransaction;
    let mockUserRef;
    let mockGet;

    beforeEach(() => {
        mockGet = jest.fn();
        mockUserRef = { id: 'test@example.com' };

        mockTransaction = {
            get: mockGet,
            set: jest.fn()
        };

        adminBacking.firestore().runTransaction.mockImplementation(async (callback) => {
            return await callback(mockTransaction);
        });
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('should award 7-day streak +5 credits', async () => {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

        mockGet.mockResolvedValueOnce({
            exists: true,
            data: () => ({
                currentStreak: 6,
                highestStreak: 6,
                dailySyncCount: 1,
                lastSyncDate: yesterdayStr,
                boosterCredits: 0,
                streakFreezes: 0,
                lastAwardedStreak: 0
            })
        });

        const msg = await applyGamificationMilestones(mockUserRef);
        
        expect(msg).toContain('🌟 Great work! 7-Day Streak. Awarded +5 Booster Credits!');
        expect(mockTransaction.set).toHaveBeenCalledWith(
            mockUserRef,
            expect.objectContaining({
                currentStreak: 7,
                boosterCredits: 5,
                lastAwardedStreak: 7
            }),
            { merge: true }
        );
    });

    it('should not dual-award a 7-day streak', async () => {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

        mockGet.mockResolvedValueOnce({
            exists: true,
            data: () => ({
                currentStreak: 7, 
                highestStreak: 7,
                dailySyncCount: 1,
                lastSyncDate: yesterdayStr,
                boosterCredits: 5,
                streakFreezes: 0,
                lastAwardedStreak: 7 // already claimed
            })
        });

        const msg = await applyGamificationMilestones(mockUserRef);
        
        expect(msg).toBeNull();
        expect(mockTransaction.set).toHaveBeenCalledWith(
            mockUserRef,
            expect.objectContaining({
                currentStreak: 8,
                boosterCredits: 5,
                lastAwardedStreak: 7
            }),
            { merge: true }
        );
    });

    it('should award 30-day streak +20 credits +1 freeze', async () => {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

        mockGet.mockResolvedValueOnce({
            exists: true,
            data: () => ({
                currentStreak: 29,
                highestStreak: 29,
                dailySyncCount: 1,
                lastSyncDate: yesterdayStr,
                boosterCredits: 5,
                streakFreezes: 0,
                lastAwardedStreak: 7
            })
        });

        const msg = await applyGamificationMilestones(mockUserRef);
        
        expect(msg).toContain('🔥 Amazing! 30-Day Streak. Awarded +20 Booster Credits & 1 Freeze!');
        expect(mockTransaction.set).toHaveBeenCalledWith(
            mockUserRef,
            expect.objectContaining({
                currentStreak: 30,
                boosterCredits: 25,
                streakFreezes: 1,
                lastAwardedStreak: 30
            }),
            { merge: true }
        );
    });
    
    it('should reset lastAwardedStreak if streak breaks', async () => {
        const threeDaysAgo = new Date();
        threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
        const oldStr = threeDaysAgo.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

        mockGet.mockResolvedValueOnce({
            exists: true,
            data: () => ({
                currentStreak: 35,
                highestStreak: 35,
                dailySyncCount: 1,
                lastSyncDate: oldStr, // Missed more than 1 day
                boosterCredits: 25,
                streakFreezes: 0,
                lastAwardedStreak: 30
            })
        });

        const msg = await applyGamificationMilestones(mockUserRef);
        
        expect(msg).toBeNull();
        expect(mockTransaction.set).toHaveBeenCalledWith(
            mockUserRef,
            expect.objectContaining({
                currentStreak: 1,
                lastAwardedStreak: 0
            }),
            { merge: true }
        );
    });
});

/**
 * C11: reconcileStuckSyncs refunds interrupted syncs exactly once.
 */
const { createFakeFirestore, FieldValue } = require('./helpers/fakeFirestore');

jest.mock('mock-firebase-admin-backing', () => {
    const { FieldValue: FV } = require('./helpers/fakeFirestore');
    return { initializeApp: jest.fn(), firestore: Object.assign(jest.fn(), { FieldValue: FV }) };
}, { virtual: true });
jest.mock('firebase-admin/app', () => require('./helpers/adminMock').app());
jest.mock('firebase-admin/firestore', () => require('./helpers/adminMock').firestore());
jest.mock('firebase-admin/auth', () => require('./helpers/adminMock').auth());
jest.mock('firebase-admin/app-check', () => require('./helpers/adminMock').appCheck());

const { reconcileStuckSyncs, reconcileStuckSync, STUCK_AFTER_MS } = require('../sync/reconcile');

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const minutesAgo = (m) => new Date(NOW - m * 60 * 1000);
const USER = 'users/a@example.com';

function seed(db, id, record) {
    db._seed(`${USER}/syncHistory/${id}`, record);
}

describe('reconcileStuckSyncs', () => {
    let db;
    beforeEach(() => {
        db = createFakeFirestore({ now: () => new Date(NOW) });
        db._seed(USER, { tierCredits: 3, boosterCredits: 1 });
    });

    test('refunds a processing record older than 15 minutes and marks it interrupted', async () => {
        seed(db, 'stuck', { status: 'processing', startedAt: minutesAgo(20), creditsDeducted: { tier: 1, booster: 2 }, refunded: false });

        const stats = await reconcileStuckSyncs({ db, now: NOW });

        expect(stats).toEqual(expect.objectContaining({ scanned: 1, refunded: 1, failed: 0 }));
        expect(db._read(USER)).toEqual({ tierCredits: 4, boosterCredits: 3 });
        expect(db._read(`${USER}/syncHistory/stuck`)).toEqual(expect.objectContaining({
            status: 'failed', failureReason: 'interrupted', refunded: true, reconciledAt: new Date(NOW)
        }));
    });

    test('is idempotent: a second run refunds nothing', async () => {
        seed(db, 'stuck', { status: 'processing', startedAt: minutesAgo(30), creditsDeducted: { tier: 1, booster: 0 }, refunded: false });
        await reconcileStuckSyncs({ db, now: NOW });
        const second = await reconcileStuckSyncs({ db, now: NOW });
        expect(second.scanned).toBe(0);
        expect(db._read(USER).tierCredits).toBe(4);
        // Calling the per-document step again directly is also a no-op.
        await expect(reconcileStuckSync(db, db.collection(`${USER}/syncHistory`).doc('stuck'), { now: NOW })).resolves.toBe('skipped');
        expect(db._read(USER).tierCredits).toBe(4);
    });

    test('already finalised records are untouched', async () => {
        const success = { status: 'success', startedAt: minutesAgo(60), creditsDeducted: { tier: 1, booster: 0 }, refunded: false, message: 'ok' };
        const failed = { status: 'failed', startedAt: minutesAgo(60), creditsDeducted: { tier: 1, booster: 0 }, refunded: true };
        seed(db, 'ok', success);
        seed(db, 'bad', failed);
        const writesBefore = db._stats.writes;

        const stats = await reconcileStuckSyncs({ db, now: NOW });

        expect(stats.scanned).toBe(0);
        expect(db._stats.writes).toBe(writesBefore);
        expect(db._read(`${USER}/syncHistory/ok`)).toEqual(success);
        expect(db._read(`${USER}/syncHistory/bad`)).toEqual(failed);
        expect(db._read(USER)).toEqual({ tierCredits: 3, boosterCredits: 1 });
        // Even when handed a finalised record directly, nothing changes.
        await expect(reconcileStuckSync(db, db.collection(`${USER}/syncHistory`).doc('ok'), { now: NOW })).resolves.toBe('skipped');
        expect(db._stats.writes).toBe(writesBefore);
    });

    test('recent processing records (still within 15 minutes) are left alone', async () => {
        seed(db, 'fresh', { status: 'processing', startedAt: minutesAgo(5), creditsDeducted: { tier: 1, booster: 0 }, refunded: false });
        const stats = await reconcileStuckSyncs({ db, now: NOW });
        expect(stats.scanned).toBe(0);
        expect(db._read(`${USER}/syncHistory/fresh`).status).toBe('processing');
        expect(db._read(USER).tierCredits).toBe(3);
    });

    test('a record re-reserved by a retry after the query is skipped inside the transaction', async () => {
        seed(db, 'retry', { status: 'processing', startedAt: minutesAgo(1), creditsDeducted: { tier: 1, booster: 0 }, refunded: false });
        const ref = db.collection(`${USER}/syncHistory`).doc('retry');
        await expect(reconcileStuckSync(db, ref, { now: NOW })).resolves.toBe('skipped');
        expect(db._read(USER).tierCredits).toBe(3);
    });

    test('processing + refunded:true (the request refunded, then died) is finalised without a second refund', async () => {
        seed(db, 'half', { status: 'processing', startedAt: minutesAgo(20), creditsDeducted: { tier: 1, booster: 0 }, refunded: true });
        const stats = await reconcileStuckSyncs({ db, now: NOW });
        expect(stats.finalised).toBe(1);
        expect(db._read(USER).tierCredits).toBe(3);
        expect(db._read(`${USER}/syncHistory/half`)).toEqual(expect.objectContaining({ status: 'failed', failureReason: 'interrupted', refunded: true }));
    });

    test('BYOK syncs (nothing deducted) are finalised with no credit change', async () => {
        seed(db, 'byok', { status: 'processing', startedAt: minutesAgo(20), creditsDeducted: { tier: 0, booster: 0 }, refunded: false });
        await reconcileStuckSyncs({ db, now: NOW });
        expect(db._read(USER)).toEqual({ tierCredits: 3, boosterCredits: 1 });
        expect(db._read(`${USER}/syncHistory/byok`).status).toBe('failed');
    });

    test('a failing record is counted and does not stop the others', async () => {
        seed(db, 'a', { status: 'processing', startedAt: minutesAgo(40), creditsDeducted: { tier: 1, booster: 0 }, refunded: false });
        seed(db, 'b', { status: 'processing', startedAt: minutesAgo(30), creditsDeducted: { tier: 1, booster: 0 }, refunded: false });
        const realTx = db.runTransaction;
        let calls = 0;
        db.runTransaction = (fn) => (++calls === 1 ? Promise.reject(new Error('contention')) : realTx(fn));
        const stats = await reconcileStuckSyncs({ db, now: NOW });
        expect(stats).toEqual(expect.objectContaining({ scanned: 2, refunded: 1, failed: 1 }));
        expect(db._read(USER).tierCredits).toBe(4);
    });

    test('uses the documented 15-minute threshold and FieldValue sentinels', () => {
        expect(STUCK_AFTER_MS).toBe(15 * 60 * 1000);
        expect(FieldValue.increment(1)).toEqual({ __fv: 'increment', n: 1 });
    });
});

describe('reconcileStuckSyncs export', () => {
    test('is a scheduled function every 15 minutes in the FUNCTIONS_REGION param region', () => {
        jest.isolateModules(() => {
            jest.doMock('firebase-functions/v2/https', () => ({ onRequest: (_opts, handler) => handler }));
            jest.doMock('../services/kms', () => ({ generateAndWrapDEK: jest.fn(), unwrapAndDecrypt: jest.fn() }));
            const fns = require('../index');
            const endpoint = fns.reconcileStuckSyncs.__endpoint;
            expect(endpoint.scheduleTrigger.schedule).toBe('every 15 minutes');
            // setGlobalOptions({ region: FUNCTIONS_REGION }): resolved per environment at deploy time.
            expect(String(endpoint.region)).toBe('params.FUNCTIONS_REGION');
            expect(typeof fns.reconcileStuckSyncs.run).toBe('function');
        });
    });
});

describe('reconcileStuckSyncs database', () => {
    test('defaults to this environment\'s database (FIRESTORE_DATABASE_ID)', async () => {
        const fakeDb = createFakeFirestore();
        fakeDb._seed('users/a@example.com', { tierCredits: 0 });
        fakeDb._seed('users/a@example.com/syncHistory/s', { status: 'processing', startedAt: minutesAgo(20), creditsDeducted: { tier: 1, booster: 0 }, refunded: false });
        let run;
        let envDb;
        jest.isolateModules(() => {
            jest.doMock('../services/db', () => ({ db: jest.fn(() => fakeDb) }));
            ({ reconcileStuckSyncs: run } = require('../sync/reconcile'));
            ({ db: envDb } = require('../services/db'));
        });
        const stats = await run({ now: NOW });
        expect(envDb).toHaveBeenCalledTimes(1);
        expect(stats.refunded).toBe(1);
        expect(fakeDb._read('users/a@example.com').tierCredits).toBe(1);
    });
});

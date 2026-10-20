/**
 * C11: refunds syncs that were interrupted (instance crash, OOM, timeout) after
 * credits were deducted but before the request could finalise its syncHistory
 * record. Runs every 15 minutes as the `reconcileStuckSyncs` scheduled function.
 */
const { FieldValue } = require('firebase-admin/firestore');
const { db: environmentDb } = require('../services/db');
const { logger } = require('firebase-functions/logger');

const STUCK_AFTER_MS = 15 * 60 * 1000;
const RECONCILE_BATCH_LIMIT = 300;

function toMillis(value) {
    if (value == null) return NaN;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (value instanceof Date) return value.getTime();
    return Number(value);
}

function creditAmount(value) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * Finalise one stuck record in a transaction. Idempotent: a record that is no
 * longer `processing` (finalised, or already reconciled) is left untouched, and
 * credits are only returned while `refunded` is false.
 * @returns {Promise<'refunded'|'finalised'|'skipped'>}
 */
async function reconcileStuckSync(db, historyRef, { now = Date.now() } = {}) {
    return db.runTransaction(async (t) => {
        const snap = await t.get(historyRef);
        if (!snap.exists) return 'skipped';
        const record = snap.data() || {};
        if (record.status !== 'processing') return 'skipped';
        // A retry with the same clientRequestId may have re-reserved the record since the query.
        const startedAtMs = Number.isFinite(toMillis(record.startedAt)) ? toMillis(record.startedAt) : toMillis(record.startedAtMs);
        if (!Number.isFinite(startedAtMs) || now - startedAtMs < STUCK_AFTER_MS) return 'skipped';

        const final = {
            status: 'failed',
            failureReason: 'interrupted',
            refunded: true,
            reconciledAt: FieldValue.serverTimestamp(),
        };
        if (record.refunded === true) {
            // The request refunded the credit itself but died before finalising.
            t.update(historyRef, final);
            return 'finalised';
        }

        const tier = creditAmount(record.creditsDeducted?.tier);
        const booster = creditAmount(record.creditsDeducted?.booster);
        const userRef = historyRef.parent.parent;
        if ((tier > 0 || booster > 0) && userRef) {
            const userSnap = await t.get(userRef);
            if (userSnap.exists) {
                const updates = {};
                if (tier > 0) updates.tierCredits = FieldValue.increment(tier);
                if (booster > 0) updates.boosterCredits = FieldValue.increment(booster);
                t.update(userRef, updates);
            }
        }
        t.update(historyRef, final);
        return 'refunded';
    });
}

/**
 * Find `processing` syncHistory records older than 15 minutes (collection-group
 * query; index: syncHistory status ASC, startedAt ASC) and reconcile each.
 * Reads only this environment's database (FIRESTORE_DATABASE_ID).
 */
async function reconcileStuckSyncs({ db = environmentDb(), now = Date.now(), limit = RECONCILE_BATCH_LIMIT } = {}) {
    const cutoff = new Date(now - STUCK_AFTER_MS);
    const snap = await db.collectionGroup('syncHistory')
        .where('status', '==', 'processing')
        .where('startedAt', '<', cutoff)
        .orderBy('startedAt', 'asc')
        .limit(limit)
        .get();

    const stats = { scanned: snap.docs.length, refunded: 0, finalised: 0, skipped: 0, failed: 0 };
    for (const doc of snap.docs) {
        try {
            const outcome = await reconcileStuckSync(db, doc.ref, { now });
            stats[outcome] += 1;
        } catch (err) {
            stats.failed += 1;
            logger.error("Failed to reconcile stuck sync", { syncId: doc.id, error: err?.message });
        }
    }
    if (stats.scanned > 0) logger.warn("Reconciled interrupted syncs", stats);
    return stats;
}

module.exports = {
    STUCK_AFTER_MS,
    reconcileStuckSync,
    reconcileStuckSyncs,
};

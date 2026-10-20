const { logger } = require('firebase-functions/logger');

const PAGE_SIZE = 300;
const WRITE_BATCH_SIZE = 400;
const GRANT_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
// A run lock older than this is considered abandoned (adminGrantCredits times out at 540 s).
const STALE_LOCK_MS = 10 * 60 * 1000;

function isValidGrantId(grantId) {
    return typeof grantId === 'string' && GRANT_ID_RE.test(grantId);
}

/**
 * Grant `amount` booster credits to every user exactly once per `grantId`.
 *
 * Idempotency: each user document records applied grant ids in
 * `appliedCreditGrants`; documents that already contain `grantId` are skipped,
 * so a retry after a timeout or a failed batch never double-grants. A run lock
 * in `adminCreditGrants/{grantId}` prevents two concurrent runs of the same grant.
 * Writes use set({ merge: true }) so a user deleted mid-run does not fail a batch.
 * Only aggregate counts are logged (no emails or document paths).
 */
async function grantBoosterCreditsToAllUsers(db, amount, { dryRun = false, grantId } = {}) {
    if (!Number.isInteger(amount) || amount <= 0) {
        throw new Error('Amount must be a positive integer.');
    }
    if (!isValidGrantId(grantId)) {
        throw new Error('grantId must be 6-64 characters of letters, digits, "_" or "-".');
    }

    const { FieldValue, FieldPath } = require('firebase-admin/firestore');

    const stats = {
        mode: dryRun ? 'dry-run' : 'apply',
        grantId,
        amount,
        usersScanned: 0,
        writesQueued: 0,
        alreadyGranted: 0,
    };

    const lockRef = db.collection('adminCreditGrants').doc(grantId);
    if (!dryRun) {
        const lockState = await db.runTransaction(async (t) => {
            const snap = await t.get(lockRef);
            const data = snap.exists ? snap.data() : null;
            if (data?.status === 'completed') return { completed: true, stats: data.stats || null };
            const startedAtMs = Number(data?.startedAtMs || 0);
            if (data?.status === 'running' && Date.now() - startedAtMs < STALE_LOCK_MS) {
                return { running: true };
            }
            t.set(lockRef, { status: 'running', amount, startedAtMs: Date.now() }, { merge: true });
            return { acquired: true };
        });
        if (lockState.completed) {
            return { ...stats, alreadyCompleted: true, previousStats: lockState.stats };
        }
        if (lockState.running) {
            const err = new Error('This grant is already running.');
            err.code = 'GRANT_IN_PROGRESS';
            throw err;
        }
    }

    let batch = db.batch();
    let batchCount = 0;
    async function commitIfNeeded(force = false) {
        if (dryRun || batchCount === 0) return;
        if (!force && batchCount < WRITE_BATCH_SIZE) return;
        await batch.commit();
        batch = db.batch();
        batchCount = 0;
    }

    try {
        let lastDoc = null;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            let query = db.collection('users').orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
            if (lastDoc) query = query.startAfter(lastDoc);

            const snap = await query.get();
            if (!snap || snap.empty || !snap.docs || snap.docs.length === 0) break;

            for (const doc of snap.docs) {
                stats.usersScanned += 1;
                lastDoc = doc;
                const data = typeof doc.data === 'function' ? (doc.data() || {}) : {};
                if (Array.isArray(data.appliedCreditGrants) && data.appliedCreditGrants.includes(grantId)) {
                    stats.alreadyGranted += 1;
                    continue;
                }
                stats.writesQueued += 1;
                if (!dryRun) {
                    batch.set(doc.ref, {
                        boosterCredits: FieldValue.increment(amount),
                        appliedCreditGrants: FieldValue.arrayUnion(grantId),
                    }, { merge: true });
                    batchCount += 1;
                    await commitIfNeeded();
                }
            }
            logger.info('Credit grant progress', { grantId, usersScanned: stats.usersScanned, writesQueued: stats.writesQueued });
        }

        await commitIfNeeded(true);
        if (!dryRun) {
            await lockRef.set({ status: 'completed', completedAtMs: Date.now(), stats }, { merge: true });
        }
        return stats;
    } catch (err) {
        if (!dryRun) {
            await lockRef.set({ status: 'failed', failedAtMs: Date.now(), error: String(err?.message || err).slice(0, 200) }, { merge: true })
                .catch(() => {});
        }
        throw err;
    }
}

module.exports = {
    grantBoosterCreditsToAllUsers,
    isValidGrantId,
};

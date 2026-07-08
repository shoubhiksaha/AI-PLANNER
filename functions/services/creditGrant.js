const { logger } = require('firebase-functions/logger');

const PAGE_SIZE = 300;
const WRITE_BATCH_SIZE = 400;

async function grantBoosterCreditsToAllUsers(db, amount, { dryRun = false } = {}) {
    if (!Number.isInteger(amount) || amount <= 0) {
        throw new Error('Amount must be a positive integer.');
    }

    const admin = require('firebase-admin');
    const FieldValue = admin.firestore.FieldValue;
    const FieldPath = admin.firestore.FieldPath;

    let batch = db.batch();
    let batchCount = 0;
    const stats = {
        mode: dryRun ? 'dry-run' : 'apply',
        amount,
        usersScanned: 0,
        writesQueued: 0,
    };

    async function commitIfNeeded(force = false) {
        if (dryRun) return;
        if (batchCount === 0) return;
        if (!force && batchCount < WRITE_BATCH_SIZE) return;
        await batch.commit();
        batch = db.batch();
        batchCount = 0;
    }

    let lastDoc = null;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        let query = db.collection('users').orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
        if (lastDoc) query = query.startAfter(lastDoc);

        const snap = await query.get();
        if (snap.empty) break;

        for (const doc of snap.docs) {
            stats.usersScanned += 1;
            stats.writesQueued += 1;
            logger.info(`${dryRun ? 'DRY-RUN' : 'QUEUE'} ${doc.ref.path}: +${amount} boosterCredits`);
            if (!dryRun) {
                batch.update(doc.ref, { boosterCredits: FieldValue.increment(amount) });
                batchCount += 1;
                await commitIfNeeded();
            }
            lastDoc = doc;
        }
    }

    await commitIfNeeded(true);
    return stats;
}

module.exports = {
    grantBoosterCreditsToAllUsers,
};

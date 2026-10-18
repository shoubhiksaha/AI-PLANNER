/** syncHistory records and per-user usage counters. */
const { FieldValue } = require('firebase-admin/firestore');
const { logger } = require('firebase-functions/logger');

/**
 * Write a syncHistory entry. With `docRef` the entry is upserted at that id
 * (the clientRequestId-keyed record used for idempotency); otherwise appended.
 */
async function logSyncHistory(userRef, syncType, imageCount, status, message, extra = {}, docRef = null) {
    try {
        const entry = {
            timestamp: FieldValue.serverTimestamp(),
            syncType,
            imageCount,
            status,
            message,
            ...extra
        };
        if (docRef) await docRef.set(entry, { merge: true });
        else await userRef.collection('syncHistory').add(entry);
    } catch (error) {
        logger.error("Failed to log sync history", { error: error.message });
    }
}

async function incrementUsageCounters(userRef, imageCount) {
    try {
        await userRef.set({
            totalSyncs: FieldValue.increment(1),
            totalImagesProcessed: FieldValue.increment(imageCount)
        }, { merge: true });
    } catch (error) {
        logger.error("Failed to increment usage counters", { error: error.message });
    }
}

module.exports = { logSyncHistory, incrementUsageCounters };

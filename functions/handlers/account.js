/** GDPR endpoints: exportUserData and deleteUserAccount. */
const { FieldValue, FieldPath } = require('firebase-admin/firestore');
const { db } = require('../services/db');
const { getAuth } = require('firebase-admin/auth');
const crypto = require('crypto');
const { logger } = require('firebase-functions/logger');
const { ERROR_CODES: E, sendError, guardRequest } = require('../services/requestGuard');
const { computeDisplayStreak } = require('../utils');

// deleteUserAccount requires a sign-in at most this many seconds old.
const RECENT_AUTH_MAX_AGE_SECONDS = 5 * 60;

function serializeFirestoreValue(value) {
    if (value == null) return value;
    if (typeof value.toDate === 'function') return value.toDate().toISOString();
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(serializeFirestoreValue);
    if (typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, serializeFirestoreValue(val)]));
    }
    return value;
}

// --- GDPR: Export User Data ---
async function exportUserDataHandler(req, res) {
    const identity = await guardRequest(req, res, { endpoint: 'exportUserData', tokenField: 'token', checkRevoked: true });
    if (!identity) return;
    const { email: userEmail, uid, decodedToken } = identity;
    const requestId = crypto.randomUUID();

    try {
        const firestore = db();
        const userRef = firestore.collection('users').doc(userEmail);
        const snap = await userRef.get();
        const paymentSnap = await firestore.collection('cashfree_orders')
            .where('userEmail', '==', userEmail)
            .get();

        const exportData = {
            exportedAt: new Date().toISOString(),
            email: userEmail,
            uid: decodedToken.uid,
            accountExists: snap.exists,
            data: {},
            payments: paymentSnap.docs.map(doc => {
                const payment = doc.data();
                return serializeFirestoreValue({
                    orderId: doc.id,
                    price: payment.price ?? null,
                    amountPaise: payment.amountPaise ?? null,
                    currency: payment.currency || 'INR',
                    environment: payment.environment || null,
                    status: payment.status || null,
                    createdAt: payment.createdAt || null,
                    updatedAt: payment.updatedAt || null,
                    cashfreePaymentId: payment.cashfreePaymentId || null,
                    paymentStatus: payment.paymentStatus || null,
                    paymentAmount: payment.paymentAmount ?? null,
                    paymentCurrency: payment.paymentCurrency || null
                });
            })
        };

        if (snap.exists) {
            const raw = snap.data();
            exportData.data = serializeFirestoreValue({
                displayName: raw.displayName || null,
                expoPushToken: raw.expoPushToken || null,
                setupComplete: !!raw.setupComplete,
                timeZone: raw.timeZone || null,
                dedupCalendar: raw.dedupCalendar ?? null,
                dedupTasks: raw.dedupTasks ?? null,
                tier: raw.tier || 'free',
                tierCredits: raw.tierCredits || 0,
                boosterCredits: raw.boosterCredits || 0,
                isPremium: !!raw.isPremium,
                subscriptionExpiryDate: raw.subscriptionExpiryDate || null,
                currentStreak: computeDisplayStreak(raw),
                highestStreak: raw.highestStreak || 0,
                streakFreezes: raw.streakFreezes || 0,
                dailySyncCount: raw.dailySyncCount || 0,
                lastSyncDate: raw.lastSyncDate || null,
                subscriptionRenewalDate: raw.subscriptionRenewalDate || null,
                lastTierCreditRenewalAt: raw.lastTierCreditRenewalAt || null,
                lastAwardedStreak: raw.lastAwardedStreak || 0,
                totalSyncs: raw.totalSyncs || 0,
                totalImagesProcessed: raw.totalImagesProcessed || 0,
                notionConfigured: !!raw.notionKey,
                notionDbId: raw.notionDbId || null,
                byokConfigured: !!raw.byokKmsData,
                legacyByokFieldsPresent: !!(raw.byokConfig || raw.geminiKey),
                byokProvider: raw.byokKmsData?.provider || null,
                byokModelName: raw.byokKmsData?.modelName || null,
                byokCustomUrlConfigured: !!raw.byokKmsData?.baseUrl,
                spreadsheetId: raw.spreadsheetId || null,
                createdAt: raw.createdAt || null,
                updatedAt: raw.updatedAt || null
                // Encrypted and plaintext secret material is intentionally excluded.
            });

            const historySnap = await userRef.collection('syncHistory')
                .orderBy('timestamp', 'desc').get();
            exportData.data.syncHistory = historySnap.docs.map(doc => {
                const data = doc.data();
                return serializeFirestoreValue({
                    syncId: doc.id,
                    timestamp: data.timestamp || null,
                    status: data.status,
                    syncType: data.syncType,
                    imageCount: data.imageCount || 0,
                    message: data.message,
                    counts: data.counts || null,
                    creditsCharged: data.creditsCharged ?? null
                });
            });
        }

        logger.info("Data export completed", { uid, requestId });
        return res.status(200).send(exportData);
    } catch (err) {
        logger.error("Export error", { error: err.message, requestId, uid });
        return sendError(res, 500, E.INTERNAL, "Failed to export data.");
    }
}

// --- GDPR: Delete User Account ---
// Requires a sign-in within the last 5 minutes. Payment records are kept for
// tax/audit purposes but anonymised (no email, uid or checkout session).
async function deleteUserAccountHandler(req, res) {
    const identity = await guardRequest(req, res, { endpoint: 'deleteUserAccount', tokenField: 'token', checkRevoked: true });
    if (!identity) return;
    const { email: userEmail, uid, decodedToken } = identity;
    const requestId = crypto.randomUUID();

    const authTime = Number(decodedToken.auth_time);
    if (!Number.isFinite(authTime) || (Date.now() / 1000) - authTime > RECENT_AUTH_MAX_AGE_SECONDS) {
        return sendError(res, 401, E.REAUTH_REQUIRED, "For your security, please sign in again before deleting your account.");
    }

    try {
        const firestore = db();
        const userRef = firestore.collection('users').doc(userEmail);

        const historySnap = await userRef.collection('syncHistory').get();
        const rateLimitSnap = await firestore.collection('rateLimits')
            .where(FieldPath.documentId(), '>=', `${userEmail}_`)
            .where(FieldPath.documentId(), '<', `${userEmail}_`)
            .get();
        const paymentSnap = await firestore.collection('cashfree_orders')
            .where('userEmail', '==', userEmail)
            .get();

        const del = FieldValue.delete();
        const operations = [
            ...historySnap.docs.map(d => (batch) => batch.delete(d.ref)),
            ...rateLimitSnap.docs.map(d => (batch) => batch.delete(d.ref)),
            ...paymentSnap.docs.map(d => (batch) => batch.update(d.ref, {
                userEmail: null,
                userId: null,
                payment_session_id: del,
                userDeleted: true,
                anonymisedAt: FieldValue.serverTimestamp()
            })),
            (batch) => batch.delete(userRef)
        ];

        // Firestore limits batches to 500 writes. Only remove the Auth account after
        // every database batch succeeds, so a retry remains possible after a failure.
        for (let i = 0; i < operations.length; i += 500) {
            const batch = firestore.batch();
            operations.slice(i, i + 500).forEach(op => op(batch));
            await batch.commit();
        }
        await getAuth().deleteUser(uid);

        logger.info("Account fully deleted (Firestore + Auth)", { requestId, uid, anonymisedOrders: paymentSnap.docs.length });
        return res.status(200).send({ success: true, text: "Your account data has been permanently deleted." });
    } catch (err) {
        logger.error("Delete error", { error: err.message, requestId, uid });
        return sendError(res, 500, E.INTERNAL, "Failed to delete account.");
    }
}

module.exports = {
    exportUserDataHandler,
    deleteUserAccountHandler,
};

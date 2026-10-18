/**
 * Credit ledger for one sync request: the transactional idempotency check,
 * tier renewal and credit deduction, and the refund path.
 */
const { FieldValue } = require('firebase-admin/firestore');
const { db } = require('../services/db');
const { logger } = require('firebase-functions/logger');
const { ERROR_CODES: E } = require('../services/requestGuard');
const { todayInTimeZone } = require('../utils');
const {
    TIER_CREDITS,
    GAMIFICATION_DEFAULTS,
    buildNewUserDoc,
    checkFeaturesAndCredits,
    needsTierCreditRenewal,
    stampTierCreditRenewal,
} = require('./userPlan');
const { SyncError } = require('./errors');

// syncPlanner: the whole AI step (retries + model cascade) must end by
// request start + AI_BUDGET_MS, leaving ~120 s of the 300 s timeout for the
// Google/Notion writes and for refunding the credit on failure.
const SYNC_TIMEOUT_SECONDS = 300;
const AI_BUDGET_MS = 180 * 1000;
// A reserved (processing) sync record blocks duplicate retries for this long.
const SYNC_IN_PROGRESS_TTL_MS = (SYNC_TIMEOUT_SECONDS + 60) * 1000;

function positiveInt(value) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * Per-request credit state. `settled` = final decision made (kept or refunded).
 * refund() is idempotent and returns whether the deducted credits were returned.
 *
 * Once the syncHistory record is reserved (`credit.historyRef`), the refund and
 * `refunded: true` on that record are written in one transaction, so the
 * reconcileStuckSyncs job can never refund the same sync a second time.
 */
function createCreditLedger(userRef, { requestId, uid }) {
    const credit = {
        tier: 0,
        booster: 0,
        refunded: false,
        settled: false,
        historyRef: null,
        async refund() {
            if (credit.refunded) return true;
            if (credit.tier <= 0 && credit.booster <= 0) return false;
            try {
                const updates = {};
                if (credit.tier > 0) updates.tierCredits = FieldValue.increment(credit.tier);
                if (credit.booster > 0) updates.boosterCredits = FieldValue.increment(credit.booster);
                if (credit.historyRef) {
                    const historyRef = credit.historyRef;
                    const applied = await db().runTransaction(async (t) => {
                        const historySnap = await t.get(historyRef);
                        if (historySnap.exists && (historySnap.data() || {}).refunded === true) return false;
                        t.update(userRef, updates);
                        t.set(historyRef, { refunded: true }, { merge: true });
                        return true;
                    });
                    if (!applied) logger.warn("Sync credits were already refunded", { requestId, uid });
                } else {
                    await userRef.update(updates);
                }
                credit.refunded = true;
                logger.info("Refunded sync credits", { requestId, uid, tier: credit.tier, booster: credit.booster });
                return true;
            } catch (refundErr) {
                logger.error("Failed to refund credits", { error: refundErr.message, requestId, uid });
                return false;
            }
        },
    };
    return credit;
}

/**
 * Transactional idempotency check, plan/credit check and deduction. Reserves
 * `historyRef` as a `processing` record in the same transaction.
 * @returns {Promise<{ duplicate: object } | { userData: object, tierDeducted: number, boosterDeducted: number }>}
 */
async function reserveSyncCredits({ db, userRef, historyRef, timeZone, mode, imageCount, hasBYOK, requestId, uid }) {
    try {
        return await db.runTransaction(async (t) => {
            const docSnap = await t.get(userRef);
            const historySnap = await t.get(historyRef);

            // Credits of an earlier attempt with this id that died mid-sync (stale
            // `processing`, never refunded). Re-reserving overwrites its
            // creditsDeducted, so they are returned here instead of by the reconciler.
            let staleRefund = { tier: 0, booster: 0 };
            if (historySnap.exists) {
                const previous = historySnap.data() || {};
                if (previous.status === 'success') return { duplicate: previous };
                if (previous.status === 'processing' && Date.now() - Number(previous.startedAtMs || 0) < SYNC_IN_PROGRESS_TTL_MS) {
                    throw new SyncError(409, E.SYNC_IN_PROGRESS, "This sync is still being processed. Check your History in a moment.");
                }
                if (previous.status === 'processing' && previous.refunded !== true) {
                    staleRefund = {
                        tier: positiveInt(previous.creditsDeducted?.tier),
                        booster: positiveInt(previous.creditsDeducted?.booster),
                    };
                }
            }

            const isNewUser = !docSnap.exists;
            const rawData = isNewUser ? buildNewUserDoc(timeZone) : { ...docSnap.data() };
            const updateObj = isNewUser ? { ...rawData } : {};

            const todayStr = todayInTimeZone(timeZone);
            for (const [key, val] of Object.entries(GAMIFICATION_DEFAULTS)) {
                if (rawData[key] === undefined) {
                    updateObj[key] = val;
                    rawData[key] = val;
                }
            }

            // Persist the user's resolved timezone so streak + renewal day
            // boundaries use their local time on this and future requests.
            if (rawData.timeZone !== timeZone) {
                rawData.timeZone = timeZone;
                updateObj.timeZone = timeZone;
            }

            // Check Subscription Expiry BEFORE renewing credits
            if (rawData.tier !== 'free' && rawData.subscriptionExpiryDate) {
                const expiry = new Date(rawData.subscriptionExpiryDate);
                if (expiry < new Date()) {
                    rawData.tier = 'free';
                    rawData.isPremium = false;
                    rawData.tierCredits = TIER_CREDITS.free;
                    updateObj.tier = 'free';
                    updateObj.isPremium = false;
                    updateObj.tierCredits = TIER_CREDITS.free;
                }
            }

            // Monthly Renewal Logic — rolling 30-day window (not calendar month)
            if (needsTierCreditRenewal(rawData, todayStr)) {
                const newCredits = TIER_CREDITS[rawData.tier] || TIER_CREDITS.free;
                rawData.tierCredits = newCredits;
                stampTierCreditRenewal(rawData, todayStr, updateObj);
                updateObj.tierCredits = newCredits;
            } else if (!rawData.lastTierCreditRenewalAt && rawData.subscriptionRenewalDate) {
                // Migrate legacy YYYY-MM stamp to rolling date without re-granting.
                stampTierCreditRenewal(rawData, todayStr, updateObj);
            }

            if (!isNewUser && (staleRefund.tier > 0 || staleRefund.booster > 0)) {
                rawData.tierCredits = (rawData.tierCredits || 0) + staleRefund.tier;
                rawData.boosterCredits = (rawData.boosterCredits || 0) + staleRefund.booster;
                updateObj.tierCredits = rawData.tierCredits;
                updateObj.boosterCredits = rawData.boosterCredits;
                logger.warn("Refunded an interrupted earlier attempt of this sync", { requestId, uid, ...staleRefund });
            }

            const check = checkFeaturesAndCredits(rawData, imageCount, mode, hasBYOK);
            if (!check.allowed) throw new SyncError(check.code, check.errorCode, check.error);

            // Deduct credits to prevent concurrent overspending. The amounts are
            // returned (not assigned to outer variables) so a retried transaction
            // can never leave a stale deduction behind for the refund path.
            let tierDeducted = 0;
            let boosterDeducted = 0;
            if (!hasBYOK) {
                let tierCredits = rawData.tierCredits || 0;
                let boosterCredits = rawData.boosterCredits || 0;
                let creditsToDeduct = imageCount;
                if (tierCredits >= creditsToDeduct) {
                    tierCredits -= creditsToDeduct;
                    tierDeducted = creditsToDeduct;
                } else {
                    tierDeducted = tierCredits;
                    creditsToDeduct -= tierCredits;
                    tierCredits = 0;
                    boosterCredits -= creditsToDeduct;
                    boosterDeducted = creditsToDeduct;
                }
                updateObj.tierCredits = tierCredits;
                updateObj.boosterCredits = boosterCredits;
                rawData.tierCredits = tierCredits;
                rawData.boosterCredits = boosterCredits;
            }

            if (Object.keys(updateObj).length > 0) {
                t.set(userRef, updateObj, { merge: true });
            }
            // C11: the record says what was deducted so an interrupted sync can be
            // refunded by reconcileStuckSyncs. Outcome fields left by an earlier
            // failed attempt with the same clientRequestId are cleared.
            const del = FieldValue.delete();
            t.set(historyRef, {
                status: 'processing',
                startedAt: FieldValue.serverTimestamp(),
                startedAtMs: Date.now(),
                timestamp: FieldValue.serverTimestamp(),
                syncType: mode,
                imageCount,
                creditsDeducted: { tier: tierDeducted, booster: boosterDeducted },
                refunded: false,
                failureReason: del,
                reconciledAt: del,
                errorCode: del,
                creditRefunded: del,
            }, { merge: true });
            return { userData: rawData, tierDeducted, boosterDeducted };
        });
    } catch (err) {
        if (err instanceof SyncError) throw err;
        logger.error("Credit check transaction failed", { error: err.message, requestId, uid });
        throw new SyncError(500, E.INTERNAL, "Failed to verify or deduct sync credits.");
    }
}

module.exports = {
    SYNC_TIMEOUT_SECONDS,
    AI_BUDGET_MS,
    SYNC_IN_PROGRESS_TTL_MS,
    createCreditLedger,
    reserveSyncCredits,
};

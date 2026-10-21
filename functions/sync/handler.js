/**
 * syncPlanner orchestration: guard → validate → prerequisites (BYOK, Notion)
 * → transactional credit reservation → mode branch → settle credit → respond.
 *
 * Every failure after the reservation refunds the deducted credit; a sync that
 * synced no data is never charged.
 */
const { db } = require('../services/db');
const crypto = require('crypto');
const { logger } = require('firebase-functions/logger');
const { ERROR_CODES: E, sendError, guardRequest } = require('../services/requestGuard');
const { RATE_LIMIT_SYNC, redactSensitive } = require('../utils');
const { resolveTimeZone, checkPlanLimits } = require('./userPlan');
const { SyncError, mapSyncFailure } = require('./errors');
const { payloadSizeCheck, syncModeOf, parseSyncRequest } = require('./request');
const { getGoogleApis, verifyGoogleIdentity } = require('./google');
const { resolveByok } = require('./byok');
const { resolveNotionKey } = require('./prerequisites');
const { resolveNotesDestination } = require('./notesDestination');
const { convertHeicImages } = require('./images');
const { AI_BUDGET_MS, createCreditLedger, reserveSyncCredits } = require('./credits');
const { logSyncHistory, incrementUsageCounters } = require('./history');
const { runGamificationAfterSync, appendGamificationToMsg } = require('./gamification');
const { runMorningSync } = require('./modes/morning');
const { runEveningSync } = require('./modes/evening');
const { runJournalSync } = require('./modes/journal');
const { runVoiceNoteSync } = require('./modes/voiceNote');

/** Optional result fields, copied only when present (Firestore rejects undefined). */
function resultExtras(source) {
    const extras = {};
    if (source.savedTo === 'drive' || source.savedTo === 'notion') extras.savedTo = source.savedTo;
    if (source.links && typeof source.links === 'object' && Object.keys(source.links).length) extras.links = source.links;
    if (source.items && typeof source.items === 'object') extras.items = source.items;
    return extras;
}

const MODE_RUNNERS = {
    morning: runMorningSync,
    evening: runEveningSync,
    journal: runJournalSync,
    voice_note: runVoiceNoteSync,
};

async function syncPlannerHandler(req, res) {
    // Generate Request ID for structured logging and trace tying
    const requestId = crypto.randomUUID();
    const startTimeMs = Date.now();

    const identity = await guardRequest(req, res, {
        endpoint: 'syncPlanner',
        rateLimit: RATE_LIMIT_SYNC,
        errorExtra: { creditRefunded: false },
        beforeAuth: payloadSizeCheck(requestId),
    });
    if (!identity) return;

    const { email, uid } = identity;
    const body = req.body || {};
    const mode = syncModeOf(body);
    const firestore = db();
    const userRef = firestore.collection('users').doc(email);
    const warnings = [];

    const credit = createCreditLedger(userRef, { requestId, uid });
    let historyRef = null;
    let historyReserved = false;
    let parsedImages = [];
    const parsedImageCount = () => (parsedImages && parsedImages.length) || 1;

    async function respondError(status, errorCode, message) {
        const creditRefunded = await credit.refund();
        credit.settled = true;
        if (historyReserved) {
            await logSyncHistory(userRef, mode, parsedImageCount(), 'failed', message, {
                errorCode, creditRefunded, refunded: credit.refunded
            }, historyRef);
        }
        const durationMs = Date.now() - startTimeMs;
        logger.warn("Sync failed", { requestId, uid, syncMode: mode, status, errorCode, durationMs, creditRefunded });
        if (!res.headersSent) sendError(res, status, errorCode, message, { creditRefunded });
    }

    try {
        logger.info("Processing sync payload", { requestId, uid, syncMode: mode });

        // Pre-read: where notes go decides whether Google is needed; BYOK and Notion
        // prerequisites are checked BEFORE any credit is deducted.
        const preSnap = await userRef.get();
        const preData = preSnap.exists ? (preSnap.data() || {}) : {};
        const notesDestination = resolveNotesDestination(preData);

        const request = parseSyncRequest(body, mode, { notesDestination });
        parsedImages = request.parsedImages;
        const { needsGoogle, googleToken, clientRequestId } = request;

        const google = getGoogleApis();
        const auth = needsGoogle ? await verifyGoogleIdentity(google, googleToken, email) : null;

        let timeZone = resolveTimeZone(body.timeZone, preData.timeZone);

        const planError = checkPlanLimits(preData.tier, parsedImages.length, mode);
        if (planError) throw new SyncError(403, E.PLAN_LIMIT, planError);

        const byokConfig = await resolveByok(req, preData, { requestId, uid, warnings, email, userRef });
        const decryptedNotionKey = await resolveNotionKey(mode, userRef, preData, { requestId, uid, email }, notesDestination);

        // HEIC/HEIF → JPEG in memory, before any credit is deducted (C8).
        parsedImages = await convertHeicImages(parsedImages, { requestId, uid });

        // --- Transactional idempotency check, plan/credit check and deduction ---
        historyRef = userRef.collection('syncHistory').doc(clientRequestId || crypto.randomUUID());
        const txResult = await reserveSyncCredits({
            db: firestore, userRef, historyRef, timeZone, mode,
            imageCount: parsedImages.length,
            hasBYOK: !!byokConfig,
            requestId, uid,
        });

        if (txResult.duplicate) {
            const previous = txResult.duplicate;
            credit.settled = true;
            logger.info("Duplicate sync request; returning stored result", { requestId, uid, syncMode: mode });
            return res.status(200).send({
                text: previous.message || '',
                counts: previous.counts || {},
                warnings: Array.isArray(previous.warnings) ? previous.warnings : [],
                notes: Array.isArray(previous.notes) ? previous.notes : [],
                ...resultExtras(previous),
                creditsCharged: 0,
                duplicate: true
            });
        }

        credit.tier = txResult.tierDeducted;
        credit.booster = txResult.boosterDeducted;
        credit.historyRef = historyRef;
        historyReserved = true;
        const userData = txResult.userData;
        timeZone = resolveTimeZone(userData.timeZone, timeZone);

        const outcome = await MODE_RUNNERS[mode]({
            mode, requestId, uid, parsedImages, byokConfig,
            aiOptions: { deadline: startTimeMs + AI_BUDGET_MS, timeZone, requestId },
            userData, preData, userRef, timeZone, warnings,
            google, auth, decryptedNotionKey, notesDestination,
        });
        const { counts, dataSynced, extractionOk, partial } = outcome;
        const notes = Array.isArray(outcome.notes) ? outcome.notes : [];
        const extras = resultExtras(outcome);
        let msg = outcome.msg;

        // --- Settle the credit: never charge a sync that synced no data ---
        let creditsCharged = 0;
        if (dataSynced) {
            creditsCharged = credit.tier + credit.booster;
        } else if (credit.tier + credit.booster > 0) {
            const refunded = await credit.refund();
            if (!refunded) creditsCharged = credit.tier + credit.booster;
            if (refunded && !partial) warnings.push("Nothing new was found to sync, so no credit was used.");
        }
        credit.settled = true;

        msg = appendGamificationToMsg(msg, await runGamificationAfterSync(userRef, {
            // No streaks/rewards when AI extraction failed or nothing was synced.
            skip: !extractionOk || !dataSynced,
            requestId, uid, syncMode: mode, imageCount: parsedImages.length
        }));

        await logSyncHistory(userRef, mode, parsedImages.length, 'success', msg, {
            counts, warnings, notes, ...extras, creditsCharged, partial, refunded: credit.refunded
        }, historyRef);
        if (dataSynced) await incrementUsageCounters(userRef, parsedImages.length);

        const durationMs = Date.now() - startTimeMs;
        logger.info("Sync transaction complete", { requestId, uid, syncMode: mode, durationMs, status: 200, creditsCharged, type: 'latency' });
        return res.status(200).send({ text: msg, counts, creditsCharged, warnings, notes, ...extras });
    } catch (error) {
        if (error instanceof SyncError) {
            return await respondError(error.status, error.errorCode, error.message);
        }
        const mapped = mapSyncFailure(error);
        const logPayload = { error: redactSensitive(error?.message || error), code: error?.code, requestId, uid, syncMode: mode };
        if (mapped.serverMisconfig) logger.error("Server-side AI misconfiguration; refunding", logPayload);
        else logger.error("FATAL ERROR", logPayload);
        return await respondError(mapped.status, mapped.errorCode, mapped.message);
    } finally {
        // Safety net: any path that did not settle the credit refunds it.
        if (!credit.settled) await credit.refund();
    }
}

module.exports = { syncPlannerHandler };

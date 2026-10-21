/** Profile endpoints: updateProfile and refreshStaleStreak. */
const { FieldValue } = require('firebase-admin/firestore');
const { db } = require('../services/db');
const { logger } = require('firebase-functions/logger');
const { ERROR_CODES: E, sendError, guardRequest } = require('../services/requestGuard');
const { isValidTimeZone, computeDisplayStreak, sanitizeControlCharacters } = require('../utils');
const { buildNewUserDoc } = require('../sync/userPlan');
const { isValidNotesDestination } = require('../sync/notesDestination');

// --- ENDPOINT: updateProfile ---
// Moves frontend Firestore writes behind secure admin privileges. Creates the
// user document with full Free-tier defaults (15 credits) when it is missing.
async function updateProfileHandler(req, res) {
    const identity = await guardRequest(req, res, { endpoint: 'updateProfile' });
    if (!identity) return;
    const { email: userEmail, uid } = identity;

    const { updates = {} } = req.body || {};
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
        return sendError(res, 400, E.BAD_REQUEST, "Invalid payload.");
    }

    const allowedUpdates = {};
    if (typeof updates.setupComplete === 'boolean') allowedUpdates.setupComplete = updates.setupComplete;
    if (updates.displayName !== undefined) {
        if (typeof updates.displayName !== 'string') {
            return sendError(res, 400, E.BAD_REQUEST, "Display name must be text.");
        }
        const displayName = sanitizeControlCharacters(updates.displayName.normalize('NFKC'), ' ').trim();
        if (displayName.length < 1 || displayName.length > 100) {
            return sendError(res, 400, E.BAD_REQUEST, "Display name must be between 1 and 100 characters.");
        }
        allowedUpdates.displayName = displayName;
    }
    if (updates.expoPushToken !== undefined) {
        if (typeof updates.expoPushToken !== 'string') {
            return sendError(res, 400, E.BAD_REQUEST, "Push token must be text.");
        }
        const pushToken = sanitizeControlCharacters(updates.expoPushToken).trim();
        if (pushToken && (pushToken.length > 512 || !/^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/.test(pushToken))) {
            return sendError(res, 400, E.BAD_REQUEST, "Push token format is invalid.");
        }
        allowedUpdates.expoPushToken = pushToken;
    }
    if (updates.notesDestination !== undefined) {
        // 'notion' is accepted before Notion is connected; the client then opens Notion setup.
        if (!isValidNotesDestination(updates.notesDestination)) {
            return sendError(res, 400, E.BAD_REQUEST, "Choose Google Drive or Notion.");
        }
        allowedUpdates.notesDestination = updates.notesDestination;
    }
    if (typeof updates.dedupCalendar === 'boolean') allowedUpdates.dedupCalendar = updates.dedupCalendar;
    if (typeof updates.dedupTasks === 'boolean') allowedUpdates.dedupTasks = updates.dedupTasks;
    if (updates.timeZone !== undefined) {
        // Unknown zones are ignored rather than rejected so a profile save never fails on them.
        if (isValidTimeZone(updates.timeZone)) allowedUpdates.timeZone = updates.timeZone;
    }

    try {
        const firestore = db();
        const userRef = firestore.collection('users').doc(userEmail);
        const created = await firestore.runTransaction(async (t) => {
            const snap = await t.get(userRef);
            if (!snap.exists) {
                t.set(userRef, {
                    ...buildNewUserDoc(allowedUpdates.timeZone),
                    createdAt: FieldValue.serverTimestamp(),
                    ...allowedUpdates
                });
                return true;
            }
            if (Object.keys(allowedUpdates).length > 0) {
                t.set(userRef, allowedUpdates, { merge: true });
            }
            return false;
        });
        logger.info("Updated profile", { uid, created, fields: Object.keys(allowedUpdates) });
        return res.status(200).send({ success: true, created });
    } catch (err) {
        logger.error("Update profile error", { error: err.message, uid });
        return sendError(res, 500, E.INTERNAL, "Failed to update profile.");
    }
}

// --- ENDPOINT: refreshStaleStreak ---
// Persists a lapsed streak (0) when the user opens the app without syncing.
// Streak advancement/decay logic otherwise only runs inside syncPlanner.
async function refreshStaleStreakHandler(req, res) {
    const identity = await guardRequest(req, res, { endpoint: 'refreshStaleStreak' });
    if (!identity) return;
    const { email: userEmail, uid } = identity;

    try {
        const firestore = db();
        const userRef = firestore.collection('users').doc(userEmail);
        // Transactional read-modify-write so a concurrent sync that just advanced
        // the streak is never overwritten with 0.
        const result = await firestore.runTransaction(async (t) => {
            const snap = await t.get(userRef);
            if (!snap.exists) return { refreshed: false, currentStreak: 0 };

            const raw = snap.data();
            const displayStreak = computeDisplayStreak(raw);
            const storedStreak = raw.currentStreak || 0;
            if (displayStreak === 0 && storedStreak > 0) {
                t.set(userRef, { currentStreak: 0, lastAwardedStreak: 0 }, { merge: true });
                return { refreshed: true, currentStreak: 0, previous: storedStreak };
            }
            return { refreshed: false, currentStreak: displayStreak };
        });
        if (result.refreshed) logger.info("Reset lapsed streak", { uid, previous: result.previous });
        return res.status(200).send({ refreshed: result.refreshed, currentStreak: result.currentStreak });
    } catch (err) {
        logger.error("refreshStaleStreak error", { error: err.message, uid });
        return sendError(res, 500, E.INTERNAL, "Failed to refresh streak state.");
    }
}

module.exports = {
    updateProfileHandler,
    refreshStaleStreakHandler,
};

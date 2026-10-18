/** Streaks, freezes and milestone rewards applied after a successful sync. */
const { db } = require('../services/db');
const { logger } = require('firebase-functions/logger');
const {
    calendarDayDiff,
    normalizeSyncDateStr,
    todayInTimeZone,
} = require('../utils');
const { resolveTimeZone } = require('./userPlan');
const { logSyncHistory } = require('./history');

async function applyGamificationMilestones(userRef) {
    return await db().runTransaction(async (t) => {
        const snap = await t.get(userRef);
        if (!snap.exists) return null;
        const userData = snap.data();

        let currentStreak = userData.currentStreak || 0;
        let highestStreak = userData.highestStreak || 0;
        let streakFreezes = userData.streakFreezes || 0;
        let dailySyncCount = userData.dailySyncCount || 0;
        let boosterCredits = userData.boosterCredits || 0;
        let lastAwardedStreak = userData.lastAwardedStreak || 0;
        const timeZone = resolveTimeZone(userData.timeZone);
        // Legacy ISO strings and Firestore Timestamps are coerced to YYYY-MM-DD.
        const lastSyncDateStr = normalizeSyncDateStr(userData.lastSyncDate, timeZone);

        const todayStr = todayInTimeZone(timeZone);
        let diffDays = 0;
        let usedFreeze = false;

        if (!lastSyncDateStr) {
            diffDays = 1;
            currentStreak = 1;
            dailySyncCount = 1;
        } else {
            diffDays = calendarDayDiff(lastSyncDateStr, todayStr);

            if (diffDays <= 0) {
                // Same calendar day, or a non-positive delta caused by clock skew,
                // DST, or a timezone change where lastSyncDate is "ahead" of today.
                // Treat as an extra sync today: never advance the streak or mint freezes.
                dailySyncCount += 1;
            } else if (diffDays === 1) {
                currentStreak += 1;
                dailySyncCount = 1;
            } else {
                let daysMissed = diffDays - 1;
                if (streakFreezes >= daysMissed) {
                    streakFreezes -= daysMissed;
                    currentStreak += 1;
                    usedFreeze = true;
                } else {
                    currentStreak = 1;
                }
                dailySyncCount = 1;
            }
        }

        if (currentStreak > highestStreak) highestStreak = currentStreak;

        let milestoneMsg = null;
        if (diffDays > 0 && currentStreak > 0) {
            if (currentStreak >= 90 && lastAwardedStreak < 90) {
                milestoneMsg = `🎉 Incredible! 90-Day Streak. Awarded +50 Booster Credits & 3 Freezes!`;
                streakFreezes += 3;
                boosterCredits += 50;
                lastAwardedStreak = 90;
            } else if (currentStreak >= 30 && lastAwardedStreak < 30) {
                milestoneMsg = `🔥 Amazing! 30-Day Streak. Awarded +20 Booster Credits & 1 Freeze!`;
                streakFreezes += 1;
                boosterCredits += 20;
                lastAwardedStreak = 30;
            } else if (currentStreak >= 7 && lastAwardedStreak < 7) {
                milestoneMsg = `🌟 Great work! 7-Day Streak. Awarded +5 Booster Credits!`;
                boosterCredits += 5;
                lastAwardedStreak = 7;
            } else if (usedFreeze) {
                milestoneMsg = `❄️ ${currentStreak}-Day Streak sustained using a Freeze!`;
            }

            if (currentStreak === 1 && diffDays > 1) {
                lastAwardedStreak = 0;
            }
        }

        const updates = {
            boosterCredits,
            currentStreak,
            highestStreak,
            streakFreezes,
            dailySyncCount,
            lastSyncDate: todayStr,
            lastAwardedStreak
        };

        t.set(userRef, updates, { merge: true });
        return milestoneMsg;
    });
}

/**
 * Runs streak/milestone logic after a sync. Skipped when AI extraction failed
 * or nothing was synced (no rewards for refunded/empty syncs). Retries once on
 * transient Firestore errors and surfaces a user-visible warning if all attempts fail.
 */
async function runGamificationAfterSync(userRef, { skip = false, requestId, uid, syncMode, imageCount = 1 } = {}) {
    if (skip) return { milestoneMsg: null, streakWarning: null };

    const maxAttempts = 2;
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const milestoneMsg = await applyGamificationMilestones(userRef);
            return { milestoneMsg, streakWarning: null };
        } catch (err) {
            lastErr = err;
            logger.warn("Gamification attempt failed", { attempt, error: err.message, requestId, uid, syncMode });
        }
    }

    const warning = "⚠️ Streak could not be updated this sync — it will resume counting on your next successful sync.";
    try {
        await logSyncHistory(userRef, syncMode || 'unknown', imageCount, 'warning',
            `Streak update failed after ${maxAttempts} attempts: ${lastErr?.message || 'unknown error'}`);
    } catch (logErr) {
        logger.error("Failed to log streak warning to syncHistory", { error: logErr.message, requestId, uid });
    }
    logger.error("Gamification failed after retries", { error: lastErr?.message, requestId, uid, syncMode });
    return { milestoneMsg: null, streakWarning: warning };
}

function appendGamificationToMsg(msg, { milestoneMsg, streakWarning }) {
    if (streakWarning) msg += `\n${streakWarning}`;
    if (milestoneMsg) msg += `\n${milestoneMsg}`;
    return msg;
}

module.exports = {
    applyGamificationMilestones,
    runGamificationAfterSync,
    appendGamificationToMsg,
};

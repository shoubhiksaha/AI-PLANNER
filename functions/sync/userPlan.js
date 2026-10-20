/**
 * User-document defaults, plan limits and monthly tier-credit renewal.
 * Shared by syncPlanner, updateProfile and the payment handlers.
 */
const {
    calendarDayDiff,
    isValidTimeZone,
    todayInTimeZone,
} = require('../utils');
const { ERROR_CODES: E } = require('../services/requestGuard');

const DEFAULT_TIME_ZONE = 'Asia/Kolkata';
const TIER_CREDITS = { free: 15, standard: 100, pro: 250 };

function resolveTimeZone(...candidates) {
    for (const tz of candidates) {
        if (isValidTimeZone(tz)) return tz;
    }
    return DEFAULT_TIME_ZONE;
}

/** Gamification fields every user document carries (no renewal stamp: see buildNewUserDoc). */
const GAMIFICATION_DEFAULTS = Object.freeze({
    tier: 'free', tierCredits: TIER_CREDITS.free, boosterCredits: 0,
    currentStreak: 0, highestStreak: 0, streakFreezes: 0,
    dailySyncCount: 0, lastSyncDate: null, subscriptionRenewalDate: null, lastAwardedStreak: 0
});

/** Full document for a brand-new user: Free tier with 15 credits, renewal stamped today. */
function buildNewUserDoc(timeZone) {
    const tz = resolveTimeZone(timeZone);
    const today = todayInTimeZone(tz);
    return {
        ...GAMIFICATION_DEFAULTS,
        timeZone: tz,
        lastTierCreditRenewalAt: today,
        subscriptionRenewalDate: today.slice(0, 7),
    };
}

/** Plan limits (feature and page count). Returns null when allowed. */
function checkPlanLimits(tier, numImages, mode) {
    const plan = tier || 'free';
    if (plan !== 'pro' && mode === 'voice_note') {
        return "AI Voice Transcribing is a Pro feature. Upgrade to Pro to use Voice Notes! 🚀";
    }
    if (plan === 'free') {
        if (numImages > 1) return "Free tier is limited to 1 page per sync. Upgrade to Standard/Pro for multi-page batch processing 🚀";
    } else if (plan === 'standard') {
        if (mode === 'journal' && numImages > 3) return "Standard tier is limited to 3 pages per Journal sync. Upgrade to Pro for 5 pages 🚀";
        if ((mode === 'morning' || mode === 'evening') && numImages > 1) return "Standard tier is limited to 1 page per Morning/Evening sync. Upgrade to Pro for 5 pages 🚀";
    } else if (plan === 'pro') {
        if (numImages > 5) return "Pro tier is limited to 5 pages per sync.";
    }
    return null;
}

/**
 * Only a usable stored KMS key or a validated header key counts as BYOK
 * (`hasBYOK`); legacy geminiKey/byokConfig fields never waive credits.
 */
function checkFeaturesAndCredits(userData, numImages, mode, hasBYOK = false) {
    const planError = checkPlanLimits(userData.tier, numImages, mode);
    if (planError) return { allowed: false, error: planError, code: 403, errorCode: E.PLAN_LIMIT };

    const tierCredits = userData.tierCredits || 0;
    const boosterCredits = userData.boosterCredits || 0;
    if (!hasBYOK && tierCredits + boosterCredits < numImages) {
        return {
            allowed: false,
            error: `Insufficient credits. Need ${numImages}, but have ${tierCredits + boosterCredits}. Please buy Booster Credits or Upgrade!`,
            code: 402,
            errorCode: E.INSUFFICIENT_CREDITS
        };
    }
    return { allowed: true };
}

/**
 * Whether tier credits should be replenished. Uses a rolling 30-day window from
 * lastTierCreditRenewalAt so a Jan-31 payment + Feb-1 sync cannot double-grant.
 * Legacy YYYY-MM subscriptionRenewalDate is honoured only until migrated.
 */
function needsTierCreditRenewal(rawData, todayStr) {
    const currentMonthStr = todayStr.slice(0, 7);
    const lastRenewalAt = rawData.lastTierCreditRenewalAt || null;

    if (lastRenewalAt && lastRenewalAt.length >= 10) {
        return calendarDayDiff(lastRenewalAt, todayStr) >= 30;
    }

    const legacyMonth = rawData.subscriptionRenewalDate || null;
    if (legacyMonth && legacyMonth.length === 7) {
        return legacyMonth !== currentMonthStr;
    }

    return true;
}

function stampTierCreditRenewal(rawData, todayStr, updateObj) {
    rawData.lastTierCreditRenewalAt = todayStr;
    rawData.subscriptionRenewalDate = todayStr.slice(0, 7);
    updateObj.lastTierCreditRenewalAt = todayStr;
    updateObj.subscriptionRenewalDate = todayStr.slice(0, 7);
}

module.exports = {
    DEFAULT_TIME_ZONE,
    TIER_CREDITS,
    GAMIFICATION_DEFAULTS,
    resolveTimeZone,
    buildNewUserDoc,
    checkPlanLimits,
    checkFeaturesAndCredits,
    needsTierCreditRenewal,
    stampTierCreditRenewal,
};

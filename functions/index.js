const { onRequest } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/logger");
const admin = require("firebase-admin");
const crypto = require("crypto");
// Import Extracted Services
const { checkRateLimit } = require('./services/rateLimit');
const { getPlannerDataFromImages, GEMINI_API_KEY } = require('./services/gemini');
const { 
    syncCalendarEvents, 
    syncGoogleTasks, 
    updateCompletedTasks, 
    syncExpensesToSheet, 
    syncHealthToSheet 
} = require('./services/googleSync');
const { 
    encrypt, 
    getDecryptedNotionKeyAndMigrate, 
    validateNotionCredentials,
    uploadFileToNotion, 
    syncBrainDumpToNotion,
    normalizeBrainDumpText,
    createNotionClient,
    createPageInDatabase,
} = require('./services/notion');
const {
    generateAndWrapDEK,
    unwrapAndDecrypt
} = require('./services/kms');
const { grantBoosterCreditsToAllUsers } = require('./services/creditGrant');
const {
    CASHFREE_APP_ID,
    CASHFREE_SECRET_KEY,
    normalizePrice,
    getCashfreeConfig,
    createCashfreeOrder: createCashfreeGatewayOrder,
    getCashfreeOrder
} = require('./services/cashfree');

// Initialize Firebase Admin with explicit bucket
admin.initializeApp({
    storageBucket: "ai-planner-project-467800.firebasestorage.app"
});

// --- CONFIGURATION ---
const { defineSecret, defineString } = require('firebase-functions/params');
const NOTION_ENCRYPTION_KEY = defineSecret('NOTION_ENCRYPTION_KEY');
const NOTION_ENCRYPTION_KEY_V2 = defineSecret('NOTION_ENCRYPTION_KEY_V2');
const ALLOW_CUSTOM_BYOK_URLS = defineString('ALLOW_CUSTOM_BYOK_URLS', { default: 'false' });
const CREDITS_GRANT_TOKEN = defineString('CREDITS_GRANT_TOKEN', { default: '' });
const REQUIRE_APP_CHECK = defineString('REQUIRE_APP_CHECK', { default: 'false' });

// --- UTILITIES (shared with tests) ---
const {
    sanitizeSyncType,
    parseImageDataArray,
    normalizeNotionDbId,
    isLikelyNotionKey,
    isJsonRequest,
    setStandardHeaders,
    applyCors,
    ALLOWED_SYNC_TYPES,
    handleOptions,
    RATE_LIMIT_SYNC,
    RATE_LIMIT_DEFAULT,
    MAX_REQUEST_BODY_BYTES,
    validateBYOKConfig,
    calendarDayDiff,
    computeDisplayStreak,
} = require('./utils');
// Crypto logic and Rate Limits have been extracted to services/

// Google token resolution removed in favor of Firebase ID tokens for authentication.

function getVerifiedEmail(decodedToken) {
    return typeof decodedToken?.email === 'string' && decodedToken.email.trim()
        ? decodedToken.email.trim().toLowerCase()
        : null;
}

function customBYOKUrlsEnabled() {
    return String(ALLOW_CUSTOM_BYOK_URLS.value()).toLowerCase() === 'true';
}

async function enforceAppCheck(req, res) {
    if (String(REQUIRE_APP_CHECK.value()).toLowerCase() !== 'true') return true;
    const appCheckToken = req.headers['x-firebase-appcheck'];
    if (!appCheckToken || typeof appCheckToken !== 'string') {
        res.status(401).send({ error: "App Check token required" });
        return false;
    }
    try {
        await admin.appCheck().verifyToken(appCheckToken);
        return true;
    } catch (_) {
        res.status(401).send({ error: "Invalid App Check token" });
        return false;
    }
}

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

function sanitizeControlCharacters(value, replacement = '') {
    // eslint-disable-next-line no-control-regex
    return String(value || '').replace(/[\u0000-\u001f\u007f]/g, replacement);
}

function checkFeaturesAndCredits(userData, numImages, mode, hasBYOK = false) {
    const tier = userData.tier || 'free';
    if (tier !== 'pro' && mode === 'voice_note') {
        return { allowed: false, error: "AI Voice Transcribing is a Pro feature. Upgrade to Pro to use Voice Notes! 🚀", code: 403 };
    }
    
    if (tier === 'free') {
        if (numImages > 1) return { allowed: false, error: "Free tier is limited to 1 page per sync. Upgrade to Standard/Pro for multi-page batch processing 🚀", code: 403 };
    } else if (tier === 'standard') {
        if (mode === 'journal' && numImages > 3) return { allowed: false, error: "Standard tier is limited to 3 pages per Journal sync. Upgrade to Pro for 5 pages 🚀", code: 403 };
        if ((mode === 'morning' || mode === 'evening') && numImages > 1) return { allowed: false, error: "Standard tier is limited to 1 page per Morning/Evening sync. Upgrade to Pro for 5 pages 🚀", code: 403 };
    } else if (tier === 'pro') {
        if (numImages > 5) return { allowed: false, error: "Pro tier is limited to 5 pages per sync.", code: 403 };
    }

    const _hasBYOK = hasBYOK || !!userData.geminiKey || !!(userData.byokConfig && userData.byokConfig.apiKey) || !!userData.byokKmsData;
    let tierCredits = userData.tierCredits || 0;
    let boosterCredits = userData.boosterCredits || 0;

    if (!_hasBYOK) {
        if (tierCredits + boosterCredits < numImages) {
            return { allowed: false, error: `Insufficient credits. Need ${numImages}, but have ${tierCredits + boosterCredits}. Please buy Booster Credits or Upgrade!`, code: 402 };
        }
    }
    return { allowed: true };
}

function appendEveningNotionOutcomeMessage(successMessages, outcome) {
    if (!outcome) return;
    if (outcome.ok) {
        if (outcome.status === 'duplicate') {
            successMessages.push('Notion: Brain Dump page already exists for this date.');
            return;
        }
        successMessages.push('Saved Visual Brain Dump to Notion.');
        return;
    }
    successMessages.push(`(Notion not saved: ${outcome.reason})`);
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

async function applyGamificationMilestones(userRef) {
    return await admin.firestore().runTransaction(async (t) => {
        const snap = await t.get(userRef);
        if (!snap.exists) return null;
        const userData = snap.data();

        let currentStreak = userData.currentStreak || 0;
        let highestStreak = userData.highestStreak || 0;
        let streakFreezes = userData.streakFreezes || 0;
        let dailySyncCount = userData.dailySyncCount || 0;
        let lastSyncDateStr = userData.lastSyncDate;
        let boosterCredits = userData.boosterCredits || 0;
        let lastAwardedStreak = userData.lastAwardedStreak || 0;
        const timeZone = userData.timeZone || 'Asia/Kolkata';

        const todayStr = new Date().toLocaleDateString('en-CA', { timeZone });
        let diffDays = 0;
        let usedFreeze = false;

        if (!lastSyncDateStr) {
            diffDays = 1;
            currentStreak = 1;
            dailySyncCount = 1;
        } else {
            const todayParts = todayStr.split('-').map(Number);
            const lastParts = lastSyncDateStr.split('-').map(Number);
            const todayDate = new Date(todayParts[0], todayParts[1]-1, todayParts[2]);
            const lastDate = new Date(lastParts[0], lastParts[1]-1, lastParts[2]);
            diffDays = Math.round((todayDate - lastDate) / (1000 * 60 * 60 * 24));

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
 * Runs streak/milestone logic after a sync. Skipped on partial failures (refunded
 * syncs should not advance streak). Retries once on transient Firestore errors
 * and surfaces a user-visible warning if all attempts fail.
 */
async function runGamificationAfterSync(userRef, { skip = false, requestId, authEmail, syncMode, imageCount = 1 } = {}) {
    if (skip) return { milestoneMsg: null, streakWarning: null };

    const maxAttempts = 2;
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const milestoneMsg = await applyGamificationMilestones(userRef);
            return { milestoneMsg, streakWarning: null };
        } catch (err) {
            lastErr = err;
            logger.warn("Gamification attempt failed", {
                attempt,
                error: err.message,
                requestId,
                authEmail,
                syncMode
            });
        }
    }

    const warning = "⚠️ Streak could not be updated this sync — it will resume counting on your next successful sync.";
    try {
        await logSyncHistory(userRef, syncMode || 'unknown', imageCount, 'warning',
            `Streak update failed after ${maxAttempts} attempts: ${lastErr?.message || 'unknown error'}`);
    } catch (logErr) {
        logger.error("Failed to log streak warning to syncHistory", { error: logErr.message, requestId, authEmail });
    }
    logger.error("Gamification failed after retries", { error: lastErr?.message, requestId, authEmail, syncMode });
    return { milestoneMsg: null, streakWarning: warning };
}

function appendGamificationToMsg(msg, { milestoneMsg, streakWarning }) {
    if (streakWarning) msg += `\n${streakWarning}`;
    if (milestoneMsg) msg += `\n${milestoneMsg}`;
    return msg;
}

// --- ENDPOINT: updateProfile ---
// Moves frontend Firestore writes behind secure admin privileges
exports.updateProfile = onRequest({ cors: false, memory: "256MiB", maxInstances: 20 }, async (req, res) => {
    setStandardHeaders(res);
    if (handleOptions(req, res)) return;
    if (!applyCors(req, res)) return res.status(403).send({ error: "Origin not allowed" });

    if (req.method !== 'POST') return res.status(405).send({ error: "Method not allowed" });
    if (!isJsonRequest(req)) return res.status(415).send({ error: "Content-Type must be application/json" });
    if (!(await enforceAppCheck(req, res))) return;

    const { idToken, updates } = req.body || {};
    if (!idToken || !updates || typeof updates !== 'object' || Array.isArray(updates)) {
        return res.status(400).send({ error: "Invalid payload" });
    }

    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const userEmail = getVerifiedEmail(decodedToken);
        if (!userEmail) return res.status(401).send({ error: "Verified email required" });
        
        const rl = await checkRateLimit(userEmail, 'updateProfile', RATE_LIMIT_DEFAULT);
        if (!rl.allowed) {
            res.set('Retry-After', String(Math.ceil(rl.retryAfterMs / 1000)));
            return res.status(429).send({ error: "Too many requests" });
        }

        const allowedUpdates = {};
        if (typeof updates.setupComplete === 'boolean') allowedUpdates.setupComplete = updates.setupComplete;
        if (updates.displayName !== undefined) {
            if (typeof updates.displayName !== 'string') {
                return res.status(400).send({ error: "Display name must be text" });
            }
            const displayName = sanitizeControlCharacters(updates.displayName.normalize('NFKC'), ' ').trim();
            if (displayName.length < 1 || displayName.length > 100) {
                return res.status(400).send({ error: "Display name must be between 1 and 100 characters" });
            }
            allowedUpdates.displayName = displayName;
        }
        if (updates.expoPushToken !== undefined) {
            if (typeof updates.expoPushToken !== 'string') {
                return res.status(400).send({ error: "Push token must be text" });
            }
            const pushToken = sanitizeControlCharacters(updates.expoPushToken).trim();
            if (pushToken && (pushToken.length > 512 || !/^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/.test(pushToken))) {
                return res.status(400).send({ error: "Push token format is invalid" });
            }
            allowedUpdates.expoPushToken = pushToken;
        }
        if (typeof updates.dedupCalendar === 'boolean') allowedUpdates.dedupCalendar = updates.dedupCalendar;
        if (typeof updates.dedupTasks === 'boolean') allowedUpdates.dedupTasks = updates.dedupTasks;
        if (typeof updates.timeZone === 'string') {
            try {
                if (Intl.supportedValuesOf('timeZone').includes(updates.timeZone)) allowedUpdates.timeZone = updates.timeZone;
            } catch (e) { /* Intl tz list unavailable; skip persisting */ }
        if (Object.keys(allowedUpdates).length > 0) {
            await admin.firestore().collection('users').doc(userEmail).set(allowedUpdates, { merge: true });
            logger.info(`Updated profile fields for ${userEmail}`);
        }
        
        return res.status(200).send({ success: true });
    } catch (err) {
        logger.error("Update profile error:", err);
        return res.status(500).send({ error: "Failed to update profile." });
    }
});

// --- ENDPOINT: refreshStaleStreak ---
// Persists a lapsed streak (0) when the user opens the app without syncing.
// Streak advancement/decay logic otherwise only runs inside syncPlanner.
exports.refreshStaleStreak = onRequest({ cors: false, memory: "256MiB", maxInstances: 20 }, async (req, res) => {
    setStandardHeaders(res);
    if (handleOptions(req, res)) return;
    if (!applyCors(req, res)) return res.status(403).send({ error: "Origin not allowed" });

    if (req.method !== 'POST') return res.status(405).send({ error: "Method not allowed" });
    if (!isJsonRequest(req)) return res.status(415).send({ error: "Content-Type must be application/json" });
    if (!(await enforceAppCheck(req, res))) return;

    const { idToken } = req.body || {};
    if (!idToken) return res.status(400).send({ error: "Missing token" });

    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const userEmail = getVerifiedEmail(decodedToken);
        if (!userEmail) return res.status(401).send({ error: "No email in token" });

        const rl = await checkRateLimit(userEmail, 'refreshStaleStreak', RATE_LIMIT_DEFAULT);
        if (!rl.allowed) {
            res.set('Retry-After', String(Math.ceil(rl.retryAfterMs / 1000)));
            return res.status(429).send({ error: "Too many requests" });
        }

        const userRef = admin.firestore().collection('users').doc(userEmail);
        const snap = await userRef.get();
        if (!snap.exists) return res.status(200).send({ refreshed: false, currentStreak: 0 });

        const raw = snap.data();
        const displayStreak = computeDisplayStreak(raw);
        const storedStreak = raw.currentStreak || 0;

        if (displayStreak === 0 && storedStreak > 0) {
            await userRef.set({
                currentStreak: 0,
                lastAwardedStreak: 0
            }, { merge: true });
            logger.info(`Reset lapsed streak for ${userEmail} (was ${storedStreak})`);
            return res.status(200).send({ refreshed: true, currentStreak: 0 });
        }

        return res.status(200).send({ refreshed: false, currentStreak: displayStreak });
    } catch (err) {
        logger.error("refreshStaleStreak error:", err);
        return res.status(500).send({ error: "Failed to refresh streak state." });
    }
});

// --- SETUP ENDPOINT: setupNotion ---
exports.setupNotion = onRequest({
    cors: false,
    memory: "256MiB",
    maxInstances: 20,
    secrets: [NOTION_ENCRYPTION_KEY, NOTION_ENCRYPTION_KEY_V2]
}, async (req, res) => {
    setStandardHeaders(res);
    if (handleOptions(req, res)) return;
    if (!applyCors(req, res)) return res.status(403).send({ error: "Origin not allowed" });

    if (req.method !== 'POST') {
        return res.status(405).send({ error: "Method not allowed" });
    }
    if (!isJsonRequest(req)) {
        return res.status(415).send({ error: "Content-Type must be application/json" });
    }
    if (!(await enforceAppCheck(req, res))) return;

    const body = req.body || {};
    const idToken = body.idToken;
    const notionKey = typeof body.notionKey === 'string' ? body.notionKey.trim() : '';
    const notionDbId = normalizeNotionDbId(body.notionDbId);

    if (!idToken || !isLikelyNotionKey(notionKey) || !notionDbId) {
        return res.status(400).send({ error: "Invalid setup payload" });
    }

    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const userEmail = getVerifiedEmail(decodedToken);
        if (!userEmail) return res.status(401).send({ error: "Verified email required" });

        const rl = await checkRateLimit(userEmail, 'setupNotion', RATE_LIMIT_DEFAULT);
        if (!rl.allowed) {
            res.set('Retry-After', String(Math.ceil(rl.retryAfterMs / 1000)));
            return res.status(429).send({ error: "Too many requests. Please try again later." });
        }

        const notionValidation = await validateNotionCredentials(notionKey, notionDbId);
        if (!notionValidation.valid) {
            return res.status(400).send({ error: notionValidation.error });
        }

        const encryptedKey = encrypt(notionKey);
        const db = admin.firestore();
        const userRef = db.collection('users').doc(userEmail);
        await userRef.set({ notionKey: encryptedKey, notionDbId }, { merge: true });

        logger.info(`Stored encrypted Notion settings for ${userEmail}`);
        return res.status(200).send({ success: true, text: "Notion setup saved securely." });
    } catch (err) {
        logger.error("Setup error:", err);
        return res.status(500).send({ error: "Failed to securely save keys." });
    }
});

// --- SETUP ENDPOINT: setupBYOK ---
exports.setupBYOK = onRequest({ cors: false, memory: "256MiB", maxInstances: 20 }, async (req, res) => {
    setStandardHeaders(res);
    if (handleOptions(req, res)) return;
    if (!applyCors(req, res)) return res.status(403).send({ error: "Origin not allowed" });

    if (req.method !== 'POST') {
        return res.status(405).send({ error: "Method not allowed" });
    }
    if (!isJsonRequest(req)) {
        return res.status(415).send({ error: "Content-Type must be application/json" });
    }
    if (!(await enforceAppCheck(req, res))) return;

    const body = req.body || {};
    const idToken = body.idToken;
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    const provider = body.provider || 'openai';
    const modelName = body.modelName || 'gpt-4o';
    const baseUrl = body.baseUrl;
    const apiVersion = body.apiVersion;

    if (!idToken || !apiKey) {
        return res.status(400).send({ error: "Invalid setup payload" });
    }

    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const userEmail = getVerifiedEmail(decodedToken);
        if (!userEmail) return res.status(401).send({ error: "Verified email required" });

        const rl = await checkRateLimit(userEmail, 'setupBYOK', RATE_LIMIT_DEFAULT);
        if (!rl.allowed) {
            res.set('Retry-After', String(Math.ceil(rl.retryAfterMs / 1000)));
            return res.status(429).send({ error: "Too many requests. Please try again later." });
        }

        const byokValidation = validateBYOKConfig(
            { apiKey, provider, modelName, baseUrl, apiVersion },
            { allowCustomUrl: customBYOKUrlsEnabled() }
        );
        if (!byokValidation.valid) {
            return res.status(400).send({ error: byokValidation.error });
        }
        const normalizedConfig = byokValidation.config;

        const kmsPayload = await generateAndWrapDEK(normalizedConfig.apiKey);
        const db = admin.firestore();
        const userRef = db.collection('users').doc(userEmail);
        const byokDataToSave = {
            ...kmsPayload,
            provider: normalizedConfig.provider,
            modelName: normalizedConfig.modelName
        };
        if (normalizedConfig.baseUrl) byokDataToSave.baseUrl = normalizedConfig.baseUrl;
        if (normalizedConfig.apiVersion) byokDataToSave.apiVersion = normalizedConfig.apiVersion;
        await userRef.set({ byokKmsData: byokDataToSave }, { merge: true });

        logger.info(`Stored wrapped BYOK KMS Data for ${userEmail}`);
        return res.status(200).send({ success: true, text: "BYOK settings saved securely." });
    } catch (err) {
        logger.error("BYOK Setup error:", err);
        return res.status(500).send({ error: "Failed to securely save keys." });
    }
});

// --- GDPR: Export User Data ---
exports.exportUserData = onRequest({ cors: false, memory: "512MiB", maxInstances: 10 }, async (req, res) => {
    setStandardHeaders(res);
    if (handleOptions(req, res)) return;
    if (!applyCors(req, res)) return res.status(403).send({ error: "Origin not allowed" });

    if (req.method !== 'POST') {
        return res.status(405).send({ error: "Method not allowed" });
    }
    if (!isJsonRequest(req)) {
        return res.status(415).send({ error: "Content-Type must be application/json" });
    }
    if (!(await enforceAppCheck(req, res))) return;

    const body = req.body || {};
    const token = body.token;
    if (!token) return res.status(400).send({ error: "Missing token" });

    const requestId = require('crypto').randomUUID();
    let userEmail = "unknown";

    try {
        const decodedToken = await admin.auth().verifyIdToken(token, true);
        userEmail = getVerifiedEmail(decodedToken);
        if (!userEmail) return res.status(401).send({ error: "No email in token" });

        const rl = await checkRateLimit(userEmail, 'exportUserData', RATE_LIMIT_DEFAULT);
        if (!rl.allowed) {
            res.set('Retry-After', String(Math.ceil(rl.retryAfterMs / 1000)));
            return res.status(429).send({ error: "Too many requests. Please try again later." });
        }
        const db = admin.firestore();
        const userRef = db.collection('users').doc(userEmail);
        const snap = await userRef.get();
        const paymentSnap = await db.collection('cashfree_orders')
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
                byokConfigured: !!(raw.byokKmsData || raw.byokConfig || raw.geminiKey),
                byokProvider: raw.byokKmsData?.provider || raw.byokConfig?.provider || null,
                byokModelName: raw.byokKmsData?.modelName || raw.byokConfig?.modelName || null,
                byokCustomUrlConfigured: !!(raw.byokKmsData?.baseUrl || raw.byokConfig?.customUrl),
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
                    message: data.message
                });
            });
        }

        logger.info(`Data export for ${userEmail}`);
        return res.status(200).send(exportData);
    } catch (err) {
        logger.error("Export error:", { error: err.message, requestId, authEmail: userEmail });
        return res.status(500).send({ error: "Failed to export data." });
    }
});

// --- GDPR: Delete User Account ---
exports.deleteUserAccount = onRequest({ cors: false, memory: "512MiB", maxInstances: 10 }, async (req, res) => {
    setStandardHeaders(res);
    if (handleOptions(req, res)) return;
    if (!applyCors(req, res)) return res.status(403).send({ error: "Origin not allowed" });

    if (req.method !== 'POST') {
        return res.status(405).send({ error: "Method not allowed" });
    }
    if (!isJsonRequest(req)) {
        return res.status(415).send({ error: "Content-Type must be application/json" });
    }
    if (!(await enforceAppCheck(req, res))) return;

    const body = req.body || {};
    const token = body.token;
    if (!token) return res.status(400).send({ error: "Missing token" });

    const requestId = require('crypto').randomUUID();
    let userEmail = "unknown";

    try {
        const decodedToken = await admin.auth().verifyIdToken(token, true);
        userEmail = getVerifiedEmail(decodedToken);
        const uid = decodedToken.uid;
        if (!userEmail) return res.status(401).send({ error: "No email in token" });

        const rl = await checkRateLimit(userEmail, 'deleteUserAccount', RATE_LIMIT_DEFAULT);
        if (!rl.allowed) {
            res.set('Retry-After', String(Math.ceil(rl.retryAfterMs / 1000)));
            return res.status(429).send({ error: "Too many requests. Please try again later." });
        }

        const db = admin.firestore();
        const userRef = db.collection('users').doc(userEmail);

        const historySnap = await userRef.collection('syncHistory').get();
        const rateLimitSnap = await db.collection('rateLimits')
            .where(admin.firestore.FieldPath.documentId(), '>=', `${userEmail}_`)
            .where(admin.firestore.FieldPath.documentId(), '<', `${userEmail}_\uf8ff`)
            .get();
        const paymentSnap = await db.collection('cashfree_orders')
            .where('userEmail', '==', userEmail)
            .get();

        // Firestore limits batches to 500 writes. Chunk all references safely.
        const allRefs = [
            ...historySnap.docs.map(d => d.ref),
            ...rateLimitSnap.docs.map(d => d.ref),
            ...paymentSnap.docs.map(d => d.ref),
            userRef
        ];

        // Delete Firestore data first. Only remove the Auth account after every
        // database batch succeeds, so a retry remains possible after a failure.
        for (let i = 0; i < allRefs.length; i += 500) {
            const batch = db.batch();
            allRefs.slice(i, i + 500).forEach(ref => batch.delete(ref));
            await batch.commit();
        }
        await admin.auth().deleteUser(uid);

        logger.info(`Account fully deleted for ${userEmail} (Firestore + Auth)`, { requestId });
        return res.status(200).send({ success: true, text: "Your account data has been permanently deleted." });
    } catch (err) {
        logger.error("Delete error:", { error: err.message, requestId, authEmail: userEmail });
        return res.status(500).send({ error: "Failed to delete account." });
    }
});

// --- MAIN ENDPOINT: syncPlanner ---
// Handles the image upload from the frontend, uses Gemini to parse, and syncs
exports.syncPlanner = onRequest({
    cors: false,
    memory: "1GiB",
    timeoutSeconds: 300,
    maxInstances: 20,
    concurrency: 10,
    secrets: [NOTION_ENCRYPTION_KEY, NOTION_ENCRYPTION_KEY_V2, GEMINI_API_KEY]
}, async (req, res) => {
    // Generate Request ID for structured logging and trace tying
    const requestId = require('crypto').randomUUID();
    const startTimeMs = Date.now();

    setStandardHeaders(res);
    if (handleOptions(req, res)) return;
    if (!applyCors(req, res)) return res.status(403).send({ error: "Origin not allowed" });

    logger.info("Incoming sync request started", { requestId, method: req.method });

    if (req.method !== 'POST') {
        const durationMs = Date.now() - startTimeMs;
        logger.warn("Method not allowed", { requestId, durationMs, status: 405 });
        return res.status(405).send({ error: "Method Not Allowed" });
    }

    if (!isJsonRequest(req)) {
        const durationMs = Date.now() - startTimeMs;
        logger.warn("Invalid Content-Type", { requestId, durationMs, status: 415 });
        return res.status(415).send({ error: "Unsupported Media Type. Expected application/json" });
    }
    if (!(await enforceAppCheck(req, res))) return;

    const body = req.body || {};

    // Validation: enforce body limit via header rather than heavy stringify
    if (req.rawBody && req.rawBody.length > MAX_REQUEST_BODY_BYTES) {
        const durationMs = Date.now() - startTimeMs;
        logger.warn("Payload size validation failed", { requestId, durationMs, size: req.rawBody.length, status: 413 });
        return res.status(413).send({ error: "Payload too large. Max 28MB allowed." });
    }

    const idToken = body.idToken;
    const googleToken = body.googleToken;
    const syncType = body.syncType;
    if (!idToken || (!googleToken && syncType !== 'journal' && syncType !== 'voice_note')) {
        const durationMs = Date.now() - startTimeMs;
        logger.warn("Missing auth tokens", { requestId, durationMs, status: 401 });
        return res.status(401).send({ error: "Unauthorized" });
    }

    let email = null; // Declare email here for broader scope
    let mode = null;
    let timeZone = body.timeZone;
    try {
        if (!timeZone || typeof timeZone !== 'string' || !Intl.supportedValuesOf('timeZone').includes(timeZone)) {
            timeZone = 'Asia/Kolkata';
        }
    } catch (e) {
        timeZone = 'Asia/Kolkata';
    }
    let parsedImages = [];
    let tierCreditsDeducted = 0;
    let boosterCreditsDeducted = 0;
    let syncSucceeded = false;
    let partialFailureRefund = false;
    let skipCreditRefund = false;

    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        email = getVerifiedEmail(decodedToken);
        if (!email) return res.status(401).send({ error: "Verified email required" });
        mode = sanitizeSyncType(body.syncType);

        // Support backward compatibility for a single image, but standardize on array
        const rawImages = body.images || (body.imageData ? [body.imageData] : []);
        parsedImages = parseImageDataArray(rawImages);

        logger.info("Processing sync payload", { requestId, authEmail: email, syncMode: mode, imageCount: parsedImages ? parsedImages.length : 0 });

        if (!ALLOWED_SYNC_TYPES.has(mode)) {
            const durationMs = Date.now() - startTimeMs;
            logger.warn("Invalid syncType", { requestId, authEmail: email, syncMode: mode, durationMs, status: 400 });
            return res.status(400).send({ error: "Invalid syncType" });
        }
        if (!parsedImages || parsedImages.length === 0 || parsedImages.length > 5) {
            const durationMs = Date.now() - startTimeMs;
            const sampleData = (rawImages && rawImages.length > 0) ? String(rawImages[0]).substring(0, 100) : 'none';
            logger.warn("Invalid image data", { requestId, authEmail: email, syncMode: mode, durationMs, status: 400, sampleData });
            return res.status(400).send({ error: "Invalid image data format, size, or too many images (max 5)." });
        }

        const rl = await checkRateLimit(email, 'syncPlanner', RATE_LIMIT_SYNC);
        if (!rl.allowed) {
            res.set('Retry-After', String(Math.ceil(rl.retryAfterMs / 1000)));
            const durationMs = Date.now() - startTimeMs;
            logger.warn("Rate limit exceeded", { requestId, authEmail: email, syncMode: mode, durationMs, status: 429 });
            return res.status(429).send({ error: "Too many requests. Please try again later." });
        }

        const { google } = require("googleapis"); // Lazy Load
        let auth = null;
        if (googleToken) {
            auth = new google.auth.OAuth2();
            auth.setCredentials({ access_token: googleToken });

            // Security Check: Ensure googleToken matches Firebase identity
            const oauth2 = google.oauth2({ version: 'v2', auth });
            const userInfo = await oauth2.userinfo.get();
            if (userInfo?.data?.email?.toLowerCase() !== email) {
                const durationMs = Date.now() - startTimeMs;
                logger.warn("Token identity mismatch", { requestId, firebaseEmail: email, googleEmail: userInfo?.data?.email, durationMs, status: 403 });
                return res.status(403).send({ error: "Token identity mismatch" });
            }
        }

        // Load & Initialize User Config from Firestore
        const db = admin.firestore();
        const userRef = db.collection('users').doc(email);
        

        // --- BYOK TRAFFIC COP ---
        let byokConfig = null;
        let hasBYOK = false;
        const statelessKey = req.headers['x-byok-token'];
        const statelessProvider = req.headers['x-byok-provider'];
        const statelessModel = req.headers['x-byok-model'];
        const statelessBaseUrl = req.headers['x-byok-baseurl'];
        const statelessApiVersion = req.headers['x-byok-apiversion'];

        if (statelessKey) {
            const statelessValidation = validateBYOKConfig({
                apiKey: statelessKey,
                provider: statelessProvider || 'openai',
                modelName: statelessModel || 'gpt-4o',
                baseUrl: statelessBaseUrl,
                apiVersion: statelessApiVersion
            }, { allowCustomUrl: customBYOKUrlsEnabled() });
            if (!statelessValidation.valid) {
                return res.status(400).send({ error: statelessValidation.error });
            }
            const normalized = statelessValidation.config;
            byokConfig = {
                apiKey: normalized.apiKey,
                provider: normalized.provider,
                modelName: normalized.modelName
            };
            if (normalized.baseUrl) byokConfig.customUrl = normalized.baseUrl;
            if (normalized.apiVersion) byokConfig.apiVersion = normalized.apiVersion;
            hasBYOK = true;
        }

        // --- GAMIFICATION: Transactional Feature Guarding & Credit Check ---
        let userData;
        try {
            userData = await db.runTransaction(async (t) => {
                const docSnap = await t.get(userRef);
                let rawData = docSnap.exists ? docSnap.data() : {};
                
                if (rawData.byokKmsData || rawData.geminiKey || (rawData.byokConfig && rawData.byokConfig.apiKey)) {
                    hasBYOK = true;
                }

                if (!body.timeZone && rawData.timeZone) {
                    timeZone = rawData.timeZone;
                }

                // Emulate initializeGamificationProfile.
                // Use the request's resolved timezone (validated above) so the monthly
                // renewal boundary matches the user's local month, not a hardcoded default.
                const todayStr = new Date().toLocaleDateString('en-CA', { timeZone });
                const defaults = {
                    tier: 'free', tierCredits: 15, boosterCredits: 0,
                    currentStreak: 0, highestStreak: 0, streakFreezes: 0,
                    dailySyncCount: 0, lastSyncDate: null, subscriptionRenewalDate: null, lastAwardedStreak: 0
                };
                let needsUpdate = false;
                const updateObj = {};
                for (const [key, val] of Object.entries(defaults)) {
                    if (rawData[key] === undefined) {
                        updateObj[key] = val;
                        rawData[key] = val;
                        needsUpdate = true;
                    }
                }

                // Persist the user's resolved timezone so streak + monthly-renewal day
                // boundaries use their local time on this and future requests (the separate
                // gamification transaction reads userData.timeZone and would otherwise
                // always fall back to the hardcoded default).
                if (timeZone && rawData.timeZone !== timeZone) {
                    rawData.timeZone = timeZone;
                    updateObj.timeZone = timeZone;
                    needsUpdate = true;
                }

                // Check Subscription Expiry BEFORE renewing credits
                if (rawData.tier !== 'free' && rawData.subscriptionExpiryDate) {
                    const expiry = new Date(rawData.subscriptionExpiryDate);
                    const now = new Date();
                    if (expiry < now) {
                        // Subscription expired! Downgrade to free.
                        rawData.tier = 'free';
                        rawData.isPremium = false;
                        rawData.tierCredits = 15;
                        updateObj.tier = 'free';
                        updateObj.isPremium = false;
                        updateObj.tierCredits = 15;
                        needsUpdate = true;
                    }
                }

                // Monthly Renewal Logic — rolling 30-day window (not calendar month)
                if (needsTierCreditRenewal(rawData, todayStr)) {
                    const tier = rawData.tier || 'free';
                    let newCredits = tier === 'pro' ? 250 : (tier === 'standard' ? 100 : 15);
                    rawData.tierCredits = newCredits;
                    stampTierCreditRenewal(rawData, todayStr, updateObj);
                    updateObj.tierCredits = newCredits;
                    needsUpdate = true;
                } else if (!rawData.lastTierCreditRenewalAt && rawData.subscriptionRenewalDate) {
                    // Migrate legacy YYYY-MM stamp to rolling date without re-granting.
                    stampTierCreditRenewal(rawData, todayStr, updateObj);
                    needsUpdate = true;
                }

                const check = checkFeaturesAndCredits(rawData, parsedImages.length, mode, hasBYOK);
                if (!check.allowed) {
                    throw new Error(JSON.stringify({ code: check.code, error: check.error }));
                }

                // Deduct credits to prevent concurrent overspending
                if (!hasBYOK) {
                    let tierCredits = rawData.tierCredits;
                    let boosterCredits = rawData.boosterCredits;
                    let creditsToDeduct = parsedImages.length;
                    
                    if (tierCredits >= creditsToDeduct) {
                        tierCredits -= creditsToDeduct;
                        tierCreditsDeducted = creditsToDeduct;
                    } else {
                        tierCreditsDeducted = tierCredits;
                        creditsToDeduct -= tierCredits;
                        tierCredits = 0;
                        boosterCredits -= creditsToDeduct;
                        boosterCreditsDeducted = creditsToDeduct;
                    }
                    updateObj.tierCredits = tierCredits;
                    updateObj.boosterCredits = boosterCredits;
                    rawData.tierCredits = tierCredits;
                    rawData.boosterCredits = boosterCredits;
                    needsUpdate = true;
                }

                if (needsUpdate) {
                    t.set(userRef, updateObj, { merge: true });
                }
                return rawData;
            });
        } catch (err) {
            try {
                const parsed = JSON.parse(err.message);
                return res.status(parsed.code).send({ error: parsed.error });
            } catch(e) {
                console.error("Credit check transaction failed:", err);
                return res.status(500).send({ error: "Failed to verify or deduct sync credits." });
            }
        }

        if (statelessKey) {
            logger.info("Traffic Cop: Routing via Stateless X-BYOK-Token header", { requestId, authEmail: email });
        } else if (userData.byokKmsData) {
            try {
                logger.info("Traffic Cop: Attempting KMS Envelope Decryption", { requestId, authEmail: email });
                const decryptedKey = await unwrapAndDecrypt(
                    userData.byokKmsData.encryptedKey, 
                    userData.byokKmsData.wrappedDek, 
                    userData.byokKmsData.iv, 
                    userData.byokKmsData.authTag
                );
                const storedValidation = validateBYOKConfig({
                    apiKey: decryptedKey,
                    provider: userData.byokKmsData.provider || 'openai',
                    modelName: userData.byokKmsData.modelName || 'gpt-4o',
                    baseUrl: userData.byokKmsData.baseUrl,
                    apiVersion: userData.byokKmsData.apiVersion
                }, { allowCustomUrl: customBYOKUrlsEnabled() });
                if (!storedValidation.valid) {
                    logger.warn("Stored BYOK configuration rejected by current policy", {
                        requestId,
                        authEmail: email,
                        reason: storedValidation.error
                    });
                    return res.status(400).send({ error: storedValidation.error });
                }
                const normalizedStoredByok = storedValidation.config;
                byokConfig = {
                    apiKey: normalizedStoredByok.apiKey,
                    provider: normalizedStoredByok.provider,
                    modelName: normalizedStoredByok.modelName
                };
                if (normalizedStoredByok.baseUrl) byokConfig.customUrl = normalizedStoredByok.baseUrl;
                if (normalizedStoredByok.apiVersion) byokConfig.apiVersion = normalizedStoredByok.apiVersion;
            } catch (err) {
                logger.error("KMS Decryption error", { error: err.message, requestId, authEmail: email });
                throw new Error(JSON.stringify({ code: 500, error: "Failed to decrypt BYOK configuration." }));
            }
        }

        // Initialize Services
        const calendar = google.calendar({ version: 'v3', auth });
        const tasks = google.tasks({ version: 'v1', auth });
        const sheets = google.sheets({ version: 'v4', auth });

        // --- 1. HANDLE JOURNAL & VOICE NOTE SYNC SEPARATELY ---
        let msg = "";
        if (mode === 'journal' || mode === 'voice_note') {
            if (!userData.notionKey || !userData.notionDbId) {
                const durationMs = Date.now() - startTimeMs;
                logger.warn(`Notion not setup for ${mode} sync`, { requestId, authEmail: email, syncMode: mode, durationMs, status: 400 });
                skipCreditRefund = true;
                return res.status(400).send({ error: "Notion not setup. Please provide keys." });
            }

            // Create Notion Client (Lazy Load)
            const decryptedNotionKey = await getDecryptedNotionKeyAndMigrate(userRef, userData);
            if (!decryptedNotionKey) {
                const durationMs = Date.now() - startTimeMs;
                logger.error(`Failed to decrypt Notion key for ${mode} sync`, { requestId, authEmail: email, syncMode: mode, durationMs, status: 401 });
                skipCreditRefund = true;
                return res.status(401).send({ error: "Invalid or corrupt Notion settings. Please re-setup Notion." });
            }
            const notion = createNotionClient(decryptedNotionKey);

            // PARALLEL EXECUTION: Upload Limitless Image(s) to Notion Directly (Zero Storage) & Extract Date
            logger.info(`Starting parallel ${mode} processing (Zero Storage)...`, { requestId, authEmail: email, syncMode: mode });

            const fileUploadPromises = parsedImages.map((img, i) => {
                let ext = 'jpg';
                if (img.mimeType.includes('png')) ext = 'png';
                if (img.mimeType.includes('webp')) ext = 'webp';
                if (img.mimeType.includes('mp4')) ext = 'mp4';
                if (img.mimeType.includes('webm')) ext = 'webm';
                if (img.mimeType.includes('mpeg') || img.mimeType.includes('mp3')) ext = 'mp3';
                if (img.mimeType.includes('wav')) ext = 'wav';
                if (img.mimeType.includes('ogg')) ext = 'ogg';
                
                const filename = `${mode}_${i + 1}.${ext}`;
                return uploadFileToNotion(decryptedNotionKey, Buffer.from(img.base64Data, 'base64'), img.mimeType, filename);
            });

            // Determine prompt type based on mode and tier
            let geminiSyncType = mode;
            if (mode === 'journal') {
                 geminiSyncType = userData.tier === 'pro' ? 'journal_transcribe' : 'journal_date_only';
            }

            const [fileUploadIds, extraction] = await Promise.all([
                Promise.all(fileUploadPromises),
                getPlannerDataFromImages(parsedImages, geminiSyncType, byokConfig).catch(err => {
                    logger.warn(`Extraction failed for ${mode}:`, { requestId, authEmail: email, syncMode: mode, error: err.message });
                    return { date: null, transcription: "" };
                })
            ]);

            let itemDate = new Date().toLocaleDateString('en-US', { timeZone });
            if (extraction && extraction.date) {
                itemDate = extraction.date;
                logger.info(`Extracted ${mode} Date: ${itemDate}`, { requestId, authEmail: email, syncMode: mode, itemDate });
            }

            // Create Notion Page with File Attachments
            const dbId = userData.notionDbId;
            const childrenBlocks = fileUploadIds.map((id, index) => {
                const mimeType = parsedImages[index].mimeType;
                const blockType = mimeType.startsWith('audio/') ? 'file' : 'image';
                
                return {
                    object: 'block',
                    type: blockType,
                    [blockType]: {
                        type: 'file_upload',
                        file_upload: { id: id }
                    }
                };
            });

            if (extraction && extraction.transcription) {
                const paragraphs = extraction.transcription.split('\n').filter(p => p.trim() !== '');
                for (const p of paragraphs) {
                    // Split paragraphs larger than 2000 chars into multiple blocks (Notion API limits)
                    const chunks = p.match(/.{1,2000}/g) || [];
                    for (const chunk of chunks) {
                        childrenBlocks.push({
                            object: 'block',
                            type: 'paragraph',
                            paragraph: {
                                rich_text: [{ type: 'text', text: { content: chunk } }]
                            }
                        });
                    }
                }
            }

            const pageTitle = mode === 'voice_note' ? `Voice Note - ${itemDate}` : `Journal - ${itemDate}`;

            await createPageInDatabase(notion, dbId, {
                properties: {
                    "Name": { title: [{ text: { content: pageTitle } }] }
                },
                children: childrenBlocks,
            });
            msg = `${mode === 'voice_note' ? 'Voice Note' : 'Journal'} synced to Notion! Date: ${itemDate}`;
            msg = appendGamificationToMsg(msg, await runGamificationAfterSync(userRef, {
                requestId, authEmail: email, syncMode: mode, imageCount: parsedImages.length
            }));
            await logSyncHistory(userRef, mode, parsedImages.length, 'success', msg);
            await incrementUsageCounters(userRef, parsedImages.length);
            const durationMs = Date.now() - startTimeMs;
            logger.info("Sync transaction complete", {
                requestId,
                authEmail: email,
                syncMode: mode,
                durationMs,
                status: 200,
                type: 'latency'
            });
            syncSucceeded = true;
            return res.status(200).send({ text: msg });
        }

        // --- BRANCH 2: MORNING/EVENING PLANNER ---
        let plannerData;

        if (mode === 'morning') {
            logger.info("Parsing planner images for morning sync...", { requestId, authEmail: email });
            plannerData = await getPlannerDataFromImages(parsedImages, 'morning', byokConfig);

            if (plannerData.error) {
                await logSyncHistory(userRef, mode, parsedImages.length, 'error', plannerData.error);
                skipCreditRefund = true;
                return res.status(400).send({ error: plannerData.error });
            }

            logger.info("Starting parallel Morning sync...", { requestId, authEmail: email });

            // Parallel: Add Events to Calendar AND Add Tasks to Google Tasks.
            const dedupCalendar = userData.dedupCalendar !== false; // default: ON
            const dedupTasks = userData.dedupTasks !== false;       // default: ON
            const [eventResults, taskResults] = await Promise.all([
                syncCalendarEvents(calendar, plannerData, timeZone, dedupCalendar),
                syncGoogleTasks(tasks, plannerData, dedupTasks)
            ]);

            msg = `Morning Sync Complete! Created ${eventResults.events} events, ${eventResults.reminders} reminders, and ${taskResults.tasks} tasks.`;
            if (eventResults.skippedDuplicates > 0 || taskResults.skippedDuplicates > 0) {
                let skipDetails = [];
                if (eventResults.skippedDuplicates > 0) skipDetails.push(`${eventResults.skippedDuplicates} events`);
                if (taskResults.skippedDuplicates > 0) skipDetails.push(`${taskResults.skippedDuplicates} tasks`);
                msg += ` (Skipped ${skipDetails.join(" and ")} that already existed).`;
            }
            logger.info(msg, { requestId, authEmail: email });

            msg = appendGamificationToMsg(msg, await runGamificationAfterSync(userRef, {
                requestId, authEmail: email, syncMode: mode, imageCount: parsedImages.length
            }));

            await logSyncHistory(userRef, mode, parsedImages.length, 'success', msg);
            await incrementUsageCounters(userRef, parsedImages.length);
            syncSucceeded = true;
            return res.status(200).send({ text: msg });

        } else if (mode === 'evening') {
            // Re-scan images specifically looking for evening data (expenses, mood, etc).
            logger.info("Parsing planner images for evening sync...", { requestId, authEmail: email });
            plannerData = await getPlannerDataFromImages(parsedImages, 'evening', byokConfig);
            if (plannerData.error) {
                await logSyncHistory(userRef, mode, parsedImages.length, 'error', plannerData.error);
                skipCreditRefund = true;
                return res.status(400).send({ error: plannerData.error });
            }

            logger.info("Evening planner extraction summary", {
                requestId,
                authEmail: email,
                hasBrainDumpText: !!normalizeBrainDumpText(plannerData.brainDump),
                brainDumpType: plannerData.brainDump == null ? 'missing' : typeof plannerData.brainDump,
                expenseCount: Array.isArray(plannerData.expenses) ? plannerData.expenses.length : 0,
            });

            let successMessages = [];

            // 1. Mark tasks as completed in Google Tasks based on checkmarks in image.
            const updatedTasks = await updateCompletedTasks(tasks, plannerData);
            if (updatedTasks > 0) successMessages.push(`Marked ${updatedTasks} tasks completed.`);

            // ---- AUTO-CREATE SPREADSHEET IF MISSING ----
            let spreadsheetId = userData.spreadsheetId;
            if (!spreadsheetId) {
                logger.info("No spreadsheet found. Creating new one...", { requestId, authEmail: email });
                const newSheet = await sheets.spreadsheets.create({
                    resource: {
                        properties: { title: "AI Planner Data" },
                        sheets: [
                            { properties: { title: "Expenses" } },
                            { properties: { title: "Health" } }
                        ]
                    }
                });
                spreadsheetId = newSheet.data.spreadsheetId;
                // Add Headers
                await sheets.spreadsheets.values.update({
                    spreadsheetId, range: 'Expenses!A1:C1', valueInputOption: 'RAW',
                    requestBody: { values: [["Date", "Item", "Amount"]] }
                });
                await sheets.spreadsheets.values.update({
                    spreadsheetId, range: 'Health!A1:E1', valueInputOption: 'RAW',
                    requestBody: { values: [["Date", "Exercise", "Water", "Sleep", "Energy"]] }
                });

                await userRef.set({ spreadsheetId }, { merge: true });
                successMessages.push("(Created new 'AI Planner Data' Sheet).");
            }

            // PARALLEL EXECUTION: Sheets (Expenses, Health) and Notion (Image+Text)
            logger.info("Starting parallel Evening sync...", { requestId, authEmail: email });

            const promises = [
                syncExpensesToSheet(sheets, plannerData, spreadsheetId),
                syncHealthToSheet(sheets, plannerData, spreadsheetId)
            ];

            // Handle Notion Branch
            if (userData.notionKey && userData.notionDbId) {
                const decryptedNotionKey = await getDecryptedNotionKeyAndMigrate(userRef, userData);

                if (decryptedNotionKey) {
                    const brainDumpPromise = async () => {
                        const brainDumpText = normalizeBrainDumpText(plannerData.brainDump);
                        if (plannerData.brainDump != null && typeof plannerData.brainDump !== 'string') {
                            return {
                                ok: false,
                                reason: `AI returned brainDump as ${typeof plannerData.brainDump}; expected handwritten text.`,
                            };
                        }

                        const firstImage = parsedImages[0];
                        const hasImage = !!(firstImage && firstImage.base64Data);
                        if (!brainDumpText && !hasImage) {
                            return {
                                ok: false,
                                reason: 'No Brain Dump text found on the planner page and no image to attach.',
                            };
                        }

                        logger.info("Starting Brain Dump to Notion sync...", {
                            requestId,
                            authEmail: email,
                            hasBrainDumpText: !!brainDumpText,
                            hasImage,
                        });

                        let fileId = null;
                        if (hasImage) {
                            const buffer = Buffer.from(firstImage.base64Data, 'base64');
                            let ext = 'jpg';
                            if (firstImage.mimeType.includes('png')) ext = 'png';
                            if (firstImage.mimeType.includes('webp')) ext = 'webp';
                            const filename = `${mode}_planner.${ext}`;
                            fileId = await uploadFileToNotion(decryptedNotionKey, buffer, firstImage.mimeType, filename);
                        }

                        return syncBrainDumpToNotion(
                            { ...plannerData, brainDump: brainDumpText },
                            decryptedNotionKey,
                            userData.notionDbId,
                            fileId
                        );
                    };
                    promises.push(brainDumpPromise());
                } else {
                    successMessages.push("(Skipped Notion - Failed to decrypt key).");
                }
            } else {
                successMessages.push("(Skipped Notion - Keys missing).");
            }

            // Await all (Promise.allSettled allows partial success)
            const results = await Promise.allSettled(promises);

            // Helper to get value or log error
            const getResult = (result, name) => {
                if (result.status === 'fulfilled') return result.value;
                logger.error(`${name} Sync Failed:`, { error: result.reason?.message || result.reason, requestId, authEmail: email });
                return (name === 'Notion') ? null : 0;
            };

            const addedExpenses = getResult(results[0], 'Expenses');
            const addedHealth = getResult(results[1], 'Health');
            const notionBranch = results.length > 2 ? results[2] : null;

            if (addedExpenses > 0) successMessages.push(`Added ${addedExpenses} expenses to Sheet.`);
            if (addedHealth > 0) successMessages.push(`Logged Health & Wellness.`);

            if (notionBranch) {
                if (notionBranch.status === 'rejected') {
                    const detail = notionBranch.reason?.message || String(notionBranch.reason);
                    successMessages.push(`(Notion not saved: ${detail})`);
                } else {
                    appendEveningNotionOutcomeMessage(successMessages, notionBranch.value);
                }
            }

            // Detect genuinely failed branches (rejections, not empty/duplicate 0-returns)
            // so we can tell the user and refund rather than silently charging a credit
            // for an incomplete sync.
            const branchNames = ['Expenses', 'Health', 'Notion'];
            const failedBranches = results
                .map((r, i) => (r.status === 'rejected' ? branchNames[i] : null))
                .filter(Boolean);
            if (failedBranches.length > 0) {
                partialFailureRefund = true;
                successMessages.push(`⚠️ Could not sync: ${failedBranches.join(', ')}. Your credit was refunded — please try again.`);
            }

            if (successMessages.length === 0) msg = "Night Sync output: No items found to sync.";
            else msg = "Night Sync Complete: " + successMessages.join(" ");

            msg = appendGamificationToMsg(msg, await runGamificationAfterSync(userRef, {
                skip: partialFailureRefund,
                requestId, authEmail: email, syncMode: mode, imageCount: parsedImages.length
            }));

            await logSyncHistory(userRef, mode, parsedImages.length, partialFailureRefund ? 'partial' : 'success', msg);
            await incrementUsageCounters(userRef, parsedImages.length);
        } else {
            await logSyncHistory(userRef, mode, parsedImages.length, 'error', `Invalid syncType: ${mode}`);
            return res.status(400).send({ error: `Invalid syncType: ${mode}` });
        }

        logger.info(msg, { requestId, authEmail: email });
        syncSucceeded = true;
        res.status(200).send({ text: msg });

    } catch (error) {
        const errMsg = error?.message || String(error || "Unknown error");
        logger.error("FATAL ERROR:", { error: errMsg, requestId, authEmail: email });

        // Client-caused AI / validation failures: charge the credit (no refund).
        if (/API_ERROR_4\d\d:/.test(errMsg) || errMsg === 'INVALID_IMAGE_PAYLOAD') {
            skipCreditRefund = true;
        }

        // Try to log the failure if we have user context
        try {
            const body = req.body || {};
            const idToken = body.idToken;
            if (idToken) {
                const decodedToken = await admin.auth().verifyIdToken(idToken);
                const userEmail = getVerifiedEmail(decodedToken);
                if (userEmail) {
                    const db = admin.firestore();
                    const userRef = db.collection('users').doc(userEmail);
                    const mode = sanitizeSyncType(body.syncType);
                    const images = body.images || (body.imageData ? [body.imageData] : []);
                    await logSyncHistory(userRef, mode, images.length || 1, 'error', "Internal error occurred during sync.");
                }
            }
        } catch (logErr) {
            logger.error("Failed to log error history:", { error: logErr.message, requestId, authEmail: email });
        }

        // Security: Don't leak internals to client
        let safeMessage = "Internal Server Error";
        let statusCode = 500;
        if (errMsg.includes("RATE_LIMIT")) {
            safeMessage = "AI Service Busy. Please try again.";
        } else if (/API_ERROR_4\d\d:/.test(errMsg)) {
            safeMessage = "Could not process image. Please check your upload and try again.";
            statusCode = 400;
        }
        res.status(statusCode).send({ error: safeMessage });
    } finally {
        // Refund on a hard failure (syncSucceeded never set) OR a partial failure where
        // one or more evening branches errored after the credit was already deducted.
        // Never refund client-caused errors (bad image, missing setup, AI validation).
        if (!skipCreditRefund && (!syncSucceeded || partialFailureRefund) && (tierCreditsDeducted > 0 || boosterCreditsDeducted > 0) && email) {
            try {
                const db = admin.firestore();
                const userRef = db.collection('users').doc(email);
                const updates = {};
                if (tierCreditsDeducted > 0) updates.tierCredits = admin.firestore.FieldValue.increment(tierCreditsDeducted);
                if (boosterCreditsDeducted > 0) updates.boosterCredits = admin.firestore.FieldValue.increment(boosterCreditsDeducted);
                await userRef.update(updates);
                logger.info(`Refunded tier:${tierCreditsDeducted} booster:${boosterCreditsDeducted} to ${email} due to sync failure.`, { requestId, authEmail: email });
            } catch (refundErr) {
                logger.error("Failed to refund credits:", { error: refundErr.message, requestId, authEmail: email });
            }
        }
    }
});

// --- FIRESTORE LOGGING ---
async function logSyncHistory(userRef, syncType, imageCount, status, message) {
    try {
        await userRef.collection('syncHistory').add({
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            syncType,
            imageCount,
            status,
            message
        });
    } catch (error) {
        logger.error("Failed to log sync history:", error);
    }
}

async function incrementUsageCounters(userRef, imageCount) {
    try {
        await userRef.set({
            totalSyncs: admin.firestore.FieldValue.increment(1),
            totalImagesProcessed: admin.firestore.FieldValue.increment(imageCount)
        }, { merge: true });
    } catch (error) {
        logger.error("Failed to increment usage counters:", error);
    }
}

// Logic delegated to GoogleSync and Notion services

// --- GCP Error Reporting: Frontend Ingestion Endpoint ---
exports.logClientError = onRequest({ cors: false, memory: "128MiB", maxInstances: 10 }, async (req, res) => {
    setStandardHeaders(res);
    if (handleOptions(req, res)) return;
    if (!applyCors(req, res)) return res.status(403).send({ error: "Origin not allowed" });

    if (req.method !== 'POST') {
        return res.status(405).send({ error: "Method not allowed" });
    }
    if (!isJsonRequest(req)) {
        return res.status(415).send({ error: "Content-Type must be application/json" });
    }
    if (!(await enforceAppCheck(req, res))) return;
    if (req.rawBody && req.rawBody.length > 16 * 1024) {
        return res.status(413).send({ error: "Error report too large" });
    }

    const { message, stack, url, line, column, idToken } = req.body || {};

    if (typeof message !== 'string' || !message.trim()) return res.status(400).send({ error: "Message required" });
    if (message.length > 1000) return res.status(400).send({ error: "Message too large" });
    if (stack !== undefined && typeof stack !== 'string') return res.status(400).send({ error: "Stack must be text" });
    if (stack && stack.length > 5000) return res.status(400).send({ error: "Stack too large" });

    let reporter = 'Anonymous';
    let rateLimitIdentity;
    if (idToken) {
        try {
            const decodedToken = await admin.auth().verifyIdToken(idToken);
            reporter = decodedToken.uid || 'Authenticated';
            rateLimitIdentity = `uid_${decodedToken.uid || 'unknown'}`;
        } catch (_) {
            return res.status(401).send({ error: "Invalid identity token" });
        }
    }

    try {
        const clientIp = req.ip || req.headers['x-forwarded-for'] || 'anonymous';
        const rl = await checkRateLimit(rateLimitIdentity || `ip_${clientIp}`, 'logClientError', 5);
        if (!rl.allowed) {
            return res.status(429).send({ error: "Rate limit exceeded" });
        }
    } catch (e) {
        console.error("RATE LIMIT ERR", e);
        // Fail CLOSED: if rate limiting infrastructure is down, reject the request
        return res.status(503).send({ error: "Service temporarily unavailable" });
    }

    // Sanitize client-supplied fields before logging to prevent log injection
    const safeMessage = sanitizeControlCharacters(message, ' ').slice(0, 1000);
    const safeStack = sanitizeControlCharacters(stack || 'No stack trace provided', ' ').slice(0, 5000);
    let safeUrl = 'Unknown URL';
    if (typeof url === 'string') {
        try {
            const parsedUrl = new URL(url);
            safeUrl = `${parsedUrl.origin}${parsedUrl.pathname}`.slice(0, 500);
        } catch (_) {
            safeUrl = sanitizeControlCharacters(url).split(/[?#]/)[0].slice(0, 500);
        }
    }
    const safeLine = Number.isInteger(line) && line >= 0 && line <= 10_000_000 ? line : null;
    const safeColumn = Number.isInteger(column) && column >= 0 && column <= 10_000_000 ? column : null;

    // Construct a rich error string for GCP
    const errorBody = [
        `Frontend Error: ${safeMessage}`,
        `Reporter: ${reporter}`,
        `URL: ${safeUrl}${(safeLine !== null && safeColumn !== null) ? `:${safeLine}:${safeColumn}` : ''}`,
        `Stack Trace: ${safeStack}`
    ].join('\n');

    // Passing an Error object triggers native GCP Error Reporting aggregation
    logger.error("Client caught unhandled exception", new Error(errorBody));

    return res.status(200).send({ success: true });
});


// Gemini prompts have been extracted to services/gemini.js

if (process.env.NODE_ENV === 'test') {
    exports.applyGamificationMilestones = applyGamificationMilestones;
    exports.runGamificationAfterSync = runGamificationAfterSync;
    exports.needsTierCreditRenewal = needsTierCreditRenewal;
    exports.calendarDayDiff = calendarDayDiff;
}

// --- CASHFREE PAYMENT INTEGRATION ---
exports.createCashfreeOrder = onRequest({
    cors: false,
    memory: "256MiB",
    maxInstances: 10,
    secrets: [CASHFREE_APP_ID, CASHFREE_SECRET_KEY]
}, async (req, res) => {
    setStandardHeaders(res);
    if (handleOptions(req, res)) return;
    if (!applyCors(req, res)) return res.status(403).send({ error: "Origin not allowed" });

    if (req.method !== 'POST') return res.status(405).send({ error: "Method not allowed" });
    if (!isJsonRequest(req)) return res.status(415).send({ error: "Content-Type must be application/json" });
    if (!(await enforceAppCheck(req, res))) return;

    const { idToken, price, phone } = req.body || {};
    if (!idToken || price === undefined || price === null || !phone) {
        return res.status(400).send({ error: "Missing required fields" });
    }
    const normalizedPrice = normalizePrice(price);
    if (normalizedPrice === null) return res.status(400).send({ error: 'Invalid price' });
    const normalizedPhone = String(phone).replace(/\D/g, '');
    if (!/^[6-9]\d{9}$/.test(normalizedPhone)) {
        return res.status(400).send({ error: 'Invalid Indian mobile number' });
    }

    try {
        const config = getCashfreeConfig();
        const decodedToken = await admin.auth().verifyIdToken(idToken, true);
        const userEmail = getVerifiedEmail(decodedToken);
        if (!userEmail) return res.status(401).send({ error: "Verified email required" });
        
        const rl = await checkRateLimit(userEmail, 'createCashfreeOrder', RATE_LIMIT_DEFAULT);
        if (!rl.allowed) {
            res.set('Retry-After', String(Math.ceil(rl.retryAfterMs / 1000)));
            return res.status(429).send({ error: "Too many requests" });
        }

        const userId = decodedToken.uid;
        const orderId = `order_${crypto.randomUUID()}`;
        const data = await createCashfreeGatewayOrder(config, {
            order_id: orderId,
            order_amount: normalizedPrice,
            order_currency: "INR",
            customer_details: {
                customer_id: userId,
                customer_email: userEmail,
                customer_phone: normalizedPhone
            },
            order_meta: {
                notify_url: config.notifyUrl
            }
        });

        if (!data?.payment_session_id || (data.order_id && data.order_id !== orderId)) {
            logger.error("Cashfree returned an invalid order creation response", { orderId });
            return res.status(502).send({ error: "Payment gateway returned an invalid response" });
        }

        // Store pending order in firestore
        await admin.firestore().collection('cashfree_orders').doc(orderId).set({
            userId,
            userEmail,
            price: normalizedPrice,
            amountPaise: normalizedPrice * 100,
            currency: 'INR',
            environment: config.environment,
            status: 'PENDING',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            payment_session_id: data.payment_session_id
        });

        res.status(200).send({
            payment_session_id: data.payment_session_id,
            payment_environment: config.checkoutMode
        });
    } catch (error) {
        if (error?.code === 'PAYMENTS_DISABLED' || error?.code === 'PAYMENTS_MISCONFIGURED') {
            logger.warn("Payment order creation rejected by configuration", { code: error.code });
            return res.status(503).send({ error: "Payments are temporarily unavailable" });
        }
        logger.error("Cashfree Route Error:", { error: error?.message });
        res.status(502).send({ error: "Payment gateway failure" });
    }
});

exports.cashfreeWebhook = onRequest({
    cors: false,
    memory: "256MiB",
    maxInstances: 10,
    secrets: [CASHFREE_APP_ID, CASHFREE_SECRET_KEY]
}, async (req, res) => {
    setStandardHeaders(res);
    // Webhooks are server-to-server POSTs
    if (req.method !== 'POST') return res.status(405).send({ error: "Method not allowed" });
    if (!isJsonRequest(req)) return res.status(415).send("Unsupported media type");
    if (!req.rawBody || !Buffer.isBuffer(req.rawBody)) {
        return res.status(400).send("Raw webhook body required");
    }
    if (req.rawBody.length > 128 * 1024) {
        return res.status(413).send("Webhook payload too large");
    }
    
    try {
        const config = getCashfreeConfig();
        const signature = req.headers['x-webhook-signature'];
        const timestamp = req.headers['x-webhook-timestamp'];
        const webhookVersion = req.headers['x-webhook-version'];
        if (
            typeof signature !== 'string'
            || typeof timestamp !== 'string'
            || !/^\d{10,16}$/.test(timestamp)
            || !['2023-08-01', '2025-01-01'].includes(webhookVersion)
        ) {
            return res.status(400).send("Missing or invalid webhook headers");
        }
        const rawBody = req.rawBody.toString('utf8');
        const expectedSig = crypto.createHmac('sha256', config.secretKey)
            .update(timestamp + rawBody).digest('base64');
        const receivedBuffer = Buffer.from(signature);
        const expectedBuffer = Buffer.from(expectedSig);
        if (
            receivedBuffer.length !== expectedBuffer.length
            || !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
        ) {
            return res.status(401).send('Invalid webhook signature');
        }

        const payload = req.body;
        if (!payload?.data?.order || !payload?.data?.payment) {
            return res.status(400).send("Invalid payload");
        }

        const orderId = payload.data.order.order_id;
        const txStatus = payload.data.payment.payment_status;
        if (typeof orderId !== 'string' || orderId.length > 128 || typeof txStatus !== 'string') {
            return res.status(400).send("Invalid payment fields");
        }

        const rl = await checkRateLimit(`cashfree_${orderId}`, 'cashfreeWebhook', 60);
        if (!rl.allowed) return res.status(429).send("Too many webhook attempts");
        
        const orderRef = admin.firestore().collection('cashfree_orders').doc(orderId);
        const initialOrderSnap = await orderRef.get();
        if (!initialOrderSnap.exists) return res.status(404).send("Order not found");
        const initialOrder = initialOrderSnap.data();
        if (initialOrder.status === 'SUCCESS') return res.status(200).send("Webhook already processed");
        if (initialOrder.environment !== config.environment) {
            return res.status(409).send("Payment environment mismatch");
        }

        const expectedPrice = normalizePrice(initialOrder.price);
        const expectedAmountPaise = Number.isInteger(initialOrder.amountPaise)
            ? initialOrder.amountPaise
            : (expectedPrice === null ? null : expectedPrice * 100);
        if (expectedPrice === null || expectedAmountPaise === null) {
            await orderRef.update({
                status: 'REVIEW_REQUIRED',
                reviewReason: 'INVALID_STORED_PRICE',
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            return res.status(422).send("Order requires review");
        }

        const webhookOrderAmountPaise = Math.round(Number(payload.data.order.order_amount) * 100);
        const webhookCurrency = payload.data.order.order_currency;
        if (webhookOrderAmountPaise !== expectedAmountPaise || webhookCurrency !== 'INR') {
            return res.status(409).send("Webhook order amount or currency mismatch");
        }

        if (txStatus === 'SUCCESS' && payload.type !== 'PAYMENT_SUCCESS_WEBHOOK') {
            return res.status(400).send("Invalid success webhook type");
        }

        if (txStatus !== 'SUCCESS') {
            await admin.firestore().runTransaction(async (t) => {
                const latest = await t.get(orderRef);
                if (!latest.exists || latest.data().status === 'SUCCESS') return;
                t.update(orderRef, {
                    status: txStatus,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            });
            return res.status(200).send("Non-success webhook recorded");
        }

        const gatewayOrder = await getCashfreeOrder(config, orderId);
        const gatewayAmountPaise = Math.round(Number(gatewayOrder?.order_amount) * 100);
        if (
            gatewayOrder?.order_id !== orderId
            || gatewayOrder?.order_status !== 'PAID'
            || gatewayAmountPaise !== expectedAmountPaise
            || gatewayOrder?.order_currency !== 'INR'
            || (gatewayOrder?.customer_details?.customer_id
                && gatewayOrder.customer_details.customer_id !== initialOrder.userId)
        ) {
            return res.status(409).send("Cashfree order verification failed");
        }

        const paymentId = String(payload.data.payment.cf_payment_id || '');
        if (!paymentId || paymentId.length > 128) {
            return res.status(400).send("Missing payment identifier");
        }

        const transactionResult = await admin.firestore().runTransaction(async (t) => {
            const orderSnap = await t.get(orderRef);
            if (!orderSnap.exists) {
                throw new Error("Order not found");
            }

            const orderData = orderSnap.data();
            if (orderData.status === 'SUCCESS') {
                return { alreadyProcessed: true };
            }
            if (orderData.environment !== config.environment) {
                throw new Error("Payment environment mismatch");
            }

            const p = normalizePrice(orderData.price);
            if (p === null) {
                t.update(orderRef, {
                    status: 'REVIEW_REQUIRED',
                    reviewReason: 'INVALID_STORED_PRICE',
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                return { reviewRequired: true };
            }
            let updates = {};
            let logMsg = "";
                
            const userRef = admin.firestore().collection('users').doc(orderData.userEmail);
            const userSnap = await t.get(userRef);
            const userData = userSnap.exists ? userSnap.data() : {};
                
            let currentExpiry = userData.subscriptionExpiryDate ? new Date(userData.subscriptionExpiryDate) : new Date();
            if (currentExpiry < new Date()) currentExpiry = new Date();

            let daysToAdd = 0;
            if ([29, 49].includes(p)) daysToAdd = 30;
            else if ([79, 129].includes(p)) daysToAdd = 90;
            else if ([290, 490].includes(p)) daysToAdd = 365;

            if (daysToAdd > 0) currentExpiry.setDate(currentExpiry.getDate() + daysToAdd);
            const expiryISO = currentExpiry.toISOString();
            const paymentRenewalStamp = new Date().toISOString().slice(0, 10);
                
            if (p === 19) {
                updates = { boosterCredits: admin.firestore.FieldValue.increment(50) };
                logMsg = `Cashfree payment success. Granted 50 Booster Credits to user ${orderData.userId}`;
            } else if ([29, 79, 290].includes(p)) {
                updates = {
                    tier: 'standard',
                    tierCredits: 100,
                    isPremium: true,
                    subscriptionExpiryDate: expiryISO,
                    lastTierCreditRenewalAt: paymentRenewalStamp,
                    subscriptionRenewalDate: paymentRenewalStamp.slice(0, 7)
                };
                logMsg = `Cashfree payment success. Granted Standard to user ${orderData.userId}`;
            } else if ([49, 129, 490].includes(p)) {
                updates = {
                    tier: 'pro',
                    tierCredits: 250,
                    isPremium: true,
                    subscriptionExpiryDate: expiryISO,
                    lastTierCreditRenewalAt: paymentRenewalStamp,
                    subscriptionRenewalDate: paymentRenewalStamp.slice(0, 7)
                };
                logMsg = `Cashfree payment success. Granted Pro to user ${orderData.userId}`;
            }

            t.update(orderRef, {
                status: 'SUCCESS',
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                cashfreePaymentId: paymentId,
                paymentStatus: txStatus,
                paymentAmount: Number(payload.data.payment.payment_amount),
                paymentCurrency: payload.data.payment.payment_currency || null,
                paymentTime: payload.data.payment.payment_time || null,
                verifiedOrderStatus: gatewayOrder.order_status
            });

            t.set(userRef, updates, { merge: true });
            logger.info(logMsg);
            return { fulfilled: true };
        });

        if (transactionResult?.reviewRequired) return res.status(422).send("Order requires review");
        res.status(200).send("Webhook received");
    } catch (error) {
        if (error.message === "Order not found") {
            return res.status(404).send("Order not found");
        }
        if (error?.code === 'PAYMENTS_DISABLED' || error?.code === 'PAYMENTS_MISCONFIGURED') {
            logger.error("Cashfree webhook rejected by configuration", { code: error.code });
            return res.status(503).send("Webhook not configured");
        }
        logger.error("Webhook Error:", { error: error?.message });
        res.status(500).send("Webhook Error");
    }
});

exports.adminGrantCredits = onRequest({ memory: "512MiB", timeoutSeconds: 540, maxInstances: 1 }, async (req, res) => {
    setStandardHeaders(res);
    if (handleOptions(req, res)) return;
    if (req.method !== 'POST') return res.status(405).send({ error: "Method not allowed" });
    if (!isJsonRequest(req)) return res.status(415).send({ error: "Content-Type must be application/json" });

    const expectedToken = String(CREDITS_GRANT_TOKEN.value() || '').trim();
    const providedToken = String(req.get('x-credits-grant-token') || '').trim();
    if (!expectedToken || providedToken !== expectedToken) {
        return res.status(403).send({ error: "Forbidden" });
    }

    const body = req.body || {};
    if (body.confirm !== 'GRANT-CREDITS-25') {
        return res.status(400).send({ error: "Invalid confirm phrase" });
    }

    const amount = Number(body.amount ?? 25);
    if (!Number.isInteger(amount) || amount <= 0 || amount > 500) {
        return res.status(400).send({ error: "Invalid amount" });
    }

    try {
        const db = admin.firestore();
        const stats = await grantBoosterCreditsToAllUsers(db, amount, { dryRun: body.dryRun === true });
        logger.info("Admin credit grant completed", stats);
        return res.status(200).send({ success: true, stats });
    } catch (err) {
        logger.error("Admin credit grant failed", { error: err.message });
        return res.status(500).send({ error: "Failed to grant credits" });
    }
});

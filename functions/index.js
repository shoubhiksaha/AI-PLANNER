const { onRequest } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/logger");
const admin = require("firebase-admin");
// Import Extracted Services
const { checkRateLimit } = require('./services/rateLimit');
const { getPlannerDataFromImages } = require('./services/gemini');
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
    uploadFileToNotion, 
    syncBrainDumpToNotion 
} = require('./services/notion');

// Initialize Firebase Admin with explicit bucket
admin.initializeApp({
    storageBucket: "ai-planner-project-467800.firebasestorage.app"
});

// --- CONFIGURATION ---
const { defineString, defineSecret } = require('firebase-functions/params');
const GEMINI_API_KEY = defineString('GEMINI_API_KEY');
const NOTION_ENCRYPTION_KEY = defineSecret('NOTION_ENCRYPTION_KEY');
const NOTION_ENCRYPTION_KEY_V2 = defineSecret('NOTION_ENCRYPTION_KEY_V2');

// --- UTILITIES (shared with tests) ---
const crypto = require('crypto');
const {
    deriveKey,
    encrypt: _encryptWithKey,
    decryptCurrentGcm: _decryptGcmWithKey,
    decryptLegacyCbc: _decryptCbcWithKey,
    sanitizeSyncType,
    parseImageDataUrl,
    parseImageDataArray,
    normalizeNotionDbId,
    isLikelyNotionKey,
    isJsonRequest,
    setStandardHeaders,
    applyCors,
    ALLOWED_ORIGINS,
    MAX_BASE64_LENGTH,
    ALLOWED_SYNC_TYPES,
    MAX_IMAGE_BYTES,
    handleOptions,
    validateTokenFormat,
    parseDateTime,
    RATE_LIMIT_SYNC,
    RATE_LIMIT_DEFAULT,
    RATE_LIMIT_WINDOW_MS,
} = require('./utils');
const ALGORITHM = 'aes-256-gcm';
const LEGACY_ALGORITHM = 'aes-256-cbc';

// Crypto logic and Rate Limits have been extracted to services/

async function resolveUserEmailFromGoogleToken(token) {
    const { validateTokenFormat } = require("./utils");
    if (!validateTokenFormat(token)) {
        throw new Error("INVALID_TOKEN_FORMAT");
    }

    const { google } = require("googleapis");
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: token });
    const oauth2 = google.oauth2({ version: 'v2', auth });
    const userInfo = await oauth2.userinfo.get();
    const email = userInfo?.data?.email;

    if (!email) {
        throw new Error("TOKEN_USER_LOOKUP_FAILED");
    }
    return email.toLowerCase();
}

// Gamification Helper exports
async function initializeGamificationProfile(userRef, userData) {
    let needsUpdate = false;
    const defaults = {
        tier: 'free',
        tierCredits: 15,
        boosterCredits: 0,
        currentStreak: 0,
        highestStreak: 0,
        streakFreezes: 0,
        dailySyncCount: 0,
        lastSyncDate: null,
        subscriptionRenewalDate: null
    };

    const updateObj = {};
    for (const [key, val] of Object.entries(defaults)) {
        if (userData[key] === undefined) {
            updateObj[key] = val;
            userData[key] = val;
            needsUpdate = true;
        }
    }

    if (needsUpdate) {
        await userRef.set(updateObj, { merge: true });
    }
    return userData;
}

function checkFeaturesAndCredits(userData, numImages, mode) {
    const tier = userData.tier || 'free';
    if (tier === 'free') {
        if (numImages > 1) return { allowed: false, error: "Free tier is limited to 1 page per sync. Upgrade to Standard/Pro for multi-page batch processing 🚀", code: 403 };
    } else if (tier === 'standard') {
        if (mode === 'journal' && numImages > 3) return { allowed: false, error: "Standard tier is limited to 3 pages per Journal sync. Upgrade to Pro for 5 pages 🚀", code: 403 };
        if ((mode === 'morning' || mode === 'evening') && numImages > 1) return { allowed: false, error: "Standard tier is limited to 1 page per Morning/Evening sync. Upgrade to Pro for 5 pages 🚀", code: 403 };
    } else if (tier === 'pro') {
        if (numImages > 5) return { allowed: false, error: "Pro tier is limited to 5 pages per sync.", code: 403 };
    }

    const hasBYOK = !!userData.geminiKey || !!(userData.byokConfig && userData.byokConfig.apiKey); 
    let tierCredits = userData.tierCredits || 0;
    let boosterCredits = userData.boosterCredits || 0;

    if (!hasBYOK) {
        if (tierCredits + boosterCredits < numImages) {
            return { allowed: false, error: `Insufficient credits. Need ${numImages}, but have ${tierCredits + boosterCredits}. Please buy Booster Credits or Upgrade!`, code: 402 };
        }
    }
    return { allowed: true };
}

async function applyGamificationMilestones(userRef) {
    try {
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

            const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
            let diffDays = 0;

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

                if (diffDays === 0) {
                    dailySyncCount += 1;
                } else if (diffDays === 1) {
                    currentStreak += 1;
                    dailySyncCount = 1;
                } else {
                    let daysMissed = diffDays - 1;
                    if (streakFreezes >= daysMissed) {
                        streakFreezes -= daysMissed;
                        currentStreak += 1; 
                    } else {
                        currentStreak = 1;
                    }
                    dailySyncCount = 1;
                }
            }

            if (currentStreak > highestStreak) highestStreak = currentStreak;

            let milestoneMsg = null;
            if (diffDays > 0 && currentStreak > 0 && currentStreak % 5 === 0) {
                const fiveDaysAgo = new Date();
                fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
                
                const historySnap = await userRef.collection('syncHistory')
                    .where('timestamp', '>=', fiveDaysAgo)
                    .get();
                
                const dailyCountsMap = {};
                dailyCountsMap[todayStr] = dailySyncCount;
                
                historySnap.forEach(doc => {
                    const data = doc.data();
                    if (data.timestamp && data.status === 'success') {
                        const dateStr = data.timestamp.toDate().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
                        if (dateStr !== todayStr) { 
                            dailyCountsMap[dateStr] = (dailyCountsMap[dateStr] || 0) + 1;
                        }
                    }
                });

                const counts = [];
                const todayParts = todayStr.split('-').map(Number);
                for (let i = 0; i < 5; i++) {
                    const d = new Date(todayParts[0], todayParts[1]-1, todayParts[2]);
                    d.setDate(d.getDate() - i);
                    const dStr = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
                    counts.push(dailyCountsMap[dStr] || 0);
                }
                
                const minDaily = Math.min(...counts);

                if (minDaily >= 3) {
                    milestoneMsg = `🎉 Amazing! ${currentStreak}-Day Streak (Min 3/day). Awarded Badge + 2 Freezes + 10 Booster Credits!`;
                    streakFreezes += 2;
                    boosterCredits += 10;
                } else if (minDaily >= 2) {
                    milestoneMsg = `🔥 Great Job! ${currentStreak}-Day Streak (Min 2/day). Awarded Badge + 1 Freeze!`;
                    streakFreezes += 1;
                } else if (minDaily >= 1) {
                    milestoneMsg = `🌟 Good Job! ${currentStreak}-Day Streak! Awarded Digital Badge!`;
                } else {
                     milestoneMsg = `❄️ ${currentStreak}-Day Streak sustained using a Freeze!`;
                }
            }

            const updates = {
                boosterCredits,
                currentStreak,
                highestStreak,
                streakFreezes,
                dailySyncCount,
                lastSyncDate: todayStr
            };

            t.set(userRef, updates, { merge: true });
            return milestoneMsg;
        });
    } catch (err) {
        console.warn("Best-effort gamification milestone calculation failed:", err);
        return null;
    }
}

// --- SETUP ENDPOINT: setupNotion ---
exports.setupNotion = onRequest({ cors: false, memory: "256MiB", secrets: [NOTION_ENCRYPTION_KEY, NOTION_ENCRYPTION_KEY_V2] }, async (req, res) => {
    setStandardHeaders(res);
    if (handleOptions(req, res)) return;
    if (!applyCors(req, res)) return res.status(403).send({ error: "Origin not allowed" });

    if (req.method !== 'POST') {
        return res.status(405).send({ error: "Method not allowed" });
    }
    if (!isJsonRequest(req)) {
        return res.status(415).send({ error: "Content-Type must be application/json" });
    }

    const body = req.body || {};
    const token = body.token;
    const notionKey = typeof body.notionKey === 'string' ? body.notionKey.trim() : '';
    const notionDbId = normalizeNotionDbId(body.notionDbId);

    if (!token || !isLikelyNotionKey(notionKey) || !notionDbId) {
        return res.status(400).send({ error: "Invalid setup payload" });
    }

    try {
        const userEmail = await resolveUserEmailFromGoogleToken(token);

        const rl = await checkRateLimit(userEmail, 'setupNotion', RATE_LIMIT_DEFAULT);
        if (!rl.allowed) {
            res.set('Retry-After', String(Math.ceil(rl.retryAfterMs / 1000)));
            return res.status(429).send({ error: "Too many requests. Please try again later." });
        }

        const encryptedKey = encrypt(notionKey);
        const db = admin.firestore();
        const userRef = db.collection('users').doc(userEmail);
        await userRef.set({ notionKey: encryptedKey, notionDbId }, { merge: true });

        console.log(`Stored encrypted Notion settings for ${userEmail}`);
        return res.status(200).send({ success: true, text: "Notion setup saved securely." });
    } catch (err) {
        logger.error("Setup error:", err);
        return res.status(500).send({ error: "Failed to securely save keys." });
    }
});

// --- GDPR: Export User Data ---
exports.exportUserData = onRequest({ cors: false, memory: "256MiB" }, async (req, res) => {
    setStandardHeaders(res);
    if (handleOptions(req, res)) return;
    if (!applyCors(req, res)) return res.status(403).send({ error: "Origin not allowed" });

    if (req.method !== 'POST') {
        return res.status(405).send({ error: "Method not allowed" });
    }
    if (!isJsonRequest(req)) {
        return res.status(415).send({ error: "Content-Type must be application/json" });
    }

    const body = req.body || {};
    const token = body.token;
    if (!token) return res.status(400).send({ error: "Missing token" });

    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        const userEmail = decodedToken.email?.toLowerCase();
        if (!userEmail) return res.status(401).send({ error: "No email in token" });

        const rl = await checkRateLimit(userEmail, 'exportUserData', RATE_LIMIT_DEFAULT);
        if (!rl.allowed) {
            res.set('Retry-After', String(Math.ceil(rl.retryAfterMs / 1000)));
            return res.status(429).send({ error: "Too many requests. Please try again later." });
        }
        const db = admin.firestore();
        const userRef = db.collection('users').doc(userEmail);
        const snap = await userRef.get();

        const exportData = {
            exportedAt: new Date().toISOString(),
            email: userEmail,
            accountExists: snap.exists,
            data: {}
        };

        if (snap.exists) {
            const raw = snap.data();
            exportData.data = {
                notionConfigured: !!raw.notionKey,
                notionDbId: raw.notionDbId || null
                // Note: Encrypted key intentionally excluded for security
            };
        }

        console.log(`Data export for ${userEmail}`);
        return res.status(200).send(exportData);
    } catch (err) {
        console.error("Export error:", err.message);
        return res.status(500).send({ error: "Failed to export data." });
    }
});

// --- GDPR: Delete User Account ---
exports.deleteUserAccount = onRequest({ cors: false, memory: "256MiB" }, async (req, res) => {
    setStandardHeaders(res);
    if (handleOptions(req, res)) return;
    if (!applyCors(req, res)) return res.status(403).send({ error: "Origin not allowed" });

    if (req.method !== 'POST') {
        return res.status(405).send({ error: "Method not allowed" });
    }
    if (!isJsonRequest(req)) {
        return res.status(415).send({ error: "Content-Type must be application/json" });
    }

    const body = req.body || {};
    const token = body.token;
    if (!token) return res.status(400).send({ error: "Missing token" });

    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        const userEmail = decodedToken.email?.toLowerCase();
        if (!userEmail) return res.status(401).send({ error: "No email in token" });

        const rl = await checkRateLimit(userEmail, 'deleteUserAccount', RATE_LIMIT_DEFAULT);
        if (!rl.allowed) {
            res.set('Retry-After', String(Math.ceil(rl.retryAfterMs / 1000)));
            return res.status(429).send({ error: "Too many requests. Please try again later." });
        }

        const db = admin.firestore();
        const userRef = db.collection('users').doc(userEmail);
        await userRef.delete();

        console.log(`Account deleted for ${userEmail}`);
        return res.status(200).send({ success: true, text: "Your account data has been permanently deleted." });
    } catch (err) {
        console.error("Delete error:", err.message);
        return res.status(500).send({ error: "Failed to delete account." });
    }
});

// --- MAIN ENDPOINT: syncPlanner ---
// Handles the image upload from the frontend, uses Gemini to parse, and syncs
exports.syncPlanner = onRequest({ cors: false, memory: "1GiB", timeoutSeconds: 300, secrets: [NOTION_ENCRYPTION_KEY, NOTION_ENCRYPTION_KEY_V2, GEMINI_API_KEY] }, async (req, res) => {
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

    const body = req.body || {};

    // Validation: enforce body limit via header rather than heavy stringify
    const MAX_BODY_SIZE = 100_000_000;
    if (req.rawBody && req.rawBody.length > MAX_BODY_SIZE) {
        const durationMs = Date.now() - startTimeMs;
        logger.warn("Payload size validation failed", { requestId, durationMs, size: req.rawBody.length, status: 413 });
        return res.status(413).send({ error: "Payload too large. Max 100MB allowed." });
    }

    const token = body.token;
    if (!token) {
        const durationMs = Date.now() - startTimeMs;
        logger.warn("Missing auth token", { requestId, durationMs, status: 401 });
        return res.status(401).send({ error: "Unauthorized" });
    }

    let email = null; // Declare email here for broader scope
    let mode = null;
    let parsedImages = [];

    try {
        email = await resolveUserEmailFromGoogleToken(token);
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
        if (!parsedImages || parsedImages.length === 0) {
            const durationMs = Date.now() - startTimeMs;
            logger.warn("Invalid image data", { requestId, authEmail: email, syncMode: mode, durationMs, status: 400 });
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
        const auth = new google.auth.OAuth2();
        auth.setCredentials({ access_token: token });

        // Load & Initialize User Config from Firestore
        const db = admin.firestore();
        const userRef = db.collection('users').doc(email);
        const userDoc = await userRef.get();
        let rawUserData = userDoc.exists ? userDoc.data() : {};
        
        // --- GAMIFICATION: Transactional Feature Guarding & Credit Check ---
        let userData;
        try {
            userData = await db.runTransaction(async (t) => {
                const docSnap = await t.get(userRef);
                let rawData = docSnap.exists ? docSnap.data() : {};
                
                // Emulate initializeGamificationProfile
                const defaults = {
                    tier: 'free', tierCredits: 15, boosterCredits: 0,
                    currentStreak: 0, highestStreak: 0, streakFreezes: 0,
                    dailySyncCount: 0, lastSyncDate: null, subscriptionRenewalDate: null
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

                const check = checkFeaturesAndCredits(rawData, parsedImages.length, mode);
                if (!check.allowed) {
                    throw new Error(JSON.stringify({ code: check.code, error: check.error }));
                }

                // Deduct credits to prevent concurrent overspending
                const hasBYOK = !!rawData.geminiKey || !!(rawData.byokConfig && rawData.byokConfig.apiKey); 
                if (!hasBYOK) {
                    let tierCredits = rawData.tierCredits;
                    let boosterCredits = rawData.boosterCredits;
                    let creditsToDeduct = parsedImages.length;
                    
                    if (tierCredits >= creditsToDeduct) {
                        tierCredits -= creditsToDeduct;
                    } else {
                        creditsToDeduct -= tierCredits;
                        tierCredits = 0;
                        boosterCredits -= creditsToDeduct;
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

        // Initialize Services
        const calendar = google.calendar({ version: 'v3', auth });
        const tasks = google.tasks({ version: 'v1', auth });
        const sheets = google.sheets({ version: 'v4', auth });

        // --- 1. HANDLE JOURNAL SYNC SEPARATELY ---
        let msg = "";
        if (mode === 'journal') {
            if (!userData.notionKey || !userData.notionDbId) {
                const durationMs = Date.now() - startTimeMs;
                logger.warn("Notion not setup for journal sync", { requestId, authEmail: email, syncMode: mode, durationMs, status: 400 });
                return res.status(400).send({ error: "Notion not setup. Please provide keys." });
            }

            // Create Notion Client (Lazy Load)
            const { Client } = require("@notionhq/client");
            const decryptedNotionKey = await getDecryptedNotionKeyAndMigrate(userRef, userData);
            if (!decryptedNotionKey) {
                const durationMs = Date.now() - startTimeMs;
                logger.error("Failed to decrypt Notion key for journal sync", { requestId, authEmail: email, syncMode: mode, durationMs, status: 401 });
                return res.status(401).send({ error: "Invalid or corrupt Notion settings. Please re-setup Notion." });
            }
            const notion = new Client({ auth: decryptedNotionKey });

            // PARALLEL EXECUTION: Upload Limitless Image(s) to Notion Directly (Zero Storage) & Extract Date
            logger.info("Starting parallel Journal processing (Zero Storage)...", { requestId, authEmail: email, syncMode: mode });

            const journalUploadPromises = parsedImages.map(img =>
                uploadFileToNotion(decryptedNotionKey, Buffer.from(img.base64Data, 'base64'), img.mimeType)
            );

            const [fileUploadIds, extraction] = await Promise.all([
                Promise.all(journalUploadPromises),
                getPlannerDataFromImages(parsedImages, 'journal_date_only').catch(err => {
                    logger.warn("Date extraction failed for journal:", { requestId, authEmail: email, syncMode: mode, error: err.message });
                    return { date: null };
                })
            ]);

            let journalDate = new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata' });
            if (extraction && extraction.date) {
                journalDate = extraction.date;
                logger.info(`Extracted Journal Date: ${journalDate}`, { requestId, authEmail: email, syncMode: mode, journalDate });
            }

            // Create Notion Page with File Attachments
            const dbId = userData.notionDbId;
            const childrenBlocks = fileUploadIds.map(id => ({
                object: 'block',
                type: 'image',
                image: {
                    type: 'file_upload',
                    file_upload: { id: id }
                }
            }));

            await notion.pages.create({
                parent: { database_id: dbId },
                properties: {
                    "Name": { title: [{ text: { content: `Journal - ${journalDate}` } }] }
                },
                children: childrenBlocks
            });
            msg = `Journal synced to Notion! Date: ${journalDate}`;
            const milestoneMsg = await applyGamificationMilestones(userRef);
            if (milestoneMsg) msg += `\n${milestoneMsg}`;
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
            return res.status(200).send({ text: msg });
        }

        // --- BRANCH 2: MORNING/EVENING PLANNER ---
        let plannerData;

        if (mode === 'morning') {
            console.log(`Parsing planner images for morning sync...`);
            plannerData = await getPlannerDataFromImages(parsedImages, 'morning', userData);

            if (plannerData.error) {
                await logSyncHistory(userRef, mode, parsedImages.length, 'error', plannerData.error);
                return res.status(400).send({ error: plannerData.error });
            }

            console.log("Starting parallel Morning sync...");

            // Parallel: Add Events to Calendar AND Add Tasks to Google Tasks.
            const [eventResults, taskCount] = await Promise.all([
                syncCalendarEvents(calendar, plannerData),
                syncGoogleTasks(tasks, plannerData)
            ]);

            msg = `Morning Sync Complete! Created ${eventResults.events} events, ${eventResults.reminders} reminders, and ${taskCount} tasks.`;
            console.log(msg);

            const milestoneMsg = await applyGamificationMilestones(userRef);
            if (milestoneMsg) msg += `\n${milestoneMsg}`;

            await logSyncHistory(userRef, mode, parsedImages.length, 'success', msg);
            await incrementUsageCounters(userRef, parsedImages.length);
            return res.status(200).send({ text: msg });

        } else if (mode === 'evening') {
            // Re-scan images specifically looking for evening data (expenses, mood, etc).
            console.log(`Parsing planner images for evening sync...`);
            plannerData = await getPlannerDataFromImages(parsedImages, 'evening', userData);
            if (plannerData.error) {
                await logSyncHistory(userRef, mode, parsedImages.length, 'error', plannerData.error);
                return res.status(400).send({ error: plannerData.error });
            }

            let successMessages = [];

            // 1. Mark tasks as completed in Google Tasks based on checkmarks in image.
            const updatedTasks = await updateCompletedTasks(tasks, plannerData);
            if (updatedTasks > 0) successMessages.push(`Marked ${updatedTasks} tasks completed.`);

            // ---- AUTO-CREATE SPREADSHEET IF MISSING ----
            let spreadsheetId = userData.spreadsheetId;
            if (!spreadsheetId) {
                console.log("No spreadsheet found. Creating new one...");
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
            console.log("Starting parallel Evening sync...");

            const promises = [
                syncExpensesToSheet(sheets, plannerData, spreadsheetId),
                syncHealthToSheet(sheets, plannerData, spreadsheetId)
            ];

            // Handle Notion Branch
            if (userData.notionKey && userData.notionDbId) {
                const decryptedNotionKey = await getDecryptedNotionKeyAndMigrate(userRef, userData);

                if (decryptedNotionKey) {
                    const brainDumpPromise = async () => {
                        try {
                            if (!plannerData.brainDump) return false;
                            console.log("Starting parallel Brain Dump to Notion (Zero Storage)...");
                            let fileId = null;
                            const firstImage = parsedImages[0];
                            if (firstImage && firstImage.base64Data) {
                                const buffer = Buffer.from(firstImage.base64Data, 'base64');
                                fileId = await uploadFileToNotion(decryptedNotionKey, buffer, firstImage.mimeType);
                            }
                            return syncBrainDumpToNotion(plannerData, decryptedNotionKey, userData.notionDbId, fileId);
                        } catch (err) {
                            console.error("Notion sync failed:", err.message);
                            return false;
                        }
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
                console.error(`${name} Sync Failed:`, result.reason?.message || result.reason);
                return (name === 'Notion') ? false : 0;
            };

            const addedExpenses = getResult(results[0], 'Expenses');
            const addedHealth = getResult(results[1], 'Health');
            const notionSynced = results.length > 2 ? getResult(results[2], 'Notion') : false;

            if (addedExpenses > 0) successMessages.push(`Added ${addedExpenses} expenses to Sheet.`);
            if (addedHealth > 0) successMessages.push(`Logged Health & Wellness.`);
            if (notionSynced) successMessages.push(`Saved Visual Brain Dump to Notion.`);

            if (successMessages.length === 0) msg = "Night Sync output: No items found to sync.";
            else msg = "Night Sync Complete: " + successMessages.join(" ");

            const milestoneMsg = await applyGamificationMilestones(userRef);
            if (milestoneMsg) msg += `\n${milestoneMsg}`;

            await logSyncHistory(userRef, mode, parsedImages.length, 'success', msg);
            await incrementUsageCounters(userRef, parsedImages.length);
        } else {
            await logSyncHistory(userRef, mode, parsedImages.length, 'error', `Invalid syncType: ${mode}`);
            return res.status(400).send({ error: `Invalid syncType: ${mode}` });
        }

        console.log(msg);
        res.status(200).send({ text: msg });

    } catch (error) {
        const errMsg = error?.message || String(error || "Unknown error");
        console.error("FATAL ERROR:", errMsg);

        // Try to log the failure if we have user context
        try {
            const body = req.body || {};
            const token = body.token;
            if (token) {
                const userEmail = await resolveUserEmailFromGoogleToken(token);
                if (userEmail) {
                    const db = admin.firestore();
                    const userRef = db.collection('users').doc(userEmail);
                    const mode = sanitizeSyncType(body.syncType);
                    const images = body.images || (body.imageData ? [body.imageData] : []);
                    await logSyncHistory(userRef, mode, images.length || 1, 'error', "Internal error occurred during sync.");
                }
            }
        } catch (logErr) {
            console.error("Failed to log error history:", logErr);
        }

        // Security: Don't leak internals to client
        const safeMessage = errMsg.includes("RATE_LIMIT") ? "AI Service Busy. Please try again." : "Internal Server Error";
        res.status(500).send({ error: safeMessage });
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
exports.logClientError = onRequest({ cors: false, memory: "128MiB" }, async (req, res) => {
    setStandardHeaders(res);
    if (handleOptions(req, res)) return;
    if (!applyCors(req, res)) return res.status(403).send({ error: "Origin not allowed" });

    if (req.method !== 'POST') {
        return res.status(405).send({ error: "Method not allowed" });
    }
    if (!isJsonRequest(req)) {
        return res.status(415).send({ error: "Content-Type must be application/json" });
    }

    const { message, stack, url, line, column, userEmail } = req.body || {};

    // Construct a rich error string for GCP
    const errorBody = [
        `Frontend Error: ${message || 'Unknown Error'}`,
        `User: ${userEmail || 'Anonymous'}`,
        `URL: ${url || 'Unknown URL'}${(line && column) ? `:${line}:${column}` : ''}`,
        `\nStack Trace:\n${stack || 'No stack trace provided'}`
    ].join('\n');

    // Passing an Error object triggers native GCP Error Reporting aggregation
    logger.error("Client caught unhandled exception", new Error(errorBody));

    return res.status(200).send({ success: true });
});


// Gemini prompts have been extracted to services/gemini.js

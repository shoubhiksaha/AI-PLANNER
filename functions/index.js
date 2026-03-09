const { onRequest } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/logger");
const admin = require("firebase-admin");
// Imports moved inside function for Cold Start optimization
// const fetch = require("node-fetch"); // Removed: Using Native Node 20 fetch
// const { GoogleGenerativeAI } = require("@google/generative-ai"); // MOVED
// const { google } = require("googleapis"); // MOVED
// const { Client } = require("@notionhq/client"); // MOVED

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

// Helper: Get derived keys for rotation
// New key (V2) is preferred; falls back to V1 if V2 is not set
function getCryptoKeyNew() {
    const v2 = NOTION_ENCRYPTION_KEY_V2.value();
    if (v2) return deriveKey(v2);
    return deriveKey(NOTION_ENCRYPTION_KEY.value());
}

function getCryptoKeyOld() {
    return deriveKey(NOTION_ENCRYPTION_KEY.value());
}

// Wrappers that inject the secret key — always encrypt with newest key
function encrypt(text) {
    if (!text) return text;
    return _encryptWithKey(text, getCryptoKeyNew());
}

// Decrypt: try new key first, then old key (for rotation compatibility)
function decryptStoredNotionKey(text) {
    if (!text) return text;

    // 1. Try new key (V2 or current)
    try {
        if (text.startsWith('v2:')) {
            const val = _decryptGcmWithKey(text, getCryptoKeyNew());
            if (val) return { value: val, needsMigration: false };
        }
    } catch (e) { /* fall through to old key */ }

    // 2. Try old key (V1) — if V2 exists, this means key rotation happened
    try {
        const oldKey = getCryptoKeyOld();
        if (text.startsWith('v2:')) {
            const val = _decryptGcmWithKey(text, oldKey);
            return { value: val, needsMigration: !!val };
        }
        if (text.includes(':')) {
            const val = _decryptCbcWithKey(text, oldKey);
            return { value: val, needsMigration: !!val };
        }
        // Plaintext leftover
        return { value: text, needsMigration: true };
    } catch (e) {
        logger.error("Decryption failed for stored Notion key.", e);
        return { value: null, needsMigration: false };
    }
}

async function resolveUserEmailFromGoogleToken(token) {
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

async function getDecryptedNotionKeyAndMigrate(userRef, userData) {
    if (!userData?.notionKey) {
        return null;
    }

    const { value, needsMigration } = decryptStoredNotionKey(userData.notionKey);
    if (!value) {
        return null;
    }

    if (needsMigration) {
        await userRef.set({ notionKey: encrypt(value) }, { merge: true });
    }

    return value;
}

// --- RATE LIMITING (Firestore-backed) ---
async function checkRateLimit(email, endpoint, limit) {
    const db = admin.firestore();
    const docId = `${email}_${endpoint}`;
    const ref = db.collection('rateLimits').doc(docId);
    const now = Date.now();

    const doc = await ref.get();
    if (doc.exists) {
        const data = doc.data();
        const windowStart = data.windowStart || 0;
        const count = data.count || 0;

        if (now - windowStart < RATE_LIMIT_WINDOW_MS) {
            if (count >= limit) {
                const retryAfterMs = RATE_LIMIT_WINDOW_MS - (now - windowStart);
                return { allowed: false, retryAfterMs };
            }
            await ref.set({ count: count + 1, windowStart }, { merge: true });
            return { allowed: true };
        }
    }

    // New window
    await ref.set({ count: 1, windowStart: now });
    return { allowed: true };
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

// --- MAIN FUNCTION: syncPlanner ---
exports.syncPlanner = onRequest({ cors: false, memory: "1GiB", timeoutSeconds: 300, secrets: [NOTION_ENCRYPTION_KEY, NOTION_ENCRYPTION_KEY_V2] }, async (req, res) => {
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

    // Body size guard: reject payloads over 100MB to prevent OOM
    const MAX_BODY_SIZE = 100_000_000;
    if (JSON.stringify(body).length > MAX_BODY_SIZE) {
        return res.status(413).send({ error: "Payload too large" });
    }

    const token = body.token;
    const mode = sanitizeSyncType(body.syncType);

    // Support backward compatibility for a single image, but standardize on array
    const rawImages = body.images || (body.imageData ? [body.imageData] : []);
    const parsedImages = parseImageDataArray(rawImages);

    if (!token) return res.status(401).send({ error: "Missing Google OAuth Token" });
    if (!ALLOWED_SYNC_TYPES.has(mode)) return res.status(400).send({ error: "Invalid syncType" });
    if (!parsedImages || parsedImages.length === 0) return res.status(400).send({ error: "Invalid image data format, size, or too many images (max 5)." });

    try {
        const userEmail = await resolveUserEmailFromGoogleToken(token);
        console.log(`User: ${userEmail}, Sync: ${mode}`);

        const rl = await checkRateLimit(userEmail, 'syncPlanner', RATE_LIMIT_SYNC);
        if (!rl.allowed) {
            res.set('Retry-After', String(Math.ceil(rl.retryAfterMs / 1000)));
            return res.status(429).send({ error: "Too many requests. Please try again later." });
        }

        const { google } = require("googleapis"); // Lazy Load
        const auth = new google.auth.OAuth2();
        auth.setCredentials({ access_token: token });

        // Load User Config from Firestore (This is where Notion Keys are securely stored)
        const db = admin.firestore();
        const userRef = db.collection('users').doc(userEmail);
        const userDoc = await userRef.get();
        let userData = userDoc.exists ? userDoc.data() : {};

        // Initialize Services
        const calendar = google.calendar({ version: 'v3', auth });
        const tasks = google.tasks({ version: 'v1', auth });
        const sheets = google.sheets({ version: 'v4', auth });

        // --- 1. HANDLE JOURNAL SYNC SEPARATELY ---
        let msg = "";
        if (mode === 'journal') {
            if (!userData.notionKey || !userData.notionDbId) {
                return res.status(400).send({ error: "Notion not setup. Please provide keys." });
            }

            // Create Notion Client (Lazy Load)
            const { Client } = require("@notionhq/client");
            const decryptedNotionKey = await getDecryptedNotionKeyAndMigrate(userRef, userData);
            if (!decryptedNotionKey) return res.status(401).send({ error: "Invalid or corrupt Notion settings. Please re-setup Notion." });
            const notion = new Client({ auth: decryptedNotionKey });

            // PARALLEL EXECUTION: Upload Limitless Image(s) to Notion Directly (Zero Storage) & Extract Date
            console.log("Starting parallel Journal processing (Zero Storage)...");

            const journalUploadPromises = parsedImages.map(img =>
                uploadFileToNotion(decryptedNotionKey, Buffer.from(img.base64Data, 'base64'), img.mimeType)
            );

            const [fileUploadIds, extraction] = await Promise.all([
                Promise.all(journalUploadPromises),
                getPlannerDataFromImages(parsedImages, 'journal_date_only').catch(err => {
                    console.warn("Date extraction failed:", err.message);
                    return { date: null };
                })
            ]);

            let journalDate = new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata' });
            if (extraction && extraction.date) {
                journalDate = extraction.date;
                console.log(`Extracted Journal Date: ${journalDate}`);
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
            await logSyncHistory(userRef, mode, parsedImages.length, 'success', msg);
            await incrementUsageCounters(userRef, parsedImages.length);
            return res.status(200).send({ text: msg });
        }

        // --- BRANCH 2: MORNING/EVENING PLANNER ---
        let plannerData;

        if (mode === 'morning') {
            console.log(`Parsing planner images for morning sync...`);
            plannerData = await getPlannerDataFromImages(parsedImages, 'morning');

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

            await logSyncHistory(userRef, mode, parsedImages.length, 'success', msg);
            await incrementUsageCounters(userRef, parsedImages.length);
            return res.status(200).send({ text: msg });

        } else if (mode === 'evening') {
            // Re-scan images specifically looking for evening data (expenses, mood, etc).
            console.log(`Parsing planner images for evening sync...`);
            plannerData = await getPlannerDataFromImages(parsedImages, 'evening');
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

// Helper to upload file to Notion (Direct Upload - Corrected 2-Step Flow)
async function uploadFileToNotion(apiKey, fileBuffer, mimeType) {
    try {
        console.log("Step 1: Init Notion Upload...");
        // Step 1: Create File Upload Object
        const createRes = await fetch("https://api.notion.com/v1/file_uploads", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "Notion-Version": "2022-06-28"
            },
            body: JSON.stringify({
                filename: "journal.jpg",
                content_type: mimeType
            })
        });

        if (!createRes.ok) throw new Error(`Notion Init Upload Failed: ${await createRes.text()}`);
        const uploadObj = await createRes.json();
        const { id, upload_url } = uploadObj;

        console.log(`Step 1 Success. ID: ${id}. Step 2: Uploading Binary...`);

        // Step 2: Upload File Content to the returned URL
        const form = new FormData();
        const blob = new Blob([fileBuffer], { type: mimeType });
        form.append("file", blob, "journal.jpg");

        const uploadRes = await fetch(upload_url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Notion-Version": "2022-06-28"
            },
            body: form
        });

        if (!uploadRes.ok) throw new Error(`Notion Binary Upload Failed: ${await uploadRes.text()}`);

        console.log(`Notion File Uploaded Successfully: ${id}`);
        return id;
    } catch (e) {
        logger.error("Notion Direct Upload Error:", e);
        throw e;
    }
}

// Helper to fetch with timeout
async function fetchWithTimeout(url, options, timeout = 60000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        throw error;
    }
}

// Helper to call Gemini with a specific model
async function callGeminiModel(model, apiKey, prompt, imagesArr) {
    console.log(`Attempting Gemini model: ${model}...`);
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const parts = imagesArr.map(img => ({ inlineData: { mimeType: img.mimeType, data: img.base64Data } }));
    parts.push({ text: prompt });

    const payload = {
        contents: [{ parts }],
        generationConfig: { responseMimeType: "application/json" }
    };

    let attempt = 0;
    const maxRetries = 5;

    while (attempt <= maxRetries) {
        try {
            const response = await fetchWithTimeout(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }, 120000); // 120s timeout per attempt (Increased for reliability)

            if (!response.ok) {
                if (response.status === 429) {
                    attempt++;
                    if (attempt <= maxRetries) {
                        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500; // Exponential backoff + jitter
                        console.warn(`Rate limit (429) for ${model}. Retrying in ${delay.toFixed(0)}ms (Attempt ${attempt}/${maxRetries})...`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                        continue;
                    }
                    throw new Error("RATE_LIMIT_EXHAUSTED");
                }
                if (response.status >= 500) throw new Error("SERVER_ERROR");
                const body = await response.text();
                throw new Error(`API_ERROR_${response.status}: ${body}`);
            }

            const result = await response.json();
            if (!result.candidates || !result.candidates[0].content.parts[0].text) {
                throw new Error("INVALID_RESPONSE");
            }
            return JSON.parse(result.candidates[0].content.parts[0].text);

        } catch (error) {
            const errMsg = error?.message || String(error || "Unknown error");
            // Keep retrying if it's a 429 loop, otherwise throw to switch models
            if (attempt > 0 && attempt <= maxRetries && errMsg.includes("RATE_LIMIT")) throw error;

            console.warn(`Model ${model} failed: ${errMsg}`);
            throw error;
        }
    }
}


async function getPlannerDataFromImages(parsedImages, syncType) {
    if (!parsedImages || parsedImages.length === 0) {
        throw new Error("INVALID_IMAGE_PAYLOAD");
    }
    const geminiApiKey = GEMINI_API_KEY.value();

    if (!geminiApiKey) {
        throw new Error("MISSING_GEMINI_API_KEY");
    }

    // Choose prompt based on sync type
    // Choose prompt based on sync type
    const prompt =
        syncType === 'evening' ? getEveningPrompt() :
            syncType === 'journal_date_only' ? getJournalDatePrompt() :
                getMorningPrompt();

    // Fallback Strategy: Diverse models to avoid shared quota limits
    const models = [
        "gemini-2.5-flash-lite", // "Ultra Fast" & Stable (Best for timeouts)
        "gemini-2.5-flash",      // Balanced & Stable
        "gemini-2.0-flash-lite", // Previous gen fast model
        "gemini-flash-latest"    // Fallback
    ];

    let lastError = null;

    for (const model of models) {
        try {
            return await callGeminiModel(model, geminiApiKey, prompt, parsedImages);
        } catch (error) {
            lastError = error;
            // Continue to next model if available
            if (models.indexOf(model) < models.length - 1) {
                console.log(`Falling back to next model...`);
            }
        }
    }

    throw new Error(`All Gemini models failed. Last error: ${lastError?.message || "Unknown error"}`);
}

async function syncCalendarEvents(calendar, plannerData) {
    let counts = { events: 0, reminders: 0 };
    for (const item of (plannerData.schedule || [])) {
        if ((item.block || item.reminder) && item.task) {
            const startTime = parseDateTime(item.time, plannerData.date);

            // Safety check: Skip if time couldn't be parsed
            if (!startTime) continue;

            // Assume event lasts 1 hour.
            const endTime = new Date(startTime.getTime() + 60 * 60 * 1000);

            // Fix: Use localized time strings for Google Calendar to prevent UTC shift
            // We want "2023-10-25T09:00:00" not "2023-10-25T09:00:00.000Z" (which GCal treats as UTC)
            // The cleanest way is to use the sv-SE locale which follows ISO format but uses local time values
            const toLocalISO = (date) => {
                const offset = date.getTimezoneOffset() * 60000;
                return new Date(date.getTime() - offset).toISOString().slice(0, 19);
            };

            const sTime = toLocalISO(startTime);
            const eTime = toLocalISO(endTime);
            console.log(`Creating Event: "${item.task}" Start: ${sTime} End: ${eTime}`);

            await calendar.events.insert({
                calendarId: 'primary',
                resource: {
                    summary: item.task,
                    start: { dateTime: sTime, timeZone: 'Asia/Kolkata' },
                    end: { dateTime: eTime, timeZone: 'Asia/Kolkata' },
                    reminders: {
                        useDefault: false,
                        overrides: item.reminder ? [{ method: 'popup', minutes: 10 }] : [],
                    },
                },
            });
            if (item.block) counts.events++;
            if (item.reminder) counts.reminders++;
        }
    }
    return counts;
}

async function syncGoogleTasks(tasks, plannerData) {
    let count = 0;
    const dueDate = new Date(plannerData.date);
    dueDate.setHours(23, 59, 59, 999);

    for (const item of (plannerData.todos || [])) {
        if (item.task) {
            await tasks.tasks.insert({
                tasklist: '@default',
                requestBody: {
                    title: item.task,
                    status: item.done ? 'completed' : 'needsAction',
                    due: dueDate.toISOString()
                }
            });
            count++;
        }
    }
    return count;
}

async function updateCompletedTasks(tasks, plannerData) {
    // Get completed tasks from planner
    const completedPlannerTasks = (plannerData.todos || [])
        .filter(todo => todo.done === true)
        .map(todo => todo.task);

    if (completedPlannerTasks.length === 0) return 0;

    // Get active tasks from Google
    const res = await tasks.tasks.list({
        tasklist: '@default',
        showCompleted: false,
    });

    const googleTasks = res.data.items;
    if (!googleTasks || googleTasks.length === 0) return 0;

    let updatedCount = 0;
    for (const plannerTaskTitle of completedPlannerTasks) {
        // Fuzzy match or exact match depending on need, exact for now
        const matchingGoogleTask = googleTasks.find(gTask => gTask.title.trim().toLowerCase() === plannerTaskTitle.trim().toLowerCase());

        if (matchingGoogleTask) {
            console.log(`Marking task completed: "${matchingGoogleTask.title}"`);
            await tasks.tasks.patch({
                tasklist: '@default',
                task: matchingGoogleTask.id,
                requestBody: { status: 'completed' }
            });
            updatedCount++;
        }
    }
    return updatedCount;
}

async function syncExpensesToSheet(sheets, plannerData, spreadsheetId) {
    if (!plannerData.expenses || plannerData.expenses.length === 0) return 0;

    // Format: Date | Item | Amount
    const rows = plannerData.expenses.map(expense => [
        plannerData.date, // Just use the string date for simplicity, or format it
        expense.item,
        expense.amount
    ]);

    // Assuming a sheet named "Expenses"
    const range = 'Expenses!A:C';

    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId: spreadsheetId,
            range: range,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: rows },
        });
        return rows.length;
    } catch (err) {
        logger.error('Failed to sync expenses:', err);
        return 0; // Don't crash the whole sync
    }
}

async function syncHealthToSheet(sheets, plannerData, spreadsheetId) {
    if (!plannerData.health || Object.keys(plannerData.health).length === 0) return 0;

    // Format: Date | Exercise | Water | Sleep | Energy
    const row = [
        plannerData.date,
        plannerData.health.exercise || "",
        plannerData.health.water || 0,
        plannerData.health.sleep || 0,
        plannerData.health.energy || 0
    ];

    // Assuming a sheet named "Health"
    const range = 'Health!A:E';

    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId: spreadsheetId,
            range: range,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [row] },
        });
        return 1;
    } catch (err) {
        logger.error('Failed to sync health:', err);
        return 0;
    }
}

// Simplified Helper: Only supports Direct File Upload IDs (Zero Storage)
async function syncBrainDumpToNotion(plannerData, notionApiKey, databaseId, fileId) {
    if ((!plannerData.brainDump || plannerData.brainDump.trim() === '') && !fileId) return false;

    if (!notionApiKey || notionApiKey.includes("YOUR_")) {
        console.warn("Notion API Key not configured.");
        return false;
    }

    const { Client } = require("@notionhq/client"); // Lazy Load
    const notion = new Client({ auth: notionApiKey });
    const pageTitle = `Brain Dump - ${plannerData.date}`;

    try {
        const children = [];

        // Add Brain Dump Text
        if (plannerData.brainDump) {
            children.push({
                object: 'block',
                type: 'paragraph',
                paragraph: {
                    rich_text: [{ type: 'text', text: { content: plannerData.brainDump } }]
                }
            });
        }

        // Add Visual Reference (Image File Attachment)
        if (fileId) {
            children.push({
                object: 'block',
                type: 'image',
                image: {
                    type: 'file_upload',
                    file_upload: { id: fileId }
                }
            });
        }

        await notion.pages.create({
            parent: { database_id: databaseId },
            properties: {
                "Name": { title: [{ text: { content: pageTitle } }] }
            },
            children: children
        });
        return true;
    } catch (err) {
        logger.error("Notion Sync Error:", err);
        return false;
    }
}

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


// Improved parseDateTime with validation

function getMorningPrompt() {
    return `Analyze the attached image of a daily planner.
            Step 1: Extract all relevant data.
            - Extract the handwritten date as a string (e.g., "6-August-2025").
            - Extract the schedule items with tasks into a "schedule" array. Each object should have "time", "task", "block" (boolean), and "reminder" (boolean). Ignore empty or crossed-out tasks.
            - Extract the to-do list items into a "todos" array. Each object should have "task" (string) and "done" (boolean). Ignore empty lines.
            - Extract the handwritten total for Blocks, the total for Reminders, and the total for To-Dos as numbers.

            Step 2: Verify your work meticulously.
            - Count how many items in your extracted "schedule" have "block": true. Compare this to the handwritten total for Blocks.
            - Count how many items in your extracted "schedule" have "reminder": true. Compare this to the handwritten total for Reminders.
            - Count the total number of items in your extracted "todos" array. Compare this to the handwritten total for To-Dos.

            Step 3: Finalize the output.
            - If ALL THREE of your counts from Step 2 PERFECTLY MATCH the handwritten totals, return a single JSON object with the "date", "schedule", and "todos".
            - If ANY of your counts DO NOT MATCH, you have made a mistake. Re-examine the entire image, correct your extraction, and repeat Step 2. Do this re-check twice.
            - If after two re-checks the counts still do not match, return a JSON object with an "error" key. The value should be a string explaining the specific mismatch, for example: "I counted 7 blocked events, but the planner says 8."

            Do not include any explanatory text. Your final output must only be the clean JSON object.`;
}

function getEveningPrompt() {
    return `Analyze the attached image of a filled-out daily planner (Evening Review).
            Step 1: Extract relevant data.
            - "date": The handwritten date on the page (string).
            - "todos": Look at the To-Dos list. Return an array of objects ({ "task": string, "done": boolean }). Only include tasks that are CLEARLY marked as done (checked off).
            - "expenses": Look at the Expenses section. Return an array of objects ({ "item": string, "amount": number }).
            - "health": Look at the Health/Wellness section. Extract:
                - "exercise": Details of exercise (string).
                - "water": Number of filled water circles (number).
                - "sleep": Hours of sleep (number).
                - "energy": Energy level 1-5 (number).
            - "brainDump": Extract the text from the Brain Dump / Ideas section (string).

            Step 2: Verify.
            - Check the "Total Expenses" sum if written, compared to sum of items.
            - Check the "To-Do" count.

            Step 3: Output.
            - Return a single JSON object with keys: "date", "todos", "expenses", "health", "brainDump".
            - Ensure output is well-formed JSON.
            `;
}

function getJournalDatePrompt() {
    return `Extract the handwritten date from this planner page.
            Return a single JSON object: { "date": "string" }.
            The date string should be formatted clearly (e.g., "15-January-2025").
            If no date is found, return { "date": null }.`;
}

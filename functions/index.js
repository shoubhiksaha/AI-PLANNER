const { onRequest } = require("firebase-functions/v2/https");
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

const cors = require("cors")({ origin: true });

// --- CONFIGURATION ---
const { defineString } = require('firebase-functions/params');
const GEMINI_API_KEY_PARAM = defineString('GEMINI_API_KEY');
const GEMINI_API_KEY = GEMINI_API_KEY_PARAM.value();
// Using default storage bucket from config or fallback (Can be parameterized if needed)
const STORAGE_BUCKET_NAME = "ai-planner-project-467800.firebasestorage.app"; // Kept for now, but can be switched to param

// --- MAIN FUNCTION: syncPlanner ---
exports.syncPlanner = onRequest({ cors: true, memory: "1GiB", timeoutSeconds: 300 }, async (req, res) => {
    // 1. Handle CORS/Options manually if needed (handled by onRequest options usually, but good practice for robustness)
    if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Methods', 'GET, POST');
        res.status(204).send('');
        return;
    }

    // notionKey/notionDbId can be passed from frontend setup
    const { token, imageData, syncType = 'morning', notionKey, notionDbId } = req.body;

    // Alias 'night' to 'evening' logic
    const mode = (syncType === 'night') ? 'evening' : syncType;

    if (!token) return res.status(401).send({ error: "Missing Google OAuth Token" });
    if (!imageData) return res.status(400).send({ error: "Missing Image Data" });

    try {
        // Authenticate Google APIs
        const { google } = require("googleapis"); // Lazy Load
        const auth = new google.auth.OAuth2();
        auth.setCredentials({ access_token: token });

        // Get User Email for Profile Lookup
        const oauth2 = google.oauth2({ version: 'v2', auth });
        const userInfo = await oauth2.userinfo.get();
        const userEmail = userInfo.data.email;
        console.log(`User: ${userEmail}, Sync: ${mode}`);

        // Load User Config from Firestore
        const db = admin.firestore();
        const userRef = db.collection('users').doc(userEmail);
        const userDoc = await userRef.get();
        let userData = userDoc.exists ? userDoc.data() : {};

        // Update Notion Keys if provided (One-time setup logic)
        if (notionKey && notionDbId) {
            await userRef.set({ notionKey, notionDbId }, { merge: true });
            userData.notionKey = notionKey;
            userData.notionDbId = notionDbId;
        }

        // Initialize Services
        const calendar = google.calendar({ version: 'v3', auth });
        const tasks = google.tasks({ version: 'v1', auth });
        const sheets = google.sheets({ version: 'v4', auth });

        // --- 1. HANDLE JOURNAL SYNC SEPARATELY ---
        if (mode === 'journal') {
            if (!userData.notionKey || !userData.notionDbId) {
                return res.status(400).send({ error: "Notion not setup. Please provide keys." });
            }

            // Create Notion Client (Lazy Load)
            const { Client } = require("@notionhq/client");
            const notion = new Client({ auth: userData.notionKey });

            // PARALLEL EXECUTION: Upload Limitless Image to Notion Directly (Zero Storage) & Extract Date
            console.log("Starting parallel Journal processing (Zero Storage)...");

            // Strip Data URL prefix from imageData
            const mimeType = imageData.match(/data:(.*);base64,/)?.[1] || 'image/jpeg';
            const base64Data = imageData.split(',')[1];
            const buffer = Buffer.from(base64Data, 'base64');

            const [fileUploadId, extraction] = await Promise.all([
                uploadFileToNotion(userData.notionKey, buffer, mimeType),
                getPlannerDataFromImage(imageData, 'journal_date_only').catch(err => {
                    console.warn("Date extraction failed:", err.message);
                    return { date: null };
                })
            ]);

            let journalDate = new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata' });
            if (extraction && extraction.date) {
                journalDate = extraction.date;
                console.log(`Extracted Journal Date: ${journalDate}`);
            }

            // Create Notion Page with File Attachment
            const dbId = userData.notionDbId;

            await notion.pages.create({
                parent: { database_id: dbId },
                properties: {
                    "Name": { title: [{ text: { content: `Journal - ${journalDate}` } }] }
                },
                children: [
                    {
                        object: 'block',
                        type: 'image',
                        image: {
                            type: 'file_upload',
                            file_upload: { id: fileUploadId }
                        }
                    }
                ]
            });
            return res.status(200).send({ text: `Journal synced to Notion! Date: ${journalDate}` });
        }

        // PARALLEL EXECUTION: Cal & Tasks
        console.log(`Parsing planner image for ${mode} sync...`);
        const plannerData = await getPlannerDataFromImage(imageData, 'morning');

        // Note: No Storage Upload needed for Gemini (it accepts inline Base64)
        // Zero Storage Architecture: Image exists only in memory for this function.

        if (plannerData.error) {
            return res.status(400).send({ error: plannerData.error });
        }

        let msg = "";

        if (mode === 'morning') {
            // PARALLEL EXECUTION: Calendar and Tasks
            console.log("Starting parallel Morning sync...");
            const [eventResults, taskCount] = await Promise.all([
                syncCalendarEvents(calendar, plannerData),
                syncGoogleTasks(tasks, plannerData)
            ]);

            // Also check for completion
            updateCompletedTasks(tasks, plannerData.todos).catch(e => console.warn("Task completion update failed:", e.message));

            msg = `Morning Sync Complete! Created ${eventResults.events} events, ${eventResults.reminders} reminders, and ${taskCount} tasks.`;

        } else if (mode === 'evening') {

            // Evening sync also needs planner data
            const plannerData = await getPlannerDataFromImage(imageData, 'evening');
            if (plannerData.error) return res.status(400).send({ error: plannerData.error });

            let successMessages = [];

            // 1. UPDATE COMPLETED TASKS
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
                // Upload image to Notion DIRECTLY (Zero Storage)
                const { Client } = require("@notionhq/client");
                const notion = new Client({ auth: userData.notionKey });

                promises.push(
                    (async () => {
                        const mimeType = imageData.match(/data:(.*);base64,/)?.[1] || 'image/jpeg';
                        const base64Data = imageData.split(',')[1];
                        const buffer = Buffer.from(base64Data, 'base64');
                        const fileId = await uploadFileToNotion(userData.notionKey, buffer, mimeType);
                        return syncBrainDumpToNotion(plannerData, userData.notionKey, userData.notionDbId, fileId);
                    })()
                );
            }

            // Await all
            const results = await Promise.all(promises);
            const addedExpenses = results[0];
            const addedHealth = results[1];
            const notionSynced = results.length > 2 ? results[2] : false;

            if (addedExpenses > 0) successMessages.push(`Added ${addedExpenses} expenses to Sheet.`);
            if (addedHealth > 0) successMessages.push(`Logged Health & Wellness.`);
            if (notionSynced) successMessages.push(`Saved Visual Brain Dump to Notion.`);
            if (!userData.notionKey) successMessages.push("(Skipped Notion - Keys missing).");

            if (successMessages.length === 0) msg = "Night Sync output: No items found to sync.";
            else msg = "Night Sync Complete: " + successMessages.join(" ");
        } else {
            return res.status(400).send({ error: `Invalid syncType: ${mode}` });
        }

        console.log(msg);
        res.status(200).send({ text: msg });

    } catch (error) {
        console.error("FATAL ERROR:", error.message);
        console.error("Stack:", error.stack);
        if (error.errors) console.error("Validation Errors:", JSON.stringify(error.errors, null, 2));
        res.status(500).send({ error: error.message });
    }
});

// Helper to upload to Firebase Storage
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
        // Use Native FormData (Node 20+)
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
            // Native fetch automatically sets Content-Type: multipart/form-data; boundary=...
        });

        if (!uploadRes.ok) throw new Error(`Notion Binary Upload Failed: ${await uploadRes.text()}`);

        console.log(`Notion File Uploaded Successfully: ${id}`);
        return id;
    } catch (e) {
        console.error("Notion Direct Upload Error:", e);
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
async function callGeminiModel(model, apiKey, prompt, imageData, mimeType) {
    console.log(`Attempting Gemini model: ${model}...`);
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const payload = {
        contents: [{
            parts: [
                { text: prompt },
                { inlineData: { mimeType, data: imageData } }
            ]
        }],
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
            // Keep retrying if it's a 429 loop, otherwise throw to switch models
            if (attempt > 0 && attempt <= maxRetries && error.message.includes("RATE_LIMIT")) throw error;

            console.warn(`Model ${model} failed: ${error.message}`);
            throw error;
        }
    }
}


async function getPlannerDataFromImage(imageData, syncType) {
    const { GoogleGenerativeAI } = require("@google/generative-ai"); // Lazy Load
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const mimeType = imageData.match(/data:(.*);base64,/)?.[1] || 'image/jpeg';
    const base64ImageData = imageData.split(',')[1];

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
            return await callGeminiModel(model, GEMINI_API_KEY, prompt, base64ImageData, mimeType);
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

            const endTime = new Date(startTime.getTime() + 60 * 60 * 1000);

            const sTime = startTime.toISOString().replace('Z', '');
            const eTime = endTime.toISOString().replace('Z', '');
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
        console.error('Failed to sync expenses:', err.message);
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
        console.error('Failed to sync health:', err.message);
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
        console.error("Notion Sync Error:", err.message);
        return false;
    }
}


function parseDateTime(timeString, dateString) {
    const match = timeString.match(/(\d{1,2})\s*(AM|PM)/i);
    if (!match) return null; // Added safety check
    let hours = parseInt(match[1]);
    if (match[2].toUpperCase() === 'PM' && hours < 12) hours += 12;
    if (match[2].toUpperCase() === 'AM' && hours === 12) hours = 0;
    const d = new Date(dateString);
    d.setHours(hours, 0, 0, 0);
    return d;
}

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
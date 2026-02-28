// --- IMPORTS AND SETUP ---

// 'require' is like Python's 'import'. We are importing the 'onRequest' function 
// from Firebase to create an HTTP endpoint (like a Flask route).
const { onRequest } = require("firebase-functions/v2/https");

// Import the Firebase Admin SDK to interact with Firestore database and Storage.
const admin = require("firebase-admin");

// Initialize the Admin app. This gives us permission to read/write to the database.
// We specify the 'storageBucket' explicitly so we know where to save files.
admin.initializeApp({
    storageBucket: "ai-planner-project-467800.firebasestorage.app"
});

// Import 'cors' middleware. This is crucial for web security.
// { origin: true } means we allow requests from any domain (e.g., your frontend).
const cors = require("cors")({ origin: true });

// --- CONFIGURATION ---

// Import a helper to read Environment Variables securely.
const { defineString } = require('firebase-functions/params');

// Define a reference to the 'GEMINI_API_KEY' secret stored in Firebase.
const GEMINI_API_KEY_PARAM = defineString('GEMINI_API_KEY');

// Actually retrieve the value of that key to use in our code.
const GEMINI_API_KEY = GEMINI_API_KEY_PARAM.value();

// Define the name of the storage bucket (folder in the cloud) where files go.
const STORAGE_BUCKET_NAME = "ai-planner-project-467800.firebasestorage.app";

// --- MAIN FUNCTION: syncPlanner ---

// 'exports.syncPlanner' makes this function available to the cloud.
// 'onRequest' means it triggers via HTTP request.
// We set memory to 1GB and timeout to 300s because AI processing can be heavy/slow.
exports.syncPlanner = onRequest({ cors: true, memory: "1GiB", timeoutSeconds: 300 }, async (req, res) => {

    // 1. Manual CORS handling. 
    // OPTIONS requests are "pre-flight" checks browsers do before sending data.
    // We instantly say "OK" (204) to let the browser know it's safe to proceed.
    if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Origin', '*'); // Allow anyone
        res.set('Access-Control-Allow-Methods', 'GET, POST'); // Allow these methods
        res.status(204).send(''); // Send empty success response
        return; // Stop execution here
    }

    // 2. Destructuring Request Body.
    // In Python: token = req.body['token']
    // This extracts variables directly from the incoming JSON data.
    const { token, imageData, syncType = 'morning', notionKey, notionDbId } = req.body;

    // Normalizing the mode. If frontend sends 'night', we treat it as 'evening'.
    // The '?' and ':' is a ternary operator (like Python's `x if y else z`).
    const mode = (syncType === 'night') ? 'evening' : syncType;

    // 3. Validation Checks.
    // If token or image is missing, stop and send a 400/401 Error code.
    if (!token) return res.status(401).send({ error: "Missing Google OAuth Token" });
    if (!imageData) return res.status(400).send({ error: "Missing Image Data" });

    // Security Check: Checking file size.
    // Base64 encoding adds ~37% size overhead. We want to limit real size to ~20MB.
    if (imageData.length > 20 * 1024 * 1024 * 1.37) {
        return res.status(413).send({ error: "Payload too large. Max 20MB." });
    }

    try {
        // --- AUTHENTICATION ---

        // Lazy Loading: We only import 'googleapis' here, inside the function.
        // Why? It makes the function start faster ("Cold Start" optimization).
        const { google } = require("googleapis");

        // Initialize Google OAuth client.
        const auth = new google.auth.OAuth2();

        // Set the token we received from the frontend. Now we can act AS the user.
        auth.setCredentials({ access_token: token });

        // Get the user's email address using the OAuth token.
        const oauth2 = google.oauth2({ version: 'v2', auth });
        const userInfo = await oauth2.userinfo.get();
        const userEmail = userInfo.data.email;

        // Log to Cloud Logging (visible in Firebase Console).
        console.log(`User: ${userEmail}, Sync: ${mode}`);

        // --- DATABASE LOOKUP ---

        // Connect to Firestore (NoSQL database).
        const db = admin.firestore();

        // Look for a document in the 'users' collection with the user's email.
        const userRef = db.collection('users').doc(userEmail);
        const userDoc = await userRef.get();

        // If user exists, get their data; otherwise start with empty object.
        let userData = userDoc.exists ? userDoc.data() : {};

        // If the request included new Notion keys, save them to the database now.
        // { merge: true } means "update these fields, don't delete the whole doc".
        if (notionKey && notionDbId) {
            await userRef.set({ notionKey, notionDbId }, { merge: true });
            userData.notionKey = notionKey;
            userData.notionDbId = notionDbId;
        }

        // Initialize Google Service Clients (Calendar, Tasks, Sheets).
        const calendar = google.calendar({ version: 'v3', auth });
        const tasks = google.tasks({ version: 'v1', auth });
        const sheets = google.sheets({ version: 'v4', auth });

        // --- BRANCH 1: JOURNAL SYNC ---

        if (mode === 'journal') {
            // Check if user has Notion keys saved.
            if (!userData.notionKey || !userData.notionDbId) {
                return res.status(400).send({ error: "Notion not setup. Please provide keys." });
            }

            // Lazy load Notion client.
            const { Client } = require("@notionhq/client");
            const notion = new Client({ auth: userData.notionKey });

            console.log("Starting parallel Journal processing (Zero Storage)...");

            // Prepare image data.
            // Remove the "data:image/jpeg;base64," prefix to get raw data.
            const mimeType = imageData.match(/data:(.*);base64,/)?.[1] || 'image/jpeg';
            const base64Data = imageData.split(',')[1];

            // Convert Base64 string into a Buffer (binary data) for uploading.
            const buffer = Buffer.from(base64Data, 'base64');

            // PARALLEL EXECUTION (Important Concept!)
            // We start uploading to Notion AND asking AI to find the date at the same time.
            // 'Promise.all' waits for both to finish. This is much faster than doing one then the other.
            const [fileUploadId, extraction] = await Promise.all([
                uploadFileToNotion(userData.notionKey, buffer, mimeType), // Upload image
                getPlannerDataFromImage(imageData, 'journal_date_only').catch(err => {
                    // If AI fails to find date, don't crash. Just return null.
                    console.warn("Date extraction failed:", err.message);
                    return { date: null };
                })
            ]);

            // Default date is Today if AI failed.
            let journalDate = new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata' });
            if (extraction && extraction.date) {
                journalDate = extraction.date; // Use AI found date
                console.log(`Extracted Journal Date: ${journalDate}`);
            }

            // Create the entry in Notion.
            const dbId = userData.notionDbId;

            await notion.pages.create({
                parent: { database_id: dbId },
                properties: {
                    // Set the title of the page
                    "Name": { title: [{ text: { content: `Journal - ${journalDate}` } }] }
                },
                children: [
                    {
                        // Append the image we uploaded earlier
                        object: 'block',
                        type: 'image',
                        image: {
                            type: 'file_upload',
                            file_upload: { id: fileUploadId }
                        }
                    }
                ]
            });
            // Send success response to frontend.
            return res.status(200).send({ text: `Journal synced to Notion! Date: ${journalDate}` });
        }

        // --- BRANCH 2: MORNING/EVENING PLANNER ---

        console.log(`Parsing planner image for ${mode} sync...`);

        // Ask Gemini (AI) to read the handwriting on the image.
        const plannerData = await getPlannerDataFromImage(imageData, 'morning');

        // Check if AI returned an error structure.
        if (plannerData.error) {
            return res.status(400).send({ error: plannerData.error });
        }

        let msg = "";

        // --- SUB-BRANCH: MORNING ROUTINE ---
        if (mode === 'morning') {
            console.log("Starting parallel Morning sync...");

            // Parallel: Add Events to Calendar AND Add Tasks to Google Tasks.
            const [eventResults, taskCount] = await Promise.all([
                syncCalendarEvents(calendar, plannerData),
                syncGoogleTasks(tasks, plannerData)
            ]);

            // Also mark tasks as done (if you checked them off), but don't wait for this to finish (fire and forget).
            updateCompletedTasks(tasks, plannerData.todos).catch(e => console.warn("Task completion update failed:", e.message));

            msg = `Morning Sync Complete! Created ${eventResults.events} events, ${eventResults.reminders} reminders, and ${taskCount} tasks.`;

        }
        // --- SUB-BRANCH: EVENING ROUTINE ---
        else if (mode === 'evening') {

            // Re-scan image specifically looking for evening data (expenses, mood, etc).
            const plannerData = await getPlannerDataFromImage(imageData, 'evening');
            if (plannerData.error) return res.status(400).send({ error: plannerData.error });

            let successMessages = [];

            // 1. Mark tasks as completed in Google Tasks based on checkmarks in image.
            const updatedTasks = await updateCompletedTasks(tasks, plannerData);
            if (updatedTasks > 0) successMessages.push(`Marked ${updatedTasks} tasks completed.`);

            // 2. Check if user has a Google Sheet setup. If not, create one.
            let spreadsheetId = userData.spreadsheetId;
            if (!spreadsheetId) {
                console.log("No spreadsheet found. Creating new one...");
                const newSheet = await sheets.spreadsheets.create({
                    resource: {
                        properties: { title: "AI Planner Data" },
                        sheets: [
                            { properties: { title: "Expenses" } }, // Create Tab 1
                            { properties: { title: "Health" } }    // Create Tab 2
                        ]
                    }
                });
                spreadsheetId = newSheet.data.spreadsheetId;

                // Add headers to the new sheet (Date, Item, Amount, etc.)
                await sheets.spreadsheets.values.update({
                    spreadsheetId, range: 'Expenses!A1:C1', valueInputOption: 'RAW',
                    requestBody: { values: [["Date", "Item", "Amount"]] }
                });
                await sheets.spreadsheets.values.update({
                    spreadsheetId, range: 'Health!A1:E1', valueInputOption: 'RAW',
                    requestBody: { values: [["Date", "Exercise", "Water", "Sleep", "Energy"]] }
                });

                // Save the new Sheet ID to Firestore so we don't create it again next time.
                await userRef.set({ spreadsheetId }, { merge: true });
                successMessages.push("(Created new 'AI Planner Data' Sheet).");
            }

            // 3. Parallel Execution: Sync Expenses, Health, and Notion at the same time.
            console.log("Starting parallel Evening sync...");

            const promises = [
                syncExpensesToSheet(sheets, plannerData, spreadsheetId),
                syncHealthToSheet(sheets, plannerData, spreadsheetId)
            ];

            // If Notion keys exist, add the Notion sync task to our list of promises.
            if (userData.notionKey && userData.notionDbId) {
                // We create an anonymous async function immediately to handle the Notion logic.
                const { Client } = require("@notionhq/client");

                promises.push(
                    (async () => {
                        // Prepare image buffer again
                        const mimeType = imageData.match(/data:(.*);base64,/)?.[1] || 'image/jpeg';
                        const base64Data = imageData.split(',')[1];
                        const buffer = Buffer.from(base64Data, 'base64');
                        // Upload file
                        const fileId = await uploadFileToNotion(userData.notionKey, buffer, mimeType);
                        // Create Notion Page with Brain Dump text + Image
                        return syncBrainDumpToNotion(plannerData, userData.notionKey, userData.notionDbId, fileId);
                    })()
                );
            }

            // Wait for all evening tasks to finish.
            const results = await Promise.all(promises);

            // Unpack results to build the success message.
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
        // Global Error Handler. If anything above crashes, this catches it.
        console.error("FATAL ERROR:", error.message);
        console.error("Stack:", error.stack);

        // Return a generic error to the user (security practice: don't show stack traces to users).
        const safeMessage = error.message.includes("RATE_LIMIT") ? "AI Service Busy. Please try again." : "Internal Server Error";
        res.status(500).send({ error: safeMessage });
    }
});

// --- HELPER FUNCTIONS ---

// Helper: Uploads a binary file directly to Notion via their API.
async function uploadFileToNotion(apiKey, fileBuffer, mimeType) {
    try {
        console.log("Step 1: Init Notion Upload...");
        // Notion requires 2 steps. Step 1: Tell them we want to upload a file.
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
        // They give us a special temporary URL to upload the actual data to.
        const { id, upload_url } = uploadObj;

        console.log(`Step 1 Success. ID: ${id}. Step 2: Uploading Binary...`);

        // Step 2: Upload the actual binary data (Blob) to that URL.
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
        return id; // Return the File ID so we can attach it to a page later.
    } catch (e) {
        console.error("Notion Direct Upload Error:", e);
        throw e;
    }
}

// Helper: Wraps 'fetch' with a timeout so requests don't hang forever.
async function fetchWithTimeout(url, options, timeout = 60000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout); // Set a timer to kill the request
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(id); // If successful, clear the timer
        return response;
    } catch (error) {
        clearTimeout(id);
        throw error;
    }
}

// Helper: Sends the image and prompt to Google Gemini API.
async function callGeminiModel(model, apiKey, prompt, imageData, mimeType) {
    console.log(`Attempting Gemini model: ${model}...`);
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    // Construct the JSON payload for Gemini.
    const payload = {
        contents: [{
            parts: [
                { text: prompt },
                { inlineData: { mimeType, data: imageData } } // Sending image as inline Base64
            ]
        }],
        generationConfig: { responseMimeType: "application/json" } // Force AI to return JSON
    };

    let attempt = 0;
    const maxRetries = 5;

    // Retry Loop: If API fails, try again a few times.
    while (attempt <= maxRetries) {
        try {
            const response = await fetchWithTimeout(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }, 120000); // 2 minute timeout

            if (!response.ok) {
                // Handle Rate Limiting (Error 429) specifically.
                if (response.status === 429) {
                    attempt++;
                    if (attempt <= maxRetries) {
                        // Exponential Backoff: Wait 1s, then 2s, then 4s...
                        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
                        console.warn(`Rate limit (429) for ${model}. Retrying in ${delay.toFixed(0)}ms...`);
                        await new Promise(resolve => setTimeout(resolve, delay)); // Pause execution
                        continue; // Jump to start of loop
                    }
                    throw new Error("RATE_LIMIT_EXHAUSTED");
                }
                if (response.status >= 500) throw new Error("SERVER_ERROR");
                const body = await response.text();
                throw new Error(`API_ERROR_${response.status}: ${body}`);
            }

            const result = await response.json();
            // Dig deep into the JSON response to find the text we want.
            if (!result.candidates || !result.candidates[0].content.parts[0].text) {
                throw new Error("INVALID_RESPONSE");
            }
            return JSON.parse(result.candidates[0].content.parts[0].text);

        } catch (error) {
            // If it's a rate limit error, keep retrying. If it's something else, crash so we can switch models.
            if (attempt > 0 && attempt <= maxRetries && error.message.includes("RATE_LIMIT")) throw error;
            console.warn(`Model ${model} failed: ${error.message}`);
            throw error;
        }
    }
}

// Manager function to try different AI models if one fails.
async function getPlannerDataFromImage(imageData, syncType) {
    const { GoogleGenerativeAI } = require("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const mimeType = imageData.match(/data:(.*);base64,/)?.[1] || 'image/jpeg';
    const base64ImageData = imageData.split(',')[1];

    // Select the correct prompt text based on what we are doing.
    const prompt =
        syncType === 'evening' ? getEveningPrompt() :
            syncType === 'journal_date_only' ? getJournalDatePrompt() :
                getMorningPrompt();

    // List of models to try in order. If 'flash-lite' fails, try 'flash', etc.
    const models = [
        "gemini-2.5-flash-lite",
        "gemini-2.5-flash",
        "gemini-2.0-flash-lite",
        "gemini-flash-latest"
    ];

    let lastError = null;

    for (const model of models) {
        try {
            return await callGeminiModel(model, GEMINI_API_KEY, prompt, base64ImageData, mimeType);
        } catch (error) {
            lastError = error;
            // If this wasn't the last model, print a message and loop to the next one.
            if (models.indexOf(model) < models.length - 1) {
                console.log(`Falling back to next model...`);
            }
        }
    }
    // If we run out of models, throw an error.
    throw new Error(`All Gemini models failed. Last error: ${lastError?.message || "Unknown error"}`);
}

// Logic to add events to Google Calendar.
async function syncCalendarEvents(calendar, plannerData) {
    let counts = { events: 0, reminders: 0 };
    // Loop through the schedule array extracted by AI.
    for (const item of (plannerData.schedule || [])) {
        if ((item.block || item.reminder) && item.task) {
            // Convert "9 AM" to a Javascript Date Object.
            const startTime = parseDateTime(item.time, plannerData.date);

            if (!startTime) continue; // Skip if invalid time.

            // Assume event lasts 1 hour.
            const endTime = new Date(startTime.getTime() + 60 * 60 * 1000);

            // Google API expects ISO strings without the 'Z' (UTC marker) sometimes.
            const sTime = startTime.toISOString().replace('Z', '');
            const eTime = endTime.toISOString().replace('Z', '');
            console.log(`Creating Event: "${item.task}" Start: ${sTime} End: ${eTime}`);

            // Insert into 'primary' calendar.
            await calendar.events.insert({
                calendarId: 'primary',
                resource: {
                    summary: item.task,
                    start: { dateTime: sTime, timeZone: 'Asia/Kolkata' }, // Hardcoded Timezone
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

// Logic to add tasks to Google Tasks.
async function syncGoogleTasks(tasks, plannerData) {
    let count = 0;
    // Set due date to end of the day.
    const dueDate = new Date(plannerData.date);
    dueDate.setHours(23, 59, 59, 999);

    for (const item of (plannerData.todos || [])) {
        if (item.task) {
            await tasks.tasks.insert({
                tasklist: '@default', // Default list
                requestBody: {
                    title: item.task,
                    status: item.done ? 'completed' : 'needsAction', // Map boolean to API string
                    due: dueDate.toISOString()
                }
            });
            count++;
        }
    }
    return count;
}

// Logic to check off tasks that already exist in Google Tasks.
async function updateCompletedTasks(tasks, plannerData) {
    // 1. Get list of tasks the user marked as done in the planner image.
    const completedPlannerTasks = (plannerData.todos || [])
        .filter(todo => todo.done === true)
        .map(todo => todo.task);

    if (completedPlannerTasks.length === 0) return 0;

    // 2. Fetch all current active tasks from Google.
    const res = await tasks.tasks.list({
        tasklist: '@default',
        showCompleted: false,
    });

    const googleTasks = res.data.items;
    if (!googleTasks || googleTasks.length === 0) return 0;

    let updatedCount = 0;
    for (const plannerTaskTitle of completedPlannerTasks) {
        // 3. Match them by name (insensitive to case/whitespace).
        const matchingGoogleTask = googleTasks.find(gTask =>
            gTask.title.trim().toLowerCase() === plannerTaskTitle.trim().toLowerCase()
        );

        // 4. If found, tell Google to mark it 'completed'.
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

// Appends expense rows to Google Sheets.
async function syncExpensesToSheet(sheets, plannerData, spreadsheetId) {
    if (!plannerData.expenses || plannerData.expenses.length === 0) return 0;

    // Create a list of lists (rows).
    const rows = plannerData.expenses.map(expense => [
        plannerData.date,
        expense.item,
        expense.amount
    ]);

    const range = 'Expenses!A:C'; // Target Columns A, B, C

    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId: spreadsheetId,
            range: range,
            valueInputOption: 'USER_ENTERED', // Let Sheets guess types (numbers vs strings)
            requestBody: { values: rows },
        });
        return rows.length;
    } catch (err) {
        console.error('Failed to sync expenses:', err.message);
        return 0;
    }
}

// Appends health metrics to Google Sheets.
async function syncHealthToSheet(sheets, plannerData, spreadsheetId) {
    if (!plannerData.health || Object.keys(plannerData.health).length === 0) return 0;

    const row = [
        plannerData.date,
        plannerData.health.exercise || "",
        plannerData.health.water || 0,
        plannerData.health.sleep || 0,
        plannerData.health.energy || 0
    ];

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

// Creates a Notion page for the "Brain Dump" and attaches the uploaded image.
async function syncBrainDumpToNotion(plannerData, notionApiKey, databaseId, fileId) {
    if ((!plannerData.brainDump || plannerData.brainDump.trim() === '') && !fileId) return false;

    // Validation: Check for dummy keys.
    if (!notionApiKey || notionApiKey.includes("YOUR_")) {
        console.warn("Notion API Key not configured.");
        return false;
    }

    const { Client } = require("@notionhq/client");
    const notion = new Client({ auth: notionApiKey });
    const pageTitle = `Brain Dump - ${plannerData.date}`;

    try {
        const children = [];

        // Create a text block.
        if (plannerData.brainDump) {
            children.push({
                object: 'block',
                type: 'paragraph',
                paragraph: {
                    rich_text: [{ type: 'text', text: { content: plannerData.brainDump } }]
                }
            });
        }

        // Create an image block using the ID we got from 'uploadFileToNotion'.
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

// Utility to parse "9 AM" into a Date object relative to "2025-08-06".
function parseDateTime(timeString, dateString) {
    const match = timeString.match(/(\d{1,2})\s*(AM|PM)/i); // Regex to find digits and AM/PM
    if (!match) return null;
    let hours = parseInt(match[1]);
    // 12-hour clock logic
    if (match[2].toUpperCase() === 'PM' && hours < 12) hours += 12;
    if (match[2].toUpperCase() === 'AM' && hours === 12) hours = 0;

    const d = new Date(dateString);
    d.setHours(hours, 0, 0, 0); // Set hours, zero out minutes/seconds
    return d;
}

// --- PROMPTS ---
// These are the instructions we send to the AI.
// It tells the AI exactly how to read the handwriting and what JSON format to return.

function getMorningPrompt() {
    return `Analyze the attached image of a daily planner... [Prompt details omitted for brevity]`;
}

function getEveningPrompt() {
    return `Analyze the attached image of a filled-out daily planner... [Prompt details omitted for brevity]`;
}

function getJournalDatePrompt() {
    return `Extract the handwritten date... [Prompt details omitted for brevity]`;
}
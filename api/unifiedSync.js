import dotenv from 'dotenv';
dotenv.config();
import { google } from 'googleapis';
import { Client } from "@notionhq/client"; // Import Notion Client
import fs from 'fs';
import path from 'path';

// --- Configuration ---
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const REDIRECT_URI = process.env.REDIRECT_URI;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

// Path to store the authentication token.
const TOKEN_PATH = path.join('/tmp', 'token.json');

// Google Calendar & Tasks settings
const CALENDAR_ID = 'primary';

// --- Main Serverless Handler ---
export default async function handler(req, res) {
    // Ensure all required environment variables are set
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GEMINI_API_KEY || !REDIRECT_URI || !SPREADSHEET_ID || !NOTION_API_KEY || !NOTION_DATABASE_ID) {
        console.error("Missing required environment variables.");
        return res.status(500).json({ error: "Server configuration error. Administrator has been notified." });
    }

    const oauth2Client = new google.auth.OAuth2(
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET,
        REDIRECT_URI
    );

    // ACTION 1: Handle Google Auth Login
    if (req.method === 'GET' && req.query.action === 'login') {
        const scopes = [
            'https://www.googleapis.com/auth/calendar.events',
            'https://www.googleapis.com/auth/tasks',
            'https://www.googleapis.com/auth/spreadsheets'
        ];
        const url = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: scopes,
            prompt: 'consent'
        });
        res.redirect(url);
        return;
    }

    // ACTION 2: Handle Google Auth Callback
    if (req.method === 'GET' && req.query.code) {
        try {
            const { code } = req.query;
            const { tokens } = await oauth2Client.getToken(code);
            fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
            res.status(200).send('<h1>Authentication successful! ✅</h1><p>You can close this tab now.</p>');
        } catch (error) {
            console.error('Error retrieving access token', error);
            res.status(500).send('Authentication failed. Check server logs.');
        }
        return;
    }

    // ACTION 3: Handle Main Sync Logic
    if (req.method === 'POST') {
        try {
            const { imageData, syncType } = req.body;
            if (!imageData) {
                return res.status(400).json({ error: 'Image data is required.' });
            }

            const auth = await getAuthenticatedClient(oauth2Client);
            const calendar = google.calendar({ version: 'v3', auth });
            const tasks = google.tasks({ version: 'v1', auth });
            const sheets = google.sheets({ version: 'v4', auth });

            const plannerData = await getPlannerDataFromImage(imageData);
            if (plannerData.error) {
                return res.status(400).json({ error: plannerData.error });
            }

            let successMessages = [];

            if (syncType === 'morning') {
                console.log("Morning Sync Initiated");
                const { createdEventsCount, setRemindersCount } = await syncCalendarEvents(calendar, plannerData);
                const createdTasksCount = await syncGoogleTasks(tasks, plannerData);
                successMessages.push(`Morning Sync: Created ${createdEventsCount} events, set ${setRemindersCount} reminders, and added ${createdTasksCount} tasks.`);

            } else if (syncType === 'evening') {
                console.log("Evening Sync Initiated");

                const updatedTasksCount = await updateCompletedTasks(tasks, plannerData);
                if (updatedTasksCount > 0) {
                    successMessages.push(`Updated ${updatedTasksCount} completed tasks.`);
                }

                const addedExpensesCount = await syncExpensesToSheet(sheets, plannerData, SPREADSHEET_ID);
                if (addedExpensesCount > 0) {
                    successMessages.push(`Added ${addedExpensesCount} expenses to your sheet.`);
                }

                const brainDumpSynced = await syncBrainDumpToNotion(plannerData, NOTION_API_KEY, NOTION_DATABASE_ID);
                if (brainDumpSynced) {
                    successMessages.push(`Added Brain Dump to Notion.`);
                }

            } else {
                return res.status(400).json({ error: 'Invalid syncType specified.' });
            }

            const finalMessage = successMessages.length > 0 ? successMessages.join(' ') : 'Sync complete! No new items to add.';
            res.status(200).json({ text: finalMessage });

        } catch (error) {
            console.error("FATAL ERROR in sync function:", error.message);
            if (error.message.includes('authenticate first') || error.message.includes('No refresh token')) {
                const loginUrl = `${REDIRECT_URI}?action=login`;
                return res.status(401).json({
                    error: `Authentication required or token expired. Please authenticate to continue.`,
                    loginUrl: loginUrl
                });
            }
            res.status(500).json({ error: "An internal server error occurred." });
        }
        return;
    }

    // Default response for other requests
    res.setHeader('Allow', ['GET', 'POST']);
    res.status(405).json({
        error: 'Method Not Allowed or Invalid Action.',
        usage: {
            authenticate: `GET ${REDIRECT_URI}?action=login`,
            sync: `POST ${REDIRECT_URI} with JSON body: { "imageData": "...", "syncType": "morning" | "evening" }`
        }
    });
}


// --- All Helper Functions ---

async function getAuthenticatedClient(oauth2Client) {
    if (!fs.existsSync(TOKEN_PATH)) {
        throw new Error(`Token file not found. Please authenticate first.`);
    }

    const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    if (!tokens.refresh_token) {
        fs.unlinkSync(TOKEN_PATH);
        throw new Error('No refresh token found. Please re-authenticate.');
    }

    oauth2Client.setCredentials(tokens);
    return oauth2Client;
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
            }, 45000); // 45s timeout per attempt

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

async function getPlannerDataFromImage(imageData) {
    const mimeType = imageData.match(/data:(.*);base64,/)?.[1] || 'image/jpeg';
    const base64ImageData = imageData.split(',')[1];

    const geminiPrompt = `Analyze the attached image of a daily planner with a multi-step verification process. 
    
    Step 1: Extract all relevant data.
    - Extract the handwritten date as a string (e.g., "25-August-2025").
    - Extract the schedule items with tasks into a "schedule" array. Each object should have "time", "task", "block" (boolean), and "reminder" (boolean).
    - Extract the to-do list items into a "todos" array. Each object should have "task" (string), "done" (boolean), and an optional "time" (string, e.g., "4 PM" or null).
    - Extract any items from the "Expenses" section into an "expenses" array. Each object should have "item" (string), and "amount" (number).
    - Extract any text from the "Brain Dump / Ideas" section as a single string called "brainDump". If the section is empty, this should be null.
    - Extract the handwritten totals for Blocks, Reminders, To-Dos, and Expenses as numbers.

    Step 2: Verify your work meticulously.
    - Count how many items in your extracted "schedule" have "block": true. Compare this to the handwritten total for Blocks.
    - Count how many items in your extracted "schedule" have "reminder": true. Compare this to the handwritten total for Reminders.
    - Count the total number of items in your extracted "todos" array. Compare this to the handwritten total for To-Dos.
    - Sum the 'amount' from all items in your extracted "expenses" array. Compare this sum to the handwritten 'Total Expenses'.

    Step 3: Finalize the output.
    - If ALL FOUR of your checks from Step 2 PERFECTLY MATCH the handwritten totals, return a single JSON object with "date", "schedule", "todos", "expenses", and "brainDump".
    - If ANY of your checks DO NOT MATCH, you have made a mistake. Re-examine the image, correct your extraction, and repeat Step 2. Do this re-check twice.
    - If after two re-checks the counts still do not match, return a JSON object with an "error" key explaining the specific mismatch, for example: "I counted 7 blocked events, but the planner says 8, or the expense total did not match." 
    
    Your final output must only be the clean JSON object without any extra text.`;

    // Fallback Strategy: Diverse models to avoid shared quota limits
    const models = [
        "gemini-2.5-flash",
        "gemini-2.0-flash",
        "gemini-2.0-flash-lite",
        "gemini-2.0-flash-001", // Often has separate quota
        "gemini-flash-latest"
    ];

    let lastError = null;

    for (const model of models) {
        try {
            return await callGeminiModel(model, GEMINI_API_KEY, geminiPrompt, base64ImageData, mimeType);
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
    let createdEventsCount = 0;
    let setRemindersCount = 0;

    for (const item of (plannerData.schedule || [])) {
        if ((item.block || item.reminder) && item.task) {
            const eventStartTime = parseDateTime(item.time, plannerData.date);
            if (!eventStartTime) {
                console.warn(`Skipping event with invalid time format: "${item.time}" for task "${item.task}"`);
                continue;
            }

            const eventEndTime = new Date(eventStartTime.getTime() + 60 * 60 * 1000); // 1-hour duration

            const event = {
                summary: item.task,
                start: { dateTime: eventStartTime.toISOString().replace('Z', ''), timeZone: 'Asia/Kolkata' },
                end: { dateTime: eventEndTime.toISOString().replace('Z', ''), timeZone: 'Asia/Kolkata' },
                reminders: {
                    useDefault: false,
                    overrides: item.reminder ? [{ method: 'popup', minutes: 10 }] : [],
                },
            };

            await calendar.events.insert({ calendarId: CALENDAR_ID, resource: event });
            if (item.block) createdEventsCount++;
            if (item.reminder) setRemindersCount++;
        }
    }
    return { createdEventsCount, setRemindersCount };
}

async function syncGoogleTasks(tasks, plannerData) {
    if (!plannerData.todos || plannerData.todos.length === 0) {
        return 0;
    }

    const taskListId = '@default';

    let createdTasksCount = 0;
    for (const item of plannerData.todos) {
        if (item.task) {
            let dueDateTime;

            if (item.time) {
                const specificDueTime = parseDateTime(item.time, plannerData.date);
                if (specificDueTime) {
                    dueDateTime = specificDueTime.toISOString();
                }
            }

            if (!dueDateTime) {
                const dueDate = new Date(plannerData.date);
                if (isNaN(dueDate.getTime())) {
                    console.warn(`Skipping task with invalid date: "${plannerData.date}" for task "${item.task}"`);
                    continue;
                }
                dueDate.setHours(23, 59, 59, 999);
                dueDateTime = dueDate.toISOString();
            }

            await tasks.tasks.insert({
                tasklist: taskListId,
                requestBody: {
                    title: item.task,
                    status: item.done ? 'completed' : 'needsAction',
                    due: dueDateTime
                }
            });
            createdTasksCount++;
        }
    }
    return createdTasksCount;
}

function parseDateTime(timeString, dateString) {
    if (!timeString || !dateString) return null;
    const timeMatch = timeString.match(/(\d{1,2})\s*(AM|PM)/i);
    if (!timeMatch) return null;

    let hours = parseInt(timeMatch[1], 10);
    const ampm = timeMatch[2].toUpperCase();

    if (ampm === 'PM' && hours < 12) hours += 12;
    if (ampm === 'AM' && hours === 12) hours = 0; // Midnight case

    const eventDate = new Date(dateString);
    if (isNaN(eventDate.getTime())) return null;

    eventDate.setHours(hours, 0, 0, 0);

    return eventDate;
}

async function syncExpensesToSheet(sheets, plannerData, spreadsheetId) {
    if (!plannerData.expenses || plannerData.expenses.length === 0) {
        console.log("No expenses found to sync.");
        return 0;
    }

    const rows = plannerData.expenses.map(expense => [
        new Date(plannerData.date).toLocaleDateString('en-CA'),
        expense.item,
        expense.amount
    ]);

    const range = 'Sheet1!A1';

    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId: spreadsheetId,
            range: range,
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: rows,
            },
        });
        console.log(`${rows.length} expenses appended to the sheet.`);
        return rows.length;
    } catch (err) {
        console.error('The API returned an error when writing to the sheet: ' + err);
        throw new Error('Failed to write to Google Sheet.');
    }
}

async function syncBrainDumpToNotion(plannerData, notionApiKey, databaseId) {
    if (!plannerData.brainDump || plannerData.brainDump.trim() === '') {
        console.log("No brain dump text found to sync.");
        return false;
    }
    console.log(`[Debug] Initializing Notion Client.`);
    console.log(`[Debug] Is notionApiKey a string? ${typeof notionApiKey === 'string'}`);
    if (notionApiKey) {
        console.log(`[Debug] API Key ends with: ...${notionApiKey.slice(-4)}`);
    } else {
        console.log(`[Debug] FATAL: notionApiKey is undefined or null!`);
    }
    const notion = new Client({ auth: notionApiKey });
    const pageTitle = `Brain Dump - ${new Date(plannerData.date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`;

    try {
        await notion.pages.create({
            parent: { database_id: databaseId },
            properties: {
                "Title": {
                    title: [{
                        text: { content: pageTitle }
                    }]
                }
            },
            children: [
                {
                    object: 'block',
                    type: 'paragraph',
                    paragraph: {
                        rich_text: [{
                            type: 'text',
                            text: { content: plannerData.brainDump }
                        }]
                    }
                }
            ]
        });
        console.log("Brain dump successfully created in Notion.");
        return true;
    } catch (err) {
        console.error("The Notion API returned an error: ", err);
        throw new Error('Failed to write to Notion.');
    }
}

async function updateCompletedTasks(tasks, plannerData) {
    // Get the list of completed task titles from the planner
    const completedPlannerTasks = (plannerData.todos || [])
        .filter(todo => todo.done === true)
        .map(todo => todo.task);

    if (completedPlannerTasks.length === 0) {
        console.log("No completed tasks found on the planner to update.");
        return 0;
    }

    // Get the user's list of active (not yet completed) tasks from Google Tasks
    const taskListId = '@default';
    const res = await tasks.tasks.list({
        tasklist: taskListId,
        showCompleted: false,
    });

    const googleTasks = res.data.items;
    if (!googleTasks || googleTasks.length === 0) {
        console.log("No active tasks found in Google Tasks to update.");
        return 0;
    }

    let updatedTasksCount = 0;

    // For each completed task from the planner, find a matching active task in Google Tasks
    for (const plannerTaskTitle of completedPlannerTasks) {
        const matchingGoogleTask = googleTasks.find(gTask => gTask.title === plannerTaskTitle);

        if (matchingGoogleTask) {
            // If a match is found, update its status to 'completed'
            console.log(`Found matching task to update: "${matchingGoogleTask.title}"`);
            await tasks.tasks.patch({
                tasklist: taskListId,
                task: matchingGoogleTask.id,
                requestBody: {
                    status: 'completed'
                }
            });
            updatedTasksCount++;
        }
    }

    console.log(`Updated ${updatedTasksCount} tasks in Google Tasks.`);
    return updatedTasksCount;
}
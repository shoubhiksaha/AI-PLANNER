const { logger } = require("firebase-functions/logger");
const { defineString } = require('firebase-functions/params');
const GEMINI_API_KEY = defineString('GEMINI_API_KEY');

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
            }, 120000); // 120s timeout per attempt

            if (!response.ok) {
                if (response.status === 429) {
                    attempt++;
                    if (attempt <= maxRetries) {
                        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
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

    const prompt =
        syncType === 'evening' ? getEveningPrompt() :
            syncType === 'journal_date_only' ? getJournalDatePrompt() :
                getMorningPrompt();

    // Fallback Strategy: Diverse models to avoid shared quota limits
    const models = [
        "gemini-2.5-flash-lite", // "Ultra Fast" & Stable
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
            if (models.indexOf(model) < models.length - 1) {
                console.log(`Falling back to next model...`);
            }
        }
    }

    throw new Error(`All Gemini models failed. Last error: ${lastError?.message || "Unknown error"}`);
}

module.exports = {
    getPlannerDataFromImages
};

const { logger } = require("firebase-functions/logger");
const { defineSecret } = require('firebase-functions/params');
const { redactSensitive, todayInTimeZone } = require('../utils');
const { getE2EFakes } = require('../testing/e2eFakes');
const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');

// syncPlanner runs with timeoutSeconds: 300. The whole AI step (every retry and
// every fallback model) must finish well before that so the handler still has
// time to write to Google/Notion and, on failure, to refund the credit.
const DEFAULT_AI_BUDGET_MS = 180000;
const PER_ATTEMPT_TIMEOUT_MS = 90000;
const MIN_ATTEMPT_MS = 5000;
const MAX_RATE_LIMIT_RETRIES = 3;

/**
 * Error with a machine-readable `code`:
 *  - AI_INPUT_REJECTED  the model rejected the uploaded image/audio (client input)
 *  - AI_CONFIG_ERROR    server-side misconfiguration (bad key, billing, retired model)
 *  - AI_UNAVAILABLE     rate limits, 5xx, timeouts, deadline, unusable output
 *  - BYOK_REJECTED      the user's own provider rejected their key/model/URL
 */
class AIError extends Error {
    constructor(code, message, { status } = {}) {
        super(message);
        this.name = 'AIError';
        this.code = code;
        if (status) this.status = status;
    }
}

function getMorningPrompt() {
    return `Analyze the attached image of a daily planner or notebook page.
            Step 1: Extract all relevant data.
            - Extract the handwritten date strictly in "YYYY-MM-DD" format (e.g., "2025-08-06").
            - Extract the schedule items with tasks into a "schedule" array. Each object should have "time", "task", "block" (boolean), and "reminder" (boolean). Ignore empty or crossed-out tasks.
            - Extract the to-do list items into a "todos" array. Each object should have "task" (string) and "done" (boolean). Ignore empty lines.
            - Some pages have handwritten totals for Blocks, Reminders and To-Dos; many notebooks do not. Return them as
              "totals": { "blocks": number|null, "reminders": number|null, "todos": number|null }, using null for any total that is not written on the page.

            Step 2: Verify your work (only for totals that are actually written on the page).
            - Compare the number of schedule items with "block": true, with "reminder": true, and the number of todos against the written totals.
            - If a count does not match, re-examine the image and correct your extraction. Do this re-check at most twice.

            Step 3: Finalize the output.
            - Return a single JSON object with "date", "schedule", "todos" and "totals".
            - If a count still does not match a written total after re-checking, STILL return your best extraction and add a "warning" string describing the mismatch (for example "Found 7 blocked events but the page says 8").
            - Only return { "error": "..." } when the image is not a planner or notebook page, or is completely unreadable.

            Do not include any explanatory text. Your final output must only be the clean JSON object.`;
}

function getEveningPrompt() {
    return `Analyze the attached image of a filled-out daily planner or notebook page (Evening Review).
            Step 1: Extract relevant data.
            - "date": The handwritten date on the page strictly in "YYYY-MM-DD" format.
            - "todos": Look at the To-Dos list. Return an array of objects ({ "task": string, "done": boolean }). Only include tasks that are CLEARLY marked as done (checked off).
            - "expenses": Look at the Expenses section. Return an array of objects ({ "item": string, "amount": number }).
            - "health": Look at the Health/Wellness section. Extract:
                - "exercise": Details of exercise (string).
                - "water": Number of filled water circles (number).
                - "sleep": Hours of sleep (number).
                - "energy": Energy level 1-5 (number).
            - "brainDump": Extract the text from the Brain Dump / Ideas section (string).
            Sections that are not on the page should be returned empty.

            Step 2: Verify (only when the totals are written on the page).
            - Check the "Total Expenses" sum, if written, against the sum of items.
            - If something does not add up, still return your best extraction and add a "warning" string describing it.

            Step 3: Output.
            - Return a single JSON object with keys: "date", "todos", "expenses", "health", "brainDump" (and "warning" if needed).
            - Ensure output is well-formed JSON.
            `;
}

function getJournalDatePrompt() {
    return `Extract the handwritten date from this planner page.
            Return a single JSON object: { "date": "string" }.
            The date string should be formatted clearly (e.g., "15-January-2025").
            If no date is found, return { "date": null }.`;
}

function getJournalTranscriptionPrompt() {
    return `Extract the handwritten date and meticulously transcribe all the handwritten content from this journal page.
            Return a single JSON object: { "date": "string", "transcription": "string" }.
            The date string should be formatted clearly (e.g., "15-January-2025").
            If no date is found, return { "date": null }.
            If no handwriting is detected, return { "transcription": "" }.`;
}

function getVoiceNoteTranscriptionPrompt() {
    return `Please transcribe this audio recording accurately.
            Return a single JSON object: { "transcription": "string" }.
            If there is no speech, return { "transcription": "" }.`;
}

function getPromptForSyncType(syncType) {
    switch (syncType) {
        case 'evening': return getEveningPrompt();
        case 'journal_date_only': return getJournalDatePrompt();
        case 'journal_transcribe': return getJournalTranscriptionPrompt();
        case 'voice_note': return getVoiceNoteTranscriptionPrompt();
        default: return getMorningPrompt();
    }
}

function remainingMs(deadline) {
    return deadline - Date.now();
}

// Helper to fetch with timeout
async function fetchWithTimeout(url, options, timeout) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
        if (error?.name === 'AbortError') throw new AIError('AI_UNAVAILABLE', 'AI_TIMEOUT');
        throw new AIError('AI_UNAVAILABLE', `NETWORK_ERROR: ${redactSensitive(error?.message || error)}`);
    } finally {
        clearTimeout(id);
    }
}

/**
 * Only an INVALID_ARGUMENT about the uploaded media is the client's fault.
 * Bad/expired server keys, billing/permission problems and unknown models are
 * server-side misconfiguration.
 */
function classifyGeminiClientError(status, body) {
    const text = String(body || '');
    const keyOrBillingProblem = /API_KEY_INVALID|API key not valid|API key expired|PERMISSION_DENIED|SERVICE_DISABLED|billing/i.test(text);
    if (status === 400 && !keyOrBillingProblem
        && /image|inline_?data|mime|media|audio|unsupported|unable to process input/i.test(text)) {
        return new AIError('AI_INPUT_REJECTED', `API_ERROR_${status}: input rejected`, { status });
    }
    return new AIError('AI_CONFIG_ERROR', `API_ERROR_${status}: ${redactSensitive(text).slice(0, 200)}`, { status });
}

// Helper to call Gemini with a specific model
async function callGeminiModel(model, apiKey, prompt, imagesArr, deadline) {
    logger.info(`Attempting Gemini model: ${model}...`);
    // The key travels in a header so it never appears in URLs, proxies or error messages.
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

    const parts = imagesArr.map(img => ({ inlineData: { mimeType: img.mimeType, data: img.base64Data } }));
    parts.push({ text: prompt });

    const body = JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseMimeType: "application/json" }
    });

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const remaining = remainingMs(deadline);
        if (remaining < MIN_ATTEMPT_MS) throw new AIError('AI_UNAVAILABLE', 'AI_DEADLINE_EXCEEDED');

        const response = await fetchWithTimeout(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            body
        }, Math.min(PER_ATTEMPT_TIMEOUT_MS, remaining));

        if (response.status === 429) {
            attempt++;
            const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
            if (attempt > MAX_RATE_LIMIT_RETRIES || remainingMs(deadline) - delay < MIN_ATTEMPT_MS) {
                throw new AIError('AI_UNAVAILABLE', 'RATE_LIMIT_EXHAUSTED', { status: 429 });
            }
            logger.warn(`Rate limit (429) for ${model}. Retrying in ${delay.toFixed(0)}ms (Attempt ${attempt}/${MAX_RATE_LIMIT_RETRIES})...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
        }
        if (!response.ok) {
            if (response.status >= 500) throw new AIError('AI_UNAVAILABLE', 'SERVER_ERROR', { status: response.status });
            const errBody = typeof response.text === 'function' ? await response.text().catch(() => '') : '';
            throw classifyGeminiClientError(response.status, errBody);
        }

        const result = await response.json();
        const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (typeof text !== 'string' || !text) throw new AIError('AI_UNAVAILABLE', 'INVALID_RESPONSE');
        try {
            return JSON.parse(text);
        } catch (_) {
            throw new AIError('AI_UNAVAILABLE', 'INVALID_JSON');
        }
    }
}

function asFiniteNumberOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Schema validation to prevent malformed AI output from crashing downstream sync
function validateAIOutput(data, type, { timeZone } = {}) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new AIError('AI_UNAVAILABLE', 'AI returned non-object output.');
    }
    const today = todayInTimeZone(timeZone);

    if (type === 'morning') {
        const schedule = Array.isArray(data.schedule) ? data.schedule.filter(item => item && typeof item.task === 'string' && item.task.trim()) : [];
        const todos = Array.isArray(data.todos) ? data.todos.filter(item => item && typeof item.task === 'string' && item.task.trim()) : [];
        // A model that still reports a count mismatch as an "error" but extracted
        // data is downgraded to a warning: sync anyway and let the user review.
        if (data.error && (schedule.length > 0 || todos.length > 0)) {
            data.warning = String(data.error);
            delete data.error;
        }
        if (data.error) return data;
        data.schedule = schedule;
        data.todos = todos;
        if (typeof data.date !== 'string') data.date = today;
        const totals = data.totals && typeof data.totals === 'object' ? data.totals : {};
        data.totals = {
            blocks: asFiniteNumberOrNull(totals.blocks),
            reminders: asFiniteNumberOrNull(totals.reminders),
            todos: asFiniteNumberOrNull(totals.todos),
        };
    } else if (type === 'evening') {
        if (data.error) {
            const hasData = (Array.isArray(data.todos) && data.todos.length > 0)
                || (Array.isArray(data.expenses) && data.expenses.length > 0)
                || (data.health && typeof data.health === 'object' && Object.keys(data.health).length > 0)
                || (typeof data.brainDump === 'string' && data.brainDump.trim());
            if (!hasData) return data;
            data.warning = String(data.error);
            delete data.error;
        }
        if (typeof data.date !== 'string') data.date = today;
        if (!Array.isArray(data.todos)) data.todos = [];
        if (!Array.isArray(data.expenses)) data.expenses = [];
        if (!data.health || typeof data.health !== 'object' || Array.isArray(data.health)) data.health = {};
        data.todos = data.todos.filter(item => item && typeof item.task === 'string' && item.task.trim());
        data.expenses = data.expenses.filter(item => item && typeof item.item === 'string' && typeof item.amount === 'number');
    } else if (type === 'journal_date_only') {
        data.date = typeof data.date === 'string' ? data.date : null;
    } else if (type === 'journal_transcribe') {
        data.date = typeof data.date === 'string' ? data.date : null;
        data.transcription = typeof data.transcription === 'string' ? data.transcription : "";
    } else if (type === 'voice_note') {
        data.transcription = typeof data.transcription === 'string' ? data.transcription : "";
    }
    if (data.warning !== undefined && typeof data.warning !== 'string') delete data.warning;
    return data;
}

/**
 * Compare extracted counts with handwritten totals. Totals that are absent
 * (null) are skipped; mismatches become user-facing warnings, never errors.
 */
function getCountWarnings(plannerData, syncType) {
    const warnings = [];
    if (!plannerData || typeof plannerData !== 'object') return warnings;
    if (syncType === 'morning') {
        const schedule = plannerData.schedule || [];
        const todos = plannerData.todos || [];
        const totals = plannerData.totals || {};
        const checks = [
            ['blocks', 'blocked events', schedule.filter(i => i.block).length],
            ['reminders', 'reminders', schedule.filter(i => i.reminder).length],
            ['todos', 'to-dos', todos.length],
        ];
        for (const [key, label, found] of checks) {
            const written = asFiniteNumberOrNull(totals[key]);
            if (written !== null && written !== found) {
                warnings.push(`Your page lists ${written} ${label} but we found ${found}. Please review them in Google Calendar/Tasks.`);
            }
        }
    }
    if (typeof plannerData.warning === 'string' && plannerData.warning.trim() && warnings.length === 0) {
        warnings.push(`Please review this sync: ${plannerData.warning.trim().slice(0, 300)}`);
    }
    return warnings;
}

function classifyAdapterError(err) {
    if (err instanceof AIError) return err;
    const message = String(err?.message || err || '');
    const statusMatch = message.match(/API Error: (\d{3})/);
    const status = statusMatch ? Number(statusMatch[1]) : null;
    if (/SSRF blocked|Invalid BYOK Base URL|Invalid API Version/i.test(message)) {
        return new AIError('BYOK_REJECTED', 'BYOK_URL_REJECTED');
    }
    if (status && [400, 401, 403, 404].includes(status)) {
        return new AIError('BYOK_REJECTED', `BYOK_PROVIDER_${status}`, { status });
    }
    return new AIError('AI_UNAVAILABLE', `BYOK_PROVIDER_ERROR${status ? `_${status}` : ''}`, status ? { status } : {});
}

function withDeadline(promise, deadline) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new AIError('AI_UNAVAILABLE', 'AI_DEADLINE_EXCEEDED')), Math.max(0, remainingMs(deadline)));
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @param {Array} parsedImages
 * @param {string} syncType
 * @param {object|null} byokConfig
 * @param {object} [options]
 * @param {number} [options.deadline]  absolute epoch ms by which the AI step must finish
 * @param {string} [options.timeZone]  used for the default date
 * @param {string} [options.requestId]
 */
async function getPlannerDataFromImages(parsedImages, syncType, byokConfig = null, options = {}) {
    if (!parsedImages || parsedImages.length === 0) {
        throw new Error("INVALID_IMAGE_PAYLOAD");
    }
    const fakes = getE2EFakes();
    if (fakes) return fakes.ai.getPlannerData(parsedImages, syncType, options, { AIError, validateAIOutput, todayInTimeZone });
    const deadline = options.deadline || (Date.now() + DEFAULT_AI_BUDGET_MS);
    const prompt = getPromptForSyncType(syncType);

    // --- BYOK UNIVERSAL ADAPTER FORK ---
    if (byokConfig && byokConfig.apiKey) {
        const { UniversalAIAdapter } = require('./UniversalAIAdapter');
        const reqId = options.requestId || require('crypto').randomUUID();
        let resultRaw;
        try {
            const adapter = new UniversalAIAdapter({
                apiKey: byokConfig.apiKey,
                provider: byokConfig.provider,
                modelName: byokConfig.modelName,
                baseUrl: byokConfig.customUrl,
                apiVersion: byokConfig.apiVersion
            });
            logger.info(`Executing Universal AI Adapter route`, { provider: byokConfig.provider, modelName: byokConfig.modelName, requestId: reqId });
            resultRaw = await withDeadline(adapter.chat("", prompt, parsedImages, reqId), deadline);
        } catch (err) {
            throw classifyAdapterError(err);
        }

        if (typeof resultRaw === 'string' && resultRaw.startsWith('```json')) {
            resultRaw = resultRaw.replace(/```json\n?/, '').replace(/```$/, '').trim();
        }
        let parsed;
        try {
            parsed = JSON.parse(resultRaw);
        } catch (e) {
            // Never log the raw output: it is the user's handwritten content.
            logger.error("Failed to parse Universal AI JSON output", { error: e.message, rawLength: String(resultRaw || '').length, requestId: reqId });
            throw new AIError('AI_UNAVAILABLE', "Invalid final structured output from AI Adapter.");
        }
        return validateAIOutput(parsed, syncType, options);
    }

    // --- DEFAULT GEMINI BEHAVIOR ---
    const geminiApiKey = GEMINI_API_KEY.value();
    if (!geminiApiKey) {
        throw new AIError('AI_CONFIG_ERROR', "MISSING_GEMINI_API_KEY");
    }

    // Fallback Strategy: Diverse models to avoid shared quota limits
    const models = [
        "gemini-3.5-flash-lite", // "Ultra Fast" & Stable
        "gemini-3.5-flash",      // Balanced & Stable
        "gemini-3.6-flash",      // Next gen model
        "gemini-flash-latest"    // Fallback
    ];

    let lastError = null;
    for (let i = 0; i < models.length; i++) {
        const model = models[i];
        if (remainingMs(deadline) < MIN_ATTEMPT_MS) {
            lastError = new AIError('AI_UNAVAILABLE', 'AI_DEADLINE_EXCEEDED');
            break;
        }
        try {
            const raw = await callGeminiModel(model, geminiApiKey, prompt, parsedImages, deadline);
            return validateAIOutput(raw, syncType, options);
        } catch (error) {
            lastError = error;
            logger.warn(`Model ${model} failed`, { error: redactSensitive(error?.message || error), code: error?.code });
            // The same image will be rejected by every model, and a bad key or
            // billing problem affects all of them: stop the cascade early.
            if (error?.code === 'AI_INPUT_REJECTED') break;
            if (error?.code === 'AI_CONFIG_ERROR' && error.status !== 404) break;
            if (i < models.length - 1) logger.info(`Falling back to next model...`);
        }
    }

    const code = lastError?.code || 'AI_UNAVAILABLE';
    const finalError = new AIError(code, `All Gemini models failed. Last error: ${redactSensitive(lastError?.message || lastError || "Unknown error")}`, { status: lastError?.status });
    throw finalError;
}

module.exports = {
    getPlannerDataFromImages,
    getCountWarnings,
    validateAIOutput,
    classifyGeminiClientError,
    AIError,
    GEMINI_API_KEY,
    DEFAULT_AI_BUDGET_MS,
};

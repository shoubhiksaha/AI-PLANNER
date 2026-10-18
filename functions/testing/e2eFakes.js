/**
 * C10 — emulator end-to-end mode. Fakes for every external dependency so the
 * full app can run against the Firebase emulators with no network I/O.
 *
 * Active ONLY when both FUNCTIONS_EMULATOR === 'true' (set by the Functions
 * emulator, never in production) AND E2E_FAKE_EXTERNALS === 'true'.
 * Production code reaches this module through getE2EFakes() at the few points
 * where external clients are created (Google APIs, Notion, AI, KMS) plus the
 * request preamble that records the caller for the call log; with the gate
 * closed getE2EFakes() returns null and nothing here is used.
 *
 * Every faked external call appends one document to the Firestore collection
 * `__e2eCalls`: { service, method, email, at, summary }.
 */
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const E2E_GOOGLE_TOKEN = 'e2e-google-token';
// 1×1 red PNG: when it is the request's first image the AI step fails as a
// server-side misconfiguration, so refunds can be tested end to end.
const RED_PIXEL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const E2E_CALLS_COLLECTION = '__e2eCalls';
// Fixed task returned by the fake Google Tasks list so an evening sync marks exactly one task done.
const EVENING_DONE_TASK = 'E2E Review weekly plan';
// Deterministic key-encryption key: emulator functions run in separate worker
// processes, so wraps made by setupBYOK must unwrap in syncPlanner.
const FAKE_KMS_KEK = crypto.createHash('sha256').update('aiplanner-e2e-fake-kms').digest();

function isFakeExternalsEnabled(env = process.env) {
    return env.FUNCTIONS_EMULATOR === 'true' && env.E2E_FAKE_EXTERNALS === 'true';
}

const requestContext = new AsyncLocalStorage();

/**
 * Start a request context. Must be called synchronously at the start of the
 * request (before the first await) so the whole request sees it.
 */
function beginRequest() {
    const ctx = { email: null };
    requestContext.enterWith(ctx);
    return ctx;
}

function currentEmail() {
    return requestContext.getStore()?.email || null;
}

async function recordCall(service, method, summary = '') {
    const { FieldValue } = require('firebase-admin/firestore');
    const { db } = require('../services/db');
    await db().collection(E2E_CALLS_COLLECTION).add({
        service,
        method,
        email: currentEmail(),
        at: FieldValue.serverTimestamp(),
        summary: String(summary || '').slice(0, 200),
    });
}

function httpError(status, message) {
    const err = new Error(message);
    err.code = status;
    err.status = status;
    return err;
}

// --- Google APIs (googleapis-compatible surface used by services/googleSync) ---
function createGoogleApis() {
    let counter = 0;
    const nextId = (prefix) => `${prefix}-${Date.now().toString(36)}-${++counter}`;

    class OAuth2 {
        setCredentials(credentials) { this.credentials = credentials || {}; }
    }

    return {
        auth: { OAuth2 },
        oauth2: ({ auth } = {}) => ({
            userinfo: {
                get: async () => {
                    const token = auth?.credentials?.access_token;
                    if (token !== E2E_GOOGLE_TOKEN) throw httpError(401, 'Invalid Credentials');
                    await recordCall('oauth2', 'userinfo.get', 'token accepted');
                    return { data: { email: currentEmail() } };
                },
            },
        }),
        calendar: () => ({
            events: {
                list: async () => {
                    await recordCall('calendar', 'events.list', 'primary');
                    return { data: { items: [] } };
                },
                insert: async ({ resource } = {}) => {
                    await recordCall('calendar', 'events.insert', resource?.summary);
                    return { data: { id: nextId('evt'), ...resource } };
                },
            },
        }),
        tasks: () => ({
            tasks: {
                list: async ({ showCompleted } = {}) => {
                    await recordCall('tasks', 'tasks.list', showCompleted ? 'all' : 'open');
                    return { data: { items: showCompleted ? [] : [{ id: 'e2e-task-1', title: EVENING_DONE_TASK, status: 'needsAction' }] } };
                },
                insert: async ({ requestBody } = {}) => {
                    await recordCall('tasks', 'tasks.insert', requestBody?.title);
                    return { data: { id: nextId('task'), ...requestBody } };
                },
                patch: async ({ task, requestBody } = {}) => {
                    await recordCall('tasks', 'tasks.patch', `${task}: ${requestBody?.status || ''}`);
                    return { data: { id: task, ...requestBody } };
                },
            },
        }),
        sheets: () => ({
            spreadsheets: {
                create: async ({ resource } = {}) => {
                    await recordCall('sheets', 'spreadsheets.create', resource?.properties?.title);
                    return { data: { spreadsheetId: nextId('sheet') } };
                },
                batchUpdate: async () => {
                    await recordCall('sheets', 'spreadsheets.batchUpdate', 'formatting');
                    return { data: {} };
                },
                values: {
                    get: async ({ range } = {}) => {
                        await recordCall('sheets', 'values.get', range);
                        return { data: { values: [] } };
                    },
                    update: async ({ range } = {}) => {
                        await recordCall('sheets', 'values.update', range);
                        return { data: {} };
                    },
                    append: async ({ range, requestBody } = {}) => {
                        const rows = requestBody?.values || [];
                        await recordCall('sheets', 'values.append', `${range} (${rows.length} row${rows.length === 1 ? '' : 's'})`);
                        return { data: { updates: { updatedRows: rows.length } } };
                    },
                },
            },
        }),
        drive: () => ({
            files: {
                list: async () => {
                    await recordCall('drive', 'files.list', '');
                    return { data: { files: [] } };
                },
                create: async ({ requestBody } = {}) => {
                    await recordCall('drive', 'files.create', requestBody?.name);
                    return { data: { id: nextId('file') } };
                },
            },
        }),
    };
}

// --- Notion (@notionhq/client + notion-multipart-uploader + credential check) ---
function createNotionFakes() {
    let counter = 0;
    const titleOf = (properties) => properties?.Name?.title?.[0]?.text?.content || '';

    class Client {
        constructor() {
            this.databases = {
                retrieve: async ({ database_id: databaseId } = {}) => {
                    await recordCall('notion', 'databases.retrieve', databaseId);
                    return { id: databaseId, data_sources: [{ id: `e2e-ds-${databaseId}` }] };
                },
            };
            this.dataSources = {
                query: async () => {
                    await recordCall('notion', 'dataSources.query', '');
                    return { results: [] };
                },
            };
            this.pages = {
                create: async ({ properties, children = [] } = {}) => {
                    const paragraphs = children.filter(c => c.type === 'paragraph').length;
                    await recordCall('notion', 'pages.create', `${titleOf(properties)} (${paragraphs} paragraph${paragraphs === 1 ? '' : 's'})`);
                    return { id: `e2e-page-${++counter}` };
                },
            };
            this.blocks = {
                children: {
                    append: async ({ children = [] } = {}) => {
                        await recordCall('notion', 'blocks.children.append', `${children.length} blocks`);
                        return {};
                    },
                },
            };
        }
    }

    return {
        Client,
        uploadToNotion: async (_apiKey, buffer, mimeType, filename) => {
            await recordCall('notion', 'fileUploads.send', `${filename} ${mimeType} ${buffer?.length || 0}B`);
            return `e2e-file-${++counter}`;
        },
        validateCredentials: async (_apiKey, databaseId) => {
            await recordCall('notion', 'validateCredentials', databaseId);
            return { valid: true };
        },
    };
}

// --- AI extraction ---
function aiFixture(syncType, today) {
    if (syncType === 'morning') {
        return {
            date: today,
            schedule: [
                { time: '9:00 AM', task: 'E2E Standup', block: true, reminder: false },
                { time: '2:00 PM', task: 'E2E Design review', block: true, reminder: false },
            ],
            todos: [
                { task: 'E2E Buy milk', done: false },
                { task: 'E2E Call the bank', done: false },
                { task: 'E2E Water the plants', done: false },
            ],
            totals: { blocks: 2, reminders: 0, todos: 3 },
        };
    }
    if (syncType === 'evening') {
        return {
            date: today,
            todos: [{ task: EVENING_DONE_TASK, done: true }],
            expenses: [{ item: 'E2E Coffee', amount: 3.5 }],
            health: { exercise: 'E2E Walk', water: 6, sleep: 7, energy: 4 },
            brainDump: 'E2E brain dump line.',
        };
    }
    if (syncType === 'journal_transcribe' || syncType === 'journal_date_only') {
        return { date: today, transcription: 'E2E journal paragraph one.\nE2E journal paragraph two.' };
    }
    if (syncType === 'voice_note') {
        return { transcription: 'E2E voice note paragraph.' };
    }
    return {};
}

/**
 * Stand-in for services/gemini getPlannerDataFromImages.
 * @param {object} helpers { AIError, validateAIOutput, todayInTimeZone } from the caller (avoids a require cycle)
 */
// The browser re-encodes photos before upload, so the trigger is "the first image is 1×1
// pixels" (the red-pixel fixture) rather than an exact byte match.
async function isFailureTrigger(image) {
    if (!image?.base64Data) return false;
    if (image.base64Data === RED_PIXEL_PNG_BASE64) return true;
    try {
        const sharp = require('sharp');
        const { width, height } = await sharp(Buffer.from(image.base64Data, 'base64')).metadata();
        return width === 1 && height === 1;
    } catch (_) {
        return false;
    }
}

async function getPlannerData(parsedImages, syncType, options = {}, { AIError, validateAIOutput, todayInTimeZone }) {
    if (await isFailureTrigger(parsedImages?.[0])) {
        await recordCall('ai', 'generateContent', `${syncType}: forced failure`);
        throw new AIError('AI_CONFIG_ERROR', 'E2E_FAKE_AI_FAILURE', { status: 403 });
    }
    await recordCall('ai', 'generateContent', `${syncType} (${parsedImages?.length || 0} file${parsedImages?.length === 1 ? '' : 's'})`);
    return validateAIOutput(aiFixture(syncType, todayInTimeZone(options.timeZone)), syncType, options);
}

// --- Cloud KMS (KeyManagementServiceClient.encrypt/decrypt) ---
function createKmsClient() {
    return {
        encrypt: async ({ plaintext }) => {
            const iv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv('aes-256-gcm', FAKE_KMS_KEK, iv);
            const body = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
            await recordCall('kms', 'encrypt', 'wrap DEK');
            return [{ ciphertext: Buffer.concat([iv, body, cipher.getAuthTag()]) }];
        },
        decrypt: async ({ ciphertext }) => {
            const raw = Buffer.from(ciphertext);
            const decipher = crypto.createDecipheriv('aes-256-gcm', FAKE_KMS_KEK, raw.subarray(0, 12));
            decipher.setAuthTag(raw.subarray(raw.length - 16));
            const plaintext = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]);
            await recordCall('kms', 'decrypt', 'unwrap DEK');
            return [{ plaintext }];
        },
    };
}

let fakes = null;
function buildFakes() {
    return {
        googleApis: createGoogleApis(),
        notion: createNotionFakes(),
        ai: { getPlannerData },
        kms: { client: createKmsClient(), keyName: 'projects/demo-ai-planner/locations/global/keyRings/e2e/cryptoKeys/e2e' },
        beginRequest,
        setRequestEmail: (email) => {
            const ctx = requestContext.getStore();
            if (ctx) ctx.email = email || null;
        },
    };
}

/** The fakes when emulator E2E mode is on (both env vars), otherwise null. */
function getE2EFakes(env = process.env) {
    if (!isFakeExternalsEnabled(env)) return null;
    if (!fakes) fakes = buildFakes();
    return fakes;
}

module.exports = {
    E2E_GOOGLE_TOKEN,
    RED_PIXEL_PNG_BASE64,
    E2E_CALLS_COLLECTION,
    EVENING_DONE_TASK,
    isFakeExternalsEnabled,
    getE2EFakes,
    beginRequest,
    currentEmail,
    aiFixture,
};

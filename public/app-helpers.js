// Shared browser + test helpers (UMD)
// Browser: window.AppHelpers
// Node/Jest: require('../app-helpers')
(function (exports) {
    // ------------------------------------------------------------------
    // HTTP helpers
    // ------------------------------------------------------------------
    exports.parseJsonResponse = async (res) => {
        const text = await res.text();
        const contentType = (res.headers.get('content-type') || '').toLowerCase();

        if (!contentType.includes('application/json')) {
            const snippet = text.slice(0, 120).replace(/\s+/g, ' ').trim();
            const err = new Error(`Non-JSON API response (${res.status}): ${snippet || 'empty body'}`);
            err.status = res.status;
            err.nonJson = true;
            throw err;
        }

        try {
            return JSON.parse(text);
        } catch (e) {
            const err = new Error(`Invalid JSON API response (${res.status}).`);
            err.status = res.status;
            err.nonJson = true;
            throw err;
        }
    };

    const isLocalHost = (hostname) => hostname === 'localhost' || hostname === '127.0.0.1';

    // Round 3: one Firebase project, two environments. Production uses the
    // (default) database + us-central1; staging the `staging` database + asia-south1.
    exports.DEFAULT_FIRESTORE_DATABASE_ID = '(default)';
    exports.DEFAULT_FUNCTIONS_REGION = 'us-central1';

    /** Firestore database id from env config; `(default)` when absent or malformed. */
    exports.firestoreDatabaseIdFrom = (env) => {
        const id = env && typeof env.firestoreDatabaseId === 'string' ? env.firestoreDatabaseId.trim() : '';
        return (id === '(default)' || /^[a-z][a-z0-9-]{3,62}$/.test(id)) ? id : exports.DEFAULT_FIRESTORE_DATABASE_ID;
    };

    /** Cloud Functions region from env config; `us-central1` when absent or malformed. */
    exports.functionsRegionFrom = (env) => {
        const region = env && typeof env.functionsRegion === 'string' ? env.functionsRegion.trim() : '';
        return /^[a-z]+-[a-z]+\d+$/.test(region) ? region : exports.DEFAULT_FUNCTIONS_REGION;
    };

    // C5: /syncPlanner is called on the direct Cloud Functions URL (Hosting
    // rewrites are cut off at 60 s). Every other endpoint keeps the same-origin
    // Hosting rewrite (each site's rewrites point at its own region).
    exports.getApiUrls = (hostname, endpoint = 'syncPlanner') => {
        const env = (typeof window !== 'undefined' && window.__ENV_CONFIG__) ? window.__ENV_CONFIG__ : {};
        const projectId = env.projectId || 'ai-planner-project-467800';
        const region = exports.functionsRegionFrom(env);

        let PRIMARY_API_URL;
        if (isLocalHost(hostname)) {
            PRIMARY_API_URL = `http://127.0.0.1:5001/${projectId}/${region}/${endpoint}`;
        } else if (endpoint === 'syncPlanner') {
            const base = (typeof env.functionsBaseUrl === 'string' && /^https:\/\//.test(env.functionsBaseUrl))
                ? env.functionsBaseUrl.replace(/\/+$/, '')
                : `https://${region}-${projectId}.cloudfunctions.net`;
            PRIMARY_API_URL = `${base}/${endpoint}`;
        } else {
            PRIMARY_API_URL = `/${endpoint}`;
        }

        return { PRIMARY_API_URL };
    };

    // ------------------------------------------------------------------
    // C10 — emulator mode (tests only). Never active off localhost.
    // ------------------------------------------------------------------
    exports.EMULATOR_PROJECT_ID = 'demo-ai-planner';
    exports.E2E_GOOGLE_TOKEN = 'e2e-google-token';

    /**
     * True only when the page is served from localhost / 127.0.0.1 AND it was
     * asked for (?emulator=true or env.environment === 'emulator').
     * @param {{hostname?:string, search?:string}} loc window.location (or alike)
     * @param {object} env window.__ENV_CONFIG__
     */
    exports.isEmulatorMode = (loc, env) => {
        const hostname = loc && typeof loc.hostname === 'string' ? loc.hostname : '';
        if (!isLocalHost(hostname)) return false;
        let flag = false;
        try {
            flag = new URLSearchParams((loc && loc.search) || '').get('emulator') === 'true';
        } catch (_) { flag = false; }
        return flag || !!(env && env.environment === 'emulator');
    };

    /**
     * Config used in emulator mode: forces a `demo-` project id so nothing can
     * reach a real Firebase project. Returns the env unchanged otherwise.
     */
    exports.emulatorFirebaseConfig = (env) => {
        const base = env || {};
        if (typeof base.projectId === 'string' && base.projectId.startsWith('demo-')) return base;
        // Not an emulator config (e.g. the default staging env-config.js): also
        // drop its staging database/region so the emulators' defaults are used.
        return {
            ...base,
            projectId: exports.EMULATOR_PROJECT_ID,
            firestoreDatabaseId: exports.DEFAULT_FIRESTORE_DATABASE_ID,
            functionsRegion: exports.DEFAULT_FUNCTIONS_REGION,
        };
    };

    /** C9: App Check debug provider only on a local host (which includes emulator mode). */
    exports.shouldUseAppCheckDebugToken = (hostname) => isLocalHost(hostname);

    /** C9: App Check is on only when a non-empty site key is configured. */
    exports.appCheckSiteKeyFrom = (env) => {
        const key = env && typeof env.appCheckSiteKey === 'string' ? env.appCheckSiteKey.trim() : '';
        return key || null;
    };

    // ------------------------------------------------------------------
    // C9 — one fetch wrapper for every call to our functions
    // ------------------------------------------------------------------
    exports.APP_CHECK_HEADER = 'X-Firebase-AppCheck';

    const toPlainHeaders = (headers) => {
        if (!headers) return {};
        if (typeof Headers !== 'undefined' && headers instanceof Headers) {
            const out = {};
            headers.forEach((value, key) => { out[key] = value; });
            return out;
        }
        if (Array.isArray(headers)) return Object.fromEntries(headers);
        return { ...headers };
    };

    /**
     * Returns fetch(url, init) that adds `X-Firebase-AppCheck` when a token can
     * be obtained. A failed / slow token lookup never blocks the request — the
     * server's REQUIRE_APP_CHECK flag decides what happens without it.
     * @param {{fetchImpl:Function, getAppCheckToken?:Function, tokenTimeoutMs?:number}} opts
     */
    exports.createFunctionsFetch = ({ fetchImpl, getAppCheckToken, tokenTimeoutMs = 5000 } = {}) => {
        const doFetch = fetchImpl || ((...args) => fetch(...args));
        return async (url, init = {}) => {
            let token = null;
            if (typeof getAppCheckToken === 'function') {
                let timer = null;
                try {
                    token = await Promise.race([
                        Promise.resolve().then(() => getAppCheckToken()),
                        new Promise((resolve) => { timer = setTimeout(() => resolve(null), tokenTimeoutMs); }),
                    ]);
                } catch (_) {
                    token = null;
                } finally {
                    clearTimeout(timer);
                }
            }
            const headers = toPlainHeaders(init.headers);
            if (typeof token === 'string' && token) headers[exports.APP_CHECK_HEADER] = token;
            return doFetch(url, { ...init, headers });
        };
    };

    exports.readApiError = async (res) => {
        const statusLine = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
        let text = '';
        try {
            text = await res.text();
        } catch (_) {
            return { message: 'Request failed.', details: statusLine, errorCode: null };
        }

        const contentType = (res.headers.get('content-type') || '').toLowerCase();
        if (contentType.includes('application/json') && text) {
            try {
                const data = JSON.parse(text);
                const message = data.error || data.message || data.text || 'Request failed.';
                const detailLines = [statusLine, `Message: ${message}`];
                const extra = { ...data };
                delete extra.error;
                delete extra.message;
                delete extra.text;
                if (Object.keys(extra).length > 0) {
                    detailLines.push(`Response: ${JSON.stringify(extra, null, 2)}`);
                }
                return { message, details: detailLines.join('\n\n'), errorCode: data.errorCode || null, data };
            } catch (_) { /* fall through */ }
        }

        const snippet = text.slice(0, 500).replace(/\s+/g, ' ').trim();
        return {
            message: snippet ? snippet.slice(0, 120) : 'Request failed.',
            details: [statusLine, snippet ? `Response body:\n${text.slice(0, 500)}` : 'Empty response body']
                .filter(Boolean)
                .join('\n\n'),
            errorCode: null,
        };
    };

    // ------------------------------------------------------------------
    // C3 error envelope → plain-language messages
    // ------------------------------------------------------------------
    const ERROR_MESSAGES = {
        AUTH_INVALID: 'Your sign-in expired. Please sign in again.',
        GOOGLE_TOKEN_EXPIRED: 'Your Google connection expired. Reconnect Google to continue.',
        ORIGIN_NOT_ALLOWED: 'This page isn’t allowed to use AI Planner. Open the app from planner.analogdigital.tech.',
        GOOGLE_ACCOUNT_MISMATCH: 'The Google account you connected is different from the one you signed in with. Reconnect using the same account.',
        EMAIL_NOT_VERIFIED: 'Your Google email address isn’t verified yet. Verify it with Google, then try again.',
        PLAN_LIMIT: 'That isn’t included in your current plan.',
        INSUFFICIENT_CREDITS: 'You’re out of credits for this sync.',
        NOTION_NOT_CONFIGURED: 'You chose Notion for journal pages. Connect Notion first, or switch to Google Drive in Settings.',
        INVALID_IMAGE: 'We couldn’t read that photo. Try a clearer, well-lit JPG or PNG.',
        BYOK_INVALID: 'Your AI provider key or model was rejected. Check it in Advanced Settings.',
        BAD_REQUEST: 'Something about that request wasn’t right. Please try again.',
        RATE_LIMITED: 'Too many syncs in a short time. Wait a minute, then try again.',
        INTERNAL: 'Something went wrong on our side. Please try again.',
        AI_UNAVAILABLE: 'The AI service is busy right now. Please try again in a minute.',
        SERVICE_UNAVAILABLE: 'AI Planner is temporarily unavailable. Please try again in a few minutes.',
        PAYMENT_GATEWAY_ERROR: 'The payment provider didn’t respond. You have not been charged — please try again.',
        REAUTH_REQUIRED: 'For your security, confirm it’s you with Google before continuing.',
        SYNC_IN_PROGRESS: 'Still processing — check History in a minute.',
    };
    exports.ERROR_MESSAGES = ERROR_MESSAGES;

    // Codes whose server text is specific and already user-facing (e.g.
    // "Need 2, but have 1"); for everything else we show our own wording.
    const SERVER_TEXT_CODES = new Set(['PLAN_LIMIT', 'INSUFFICIENT_CREDITS', 'BYOK_INVALID', 'INVALID_IMAGE', 'BAD_REQUEST']);

    exports.PROCESSING_MESSAGE = 'Still processing — check History in a minute.';

    const looksTechnical = (text) => typeof text !== 'string' || !text.trim() || text.length > 300 ||
        /<[a-z!/]|Error:|\bat\s+\S+\s*\(|Non-JSON|stack|undefined|null/i.test(text);

    const codeForStatus = (status) => {
        if (status === 401) return 'AUTH_INVALID';
        if (status === 402) return 'INSUFFICIENT_CREDITS';
        if (status === 429) return 'RATE_LIMITED';
        if (status === 502) return 'AI_UNAVAILABLE';
        if (status === 503) return 'SERVICE_UNAVAILABLE';
        if (status >= 500) return 'INTERNAL';
        if (status === 400) return 'BAD_REQUEST';
        return null;
    };

    /**
     * Turn a failed API call into something the UI can render.
     * @param {{status?:number, data?:object, error?:Error}} input
     */
    exports.describeApiError = ({ status, data, error } = {}) => {
        const body = data || {};
        // 504 / our own abort / non-JSON gateway pages: the function may still be running.
        const isAbort = error && (error.name === 'AbortError');
        const effectiveStatus = status || (error && error.status) || 0;
        // 409 SYNC_IN_PROGRESS: a retry with the same clientRequestId reached the server while
        // the first attempt is still running — not a failure, nothing charged twice.
        if (isAbort || effectiveStatus === 504 || body.errorCode === 'SYNC_IN_PROGRESS') {
            return { kind: 'processing', errorCode: 'PROCESSING', message: exports.PROCESSING_MESSAGE, retryable: false, showUpgrade: false, creditRefunded: undefined };
        }
        if (error && !effectiveStatus) {
            const offline = /Failed to fetch|NetworkError|Load failed|network/i.test(error.message || '');
            return {
                kind: 'error',
                errorCode: 'NETWORK',
                message: offline ? 'Network error. Check your connection and try again.' : 'Something went wrong. Please try again.',
                retryable: true,
                showUpgrade: false,
                creditRefunded: undefined,
            };
        }
        if (error && error.nonJson) {
            return { kind: 'error', errorCode: 'INTERNAL', message: 'The server sent an unexpected response. Please try again.', retryable: true, showUpgrade: false, creditRefunded: undefined };
        }

        const errorCode = body.errorCode || codeForStatus(effectiveStatus) || 'UNKNOWN';
        let message = ERROR_MESSAGES[errorCode];
        if ((SERVER_TEXT_CODES.has(errorCode) || !message) && !looksTechnical(body.error)) {
            message = body.error.trim();
        }
        if (!message) message = 'Something went wrong. Please try again.';

        const notRetryable = new Set(['REAUTH_REQUIRED', 'PLAN_LIMIT', 'INSUFFICIENT_CREDITS', 'NOTION_NOT_CONFIGURED', 'BYOK_INVALID', 'ORIGIN_NOT_ALLOWED', 'EMAIL_NOT_VERIFIED', 'GOOGLE_TOKEN_EXPIRED', 'GOOGLE_ACCOUNT_MISMATCH']);
        return {
            kind: 'error',
            errorCode,
            message,
            retryable: !notRetryable.has(errorCode),
            showUpgrade: exports.shouldOpenUpgrade(errorCode),
            needsGoogleReconnect: errorCode === 'GOOGLE_TOKEN_EXPIRED' || errorCode === 'GOOGLE_ACCOUNT_MISMATCH',
            creditRefunded: body.creditRefunded,
        };
    };

    // C3: the upgrade/pricing modal opens only for these codes.
    exports.shouldOpenUpgrade = (errorCode) => errorCode === 'PLAN_LIMIT' || errorCode === 'INSUFFICIENT_CREDITS';

    const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;

    /** "No credit used" / "1 credit used" for an error result. */
    exports.creditNoteForError = (data, pages) => {
        const body = data || {};
        if (body.creditRefunded === false) {
            const n = Number.isInteger(body.creditsCharged) ? body.creditsCharged : (pages || 1);
            return n > 0 ? `${plural(n, 'credit')} used` : 'No credit used';
        }
        return 'No credit used';
    };

    /** "1 credit used" / "Already synced — no credit used" for a success result. */
    exports.creditNoteForSuccess = (data, { byok = false } = {}) => {
        const body = data || {};
        if (body.duplicate) return 'Already synced — no credit used';
        if (byok) return 'Your own AI key was used — no credits';
        const n = Number.isInteger(body.creditsCharged) ? body.creditsCharged : null;
        if (n === null) return '';
        return n > 0 ? `${plural(n, 'credit')} used` : 'No credit used';
    };

    /** C4 counts → "3 events · 4 tasks added · 2 tasks completed". */
    const DESTINATION_LABELS = { drive: 'Google Drive', notion: 'Notion' };
    exports.DESTINATION_LABELS = DESTINATION_LABELS;

    exports.summarizeCounts = (counts, { savedTo } = {}) => {
        const c = counts || {};
        const where = DESTINATION_LABELS[savedTo] || 'Notion';
        const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
        const parts = [];
        const added = [];
        if (num(c.events)) added.push(plural(num(c.events), 'event'));
        if (num(c.tasks)) added.push(plural(num(c.tasks), 'task'));
        if (added.length) parts.push(`${added.join(' · ')} added`);
        if (num(c.completedTasks)) parts.push(`${plural(num(c.completedTasks), 'task')} completed`);
        if (num(c.expenses)) parts.push(`${plural(num(c.expenses), 'expense')} logged`);
        if (num(c.health)) parts.push(`${plural(num(c.health), 'health entry', 'health entries')} logged`);
        if (num(c.journalPages)) parts.push(`${plural(num(c.journalPages), 'journal page')} saved to ${where}`);
        if (num(c.voiceNotes)) parts.push(`voice note saved to ${where}`);
        if (num(c.brainDump)) parts.push(`brain dump saved to ${where}`);
        return parts.join(' · ');
    };

    // ------------------------------------------------------------------
    // Sync modes, plan limits
    // ------------------------------------------------------------------
    exports.SYNC_MODES = {
        morning: { label: 'Morning plan', icon: 'sun', description: 'Adds today’s events and to-dos to Google Calendar and Tasks.' },
        evening: { label: 'Evening review', icon: 'moon', description: 'Ticks off finished tasks and logs spending and health to Sheets.' },
        journal: { label: 'Journal', icon: 'book-open', description: 'Saves handwritten journal pages to Google Drive or Notion.' },
        voice_note: { label: 'Voice note', icon: 'mic', description: 'Record a thought; it’s typed up and saved. Pro.' },
    };

    exports.normalizeSyncMode = (mode) => (mode === 'night' ? 'evening' : mode);

    /** Most pages a tier may attach at upload time (B-05). */
    exports.maxUploadForTier = (tier) => (tier === 'pro' ? 5 : tier === 'standard' ? 3 : 1);

    /** Pages allowed for a specific mode — enforced when a sync button is clicked. Mirrors functions checkFeaturesAndCredits. */
    exports.pageLimitFor = (tier, mode) => {
        const m = exports.normalizeSyncMode(mode);
        if (tier === 'pro') return 5;
        if (tier === 'standard') return m === 'journal' ? 3 : 1;
        return 1;
    };

    /**
     * Where journal pages, brain dumps and voice notes go. Mirrors the server's
     * resolveNotesDestination: an explicit choice wins; otherwise existing Notion
     * users keep Notion and everyone else uses Google Drive.
     */
    exports.resolveNotesDestination = (profile) => {
        const p = profile || {};
        if (p.notesDestination === 'drive' || p.notesDestination === 'notion') return p.notesDestination;
        return p.notionKey && p.notionDbId ? 'notion' : 'drive';
    };

    const isNotesMode = (m) => m === 'journal' || m === 'voice_note';

    /** Morning and evening always use Google; notes modes only when they're saved to Drive. */
    exports.needsGoogleToken = (mode, notesDestination = 'drive') => {
        const m = exports.normalizeSyncMode(mode);
        return !isNotesMode(m) || notesDestination === 'drive';
    };

    exports.needsNotion = (mode, notesDestination = 'notion') => {
        const m = exports.normalizeSyncMode(mode);
        return isNotesMode(m) && notesDestination === 'notion';
    };

    /** "today", "yesterday" or "on 12 Oct" for a YYYY-MM-DD sync date, relative to `todayStr`. */
    exports.friendlySyncDate = (dateStr, todayStr) => {
        const re = /^(\d{4})-(\d{2})-(\d{2})$/;
        if (!re.test(String(dateStr || '')) || !re.test(String(todayStr || ''))) return '';
        const toUtc = (d) => { const [y, m, day] = d.split('-').map(Number); return Date.UTC(y, m - 1, day); };
        const diff = Math.round((toUtc(todayStr) - toUtc(dateStr)) / 86400000);
        if (diff === 0) return 'today';
        if (diff === 1) return 'yesterday';
        const [y, m, d] = dateStr.split('-').map(Number);
        const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1];
        return y === Number(todayStr.slice(0, 4)) ? `on ${d} ${month}` : `on ${d} ${month} ${y}`;
    };

    // ------------------------------------------------------------------
    // C1 — stateless BYOK kept in this tab's sessionStorage only
    // ------------------------------------------------------------------
    const BYOK_SESSION_KEY = 'byok_stateless_v2';
    const LEGACY_BYOK_KEYS = ['byok_cookie_session_active', 'byok_stateless_config', 'byok_stateless_key'];
    exports.BYOK_SESSION_KEY = BYOK_SESSION_KEY;

    exports.readByokSession = (storage) => {
        try {
            const raw = storage && storage.getItem(BYOK_SESSION_KEY);
            if (!raw) return null;
            const cfg = JSON.parse(raw);
            if (!cfg || typeof cfg.apiKey !== 'string' || !cfg.apiKey || typeof cfg.provider !== 'string' || typeof cfg.modelName !== 'string') return null;
            return cfg;
        } catch (_) {
            return null;
        }
    };

    exports.writeByokSession = (storage, cfg) => {
        const clean = { provider: cfg.provider, modelName: cfg.modelName, apiKey: cfg.apiKey };
        if (cfg.baseUrl) clean.baseUrl = cfg.baseUrl;
        if (cfg.apiVersion) clean.apiVersion = cfg.apiVersion;
        storage.setItem(BYOK_SESSION_KEY, JSON.stringify(clean));
        return clean;
    };

    exports.clearByokSession = (sessionStore, localStore) => {
        [sessionStore, localStore].forEach((s) => {
            if (!s) return;
            try {
                s.removeItem(BYOK_SESSION_KEY);
                LEGACY_BYOK_KEYS.forEach(k => s.removeItem(k));
            } catch (_) { /* storage unavailable */ }
        });
    };

    exports.buildByokHeaders = (cfg) => {
        if (!cfg || !cfg.apiKey) return {};
        const headers = {
            'X-BYOK-Token': String(cfg.apiKey).trim(),
            'X-BYOK-Provider': String(cfg.provider || '').trim(),
            'X-BYOK-Model': String(cfg.modelName || '').trim(),
        };
        if (cfg.baseUrl) headers['X-BYOK-BaseUrl'] = String(cfg.baseUrl).trim();
        if (cfg.apiVersion) headers['X-BYOK-ApiVersion'] = String(cfg.apiVersion).trim();
        return headers;
    };

    // ------------------------------------------------------------------
    // Misc helpers
    // ------------------------------------------------------------------
    exports.generateClientRequestId = (cryptoObj) => {
        const c = cryptoObj || (typeof crypto !== 'undefined' ? crypto : null);
        if (c && typeof c.randomUUID === 'function') return c.randomUUID();
        const bytes = new Uint8Array(16);
        if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
        else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    };

    /** True when a Google access token is present and not about to expire. */
    exports.isTokenFresh = (expiresAt, now = Date.now(), skewMs = 5 * 60 * 1000) =>
        typeof expiresAt === 'number' && expiresAt - now > skewMs;

    /**
     * Accepts a Notion database ID, a dashed UUID, or a pasted Notion URL and
     * returns the 32-hex ID (lowercase, no dashes), or null.
     */
    exports.extractNotionId = (input) => {
        const raw = String(input || '').trim();
        if (!raw) return null;
        let target = raw;
        if (/^https?:\/\//i.test(raw)) {
            try { target = new URL(raw).pathname; } catch (_) { target = raw; }
        }
        target = target.split(/[?#]/)[0];
        const re = /(?:^|[^0-9a-f])([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})(?![0-9a-f])/gi;
        let match;
        let last = null;
        while ((match = re.exec(target)) !== null) {
            last = match[1];
            re.lastIndex = match.index + match[0].length;
        }
        return last ? last.replace(/-/g, '').toLowerCase() : null;
    };

    exports.validateNotionKey = (key) => {
        const k = String(key || '').trim();
        if (!k) return 'Paste your Notion access token.';
        if (!/^(ntn_|secret_)/.test(k)) return 'Notion tokens start with “ntn_” (or “secret_” on older connections).';
        if (k.length < 20) return 'That token looks too short. Copy the whole token from Notion.';
        return null;
    };

    exports.isHeicFile = (file) => {
        if (!file) return false;
        const type = String(file.type || '').toLowerCase();
        const name = String(file.name || '').toLowerCase();
        return type === 'image/heic' || type === 'image/heif' || name.endsWith('.heic') || name.endsWith('.heif');
    };

    exports.isAcceptedImage = (file) => {
        if (!file) return false;
        const type = String(file.type || '').toLowerCase();
        return type.startsWith('image/') || exports.isHeicFile(file);
    };

    // C8: per-file limit (matches functions MAX_IMAGE_BYTES) and a budget for the
    // whole JSON body (functions reject > 28 MB) so several raw HEICs don't 413.
    exports.MAX_IMAGE_BYTES = 20 * 1024 * 1024;
    exports.MAX_IMAGES_PAYLOAD_CHARS = 26 * 1024 * 1024;

    /** 'image/heif' for HEIF files, otherwise 'image/heic'. */
    exports.heicMimeFor = (file) => {
        const type = String((file && file.type) || '').toLowerCase();
        const name = String((file && file.name) || '').toLowerCase();
        return (type === 'image/heif' || (type !== 'image/heic' && name.endsWith('.heif'))) ? 'image/heif' : 'image/heic';
    };

    /**
     * C8: re-label a raw file data URL (often `data:application/octet-stream`
     * or `data:;base64` for HEIC) with the HEIC/HEIF MIME the server expects.
     * Returns null if the input isn't a base64 data URL.
     */
    exports.toHeicDataUrl = (dataUrl, mime = 'image/heic') => {
        const s = typeof dataUrl === 'string' ? dataUrl : '';
        const comma = s.indexOf(',');
        if (!s.startsWith('data:') || comma === -1 || !/;base64$/i.test(s.slice(0, comma))) return null;
        const safeMime = mime === 'image/heif' ? 'image/heif' : 'image/heic';
        return `data:${safeMime};base64,${s.slice(comma + 1)}`;
    };

    /** True for a page image that is still raw HEIC/HEIF (no in-browser preview). */
    exports.isHeicDataUrl = (dataUrl) => typeof dataUrl === 'string' && /^data:image\/hei[cf];/i.test(dataUrl);

    /** Total characters of the page images (used against MAX_IMAGES_PAYLOAD_CHARS). */
    exports.imagesPayloadChars = (images) => (images || []).reduce((n, s) => n + (typeof s === 'string' ? s.length : 0), 0);

    exports.heicTooLargeMessage = (name) =>
        `${name || 'This photo'} is a HEIC photo larger than 20 MB. Export it as JPEG, or set your iPhone camera to “Most Compatible”, then try again.`;

    // ------------------------------------------------------------------
    // History rows (C11)
    // ------------------------------------------------------------------
    exports.INTERRUPTED_MESSAGE = 'Interrupted — credit refunded';

    /**
     * @param {object} entry users/{email}/syncHistory doc data
     * @returns {{state:'success'|'pending'|'interrupted'|'failed', message:string}}
     */
    exports.describeHistoryEntry = (entry) => {
        const e = entry || {};
        const message = typeof e.message === 'string' ? e.message : '';
        if (e.status === 'success') return { state: 'success', message: message || 'Synced' };
        if (e.status === 'processing' || e.status === 'pending') return { state: 'pending', message: message || 'Processing…' };
        if (e.status === 'failed' && e.failureReason === 'interrupted') return { state: 'interrupted', message: exports.INTERRUPTED_MESSAGE };
        return { state: 'failed', message: message || 'Sync failed' };
    };

    const safeTimeZone = (tz) => {
        try {
            new Intl.DateTimeFormat('en-CA', { timeZone: tz });
            return tz;
        } catch (_) {
            return 'UTC';
        }
    };

    exports.dateKeyInTimeZone = (date, timeZone) =>
        new Date(date).toLocaleDateString('en-CA', { timeZone: safeTimeZone(timeZone || 'UTC') });

    /**
     * B-22: last-N-days heatmap buckets in the user's time zone.
     * @param {Date[]} dates successful sync timestamps
     * @returns {{date:string,count:number}[]} oldest → newest
     */
    exports.buildHeatmapDays = (dates, timeZone, today = new Date(), days = 30) => {
        const counts = {};
        (dates || []).forEach((d) => {
            const key = exports.dateKeyInTimeZone(d, timeZone);
            counts[key] = (counts[key] || 0) + 1;
        });
        const [y, m, dd] = exports.dateKeyInTimeZone(today, timeZone).split('-').map(Number);
        const out = [];
        for (let i = days - 1; i >= 0; i--) {
            const key = new Date(Date.UTC(y, m - 1, dd - i)).toISOString().slice(0, 10);
            out.push({ date: key, count: counts[key] || 0 });
        }
        return out;
    };

    /** Load a classic script once (Cashfree SDK). */
    const scriptPromises = {};
    exports.loadScriptOnce = (src, { integrity } = {}) => {
        if (scriptPromises[src]) return scriptPromises[src];
        scriptPromises[src] = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            s.async = true;
            if (integrity) {
                s.integrity = integrity;
                s.crossOrigin = 'anonymous';
            }
            s.onload = () => resolve();
            s.onerror = () => {
                delete scriptPromises[src];
                s.remove();
                reject(new Error(`Could not load ${src}`));
            };
            document.head.appendChild(s);
        });
        return scriptPromises[src];
    };

    // ------------------------------------------------------------------
    // Theme
    // ------------------------------------------------------------------
    exports.applyTheme = (modeInput, htmlElement, themeBtn, themeItems, matchMediaDark) => {
        // 'oled' was a separate theme; the dark theme is now near-black, so it maps to dark.
        const normalized = modeInput === 'oled' ? 'dark' : modeInput;
        const mode = ['light', 'dark', 'auto'].includes(normalized) ? normalized : 'auto';
        let effect = mode;
        const resolvedDarkPref = typeof matchMediaDark === 'boolean'
            ? matchMediaDark
            : !!(typeof window !== 'undefined' &&
                window.matchMedia &&
                window.matchMedia('(prefers-color-scheme: dark)').matches);

        if (mode === 'auto') {
            effect = resolvedDarkPref ? 'dark' : 'light';
        }

        htmlElement.classList.remove('dark-mode', 'oled-mode');
        if (effect === 'dark') htmlElement.classList.add('dark-mode');
        if (htmlElement.dataset) htmlElement.dataset.themeMode = mode;

        (themeItems || []).forEach(el => {
            const selected = (el.dataset && el.dataset.theme) === mode;
            el.classList.toggle('selected', selected);
            if (el.setAttribute) el.setAttribute('aria-pressed', selected ? 'true' : 'false');
        });

        if (!themeBtn) return;

        const icons = { auto: 'monitor', light: 'sun', dark: 'moon' };
        const labels = { auto: 'Match device', light: 'Light', dark: 'Dark' };
        themeBtn.dataset.themeIcon = icons[mode];
        const use = themeBtn.querySelector && themeBtn.querySelector('use');
        if (use) use.setAttribute('href', `#i-${icons[mode]}`);
        if (themeBtn.setAttribute) themeBtn.setAttribute('aria-label', `Theme: ${labels[mode]}. Change theme or style`);
    };

    // ------------------------------------------------------------------
    // Dialog accessibility (U-04): focus move, Tab trap, Escape, focus restore
    // ------------------------------------------------------------------
    const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    // Stack of open dialogs; only the topmost one reacts to Escape/Tab. Listening on
    // document (not the dialog) keeps Escape working after the focused element was
    // hidden (e.g. when an upgrade step changes).
    const dialogStack = [];

    exports.activateDialog = (container, onRequestClose, initialFocus) => {
        if (!container || typeof document === 'undefined') return () => {};
        const previouslyFocused = document.activeElement;
        const visibleFocusables = () => Array.from(container.querySelectorAll(FOCUSABLE))
            .filter(el => !el.closest('.hidden') && !el.hidden);
        const entry = { container };
        const onKeyDown = (e) => {
            if (dialogStack[dialogStack.length - 1] !== entry) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                if (onRequestClose) onRequestClose();
                return;
            }
            if (e.key !== 'Tab') return;
            const items = visibleFocusables();
            if (!items.length) return;
            const first = items[0];
            const last = items[items.length - 1];
            const inside = container.contains(document.activeElement);
            if (!inside) {
                e.preventDefault();
                (e.shiftKey ? last : first).focus();
            } else if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        };
        dialogStack.push(entry);
        document.addEventListener('keydown', onKeyDown);
        const target = initialFocus || visibleFocusables()[0];
        if (target && target.focus) setTimeout(() => target.focus(), 0);
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            document.removeEventListener('keydown', onKeyDown);
            const idx = dialogStack.indexOf(entry);
            if (idx !== -1) dialogStack.splice(idx, 1);
            if (previouslyFocused && previouslyFocused.focus && document.contains(previouslyFocused)) {
                previouslyFocused.focus();
            }
        };
    };

    // ------------------------------------------------------------------
    // Actionable error modal (used for non-sync failures)
    // ------------------------------------------------------------------
    function wireActionableErrorModal() {
        if (typeof document === 'undefined') return;

        const modal = document.getElementById('actionable-error-modal');
        const knowMoreBtn = document.getElementById('actionable-error-know-more');
        const closeBtn = document.getElementById('actionable-error-close');
        const detailsEl = document.getElementById('actionable-error-details');
        if (!modal || !knowMoreBtn || !closeBtn || !detailsEl) return;
        if (modal.dataset.wired === 'true') return;
        modal.dataset.wired = 'true';

        const hideModal = () => {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            detailsEl.classList.add('hidden');
            knowMoreBtn.textContent = 'Know more';
            knowMoreBtn.setAttribute('aria-expanded', 'false');
            if (modal.__deactivate) { modal.__deactivate(); modal.__deactivate = null; }
        };
        modal.__hide = hideModal;

        knowMoreBtn.addEventListener('click', () => {
            const expanded = !detailsEl.classList.contains('hidden');
            if (expanded) {
                detailsEl.classList.add('hidden');
                knowMoreBtn.textContent = 'Know more';
                knowMoreBtn.setAttribute('aria-expanded', 'false');
            } else {
                detailsEl.classList.remove('hidden');
                knowMoreBtn.textContent = 'Hide details';
                knowMoreBtn.setAttribute('aria-expanded', 'true');
            }
        });

        closeBtn.addEventListener('click', hideModal);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) hideModal();
        });
    }

    exports.showActionableError = ({ summary, title, details }) => {
        if (typeof document === 'undefined') {
            throw new Error(summary);
        }

        wireActionableErrorModal();

        const modal = document.getElementById('actionable-error-modal');
        const titleEl = document.getElementById('actionable-error-title');
        const summaryEl = document.getElementById('actionable-error-summary');
        const detailsEl = document.getElementById('actionable-error-details');
        const detailsTextEl = document.getElementById('actionable-error-details-text');
        const knowMoreBtn = document.getElementById('actionable-error-know-more');

        if (!modal || !summaryEl || !detailsEl || !detailsTextEl) {
            alert(summary);
            return;
        }

        if (titleEl) titleEl.textContent = title || 'Something went wrong';
        summaryEl.textContent = summary;
        detailsTextEl.textContent = details || 'No additional details available.';
        detailsEl.classList.add('hidden');
        if (knowMoreBtn) {
            knowMoreBtn.textContent = 'Know more';
            knowMoreBtn.setAttribute('aria-expanded', 'false');
            knowMoreBtn.classList.toggle('hidden', !details);
        }

        modal.classList.remove('hidden');
        modal.classList.add('flex');
        if (!modal.__deactivate) {
            modal.__deactivate = exports.activateDialog(modal, modal.__hide, document.getElementById('actionable-error-close'));
        }
    };

    exports.switchView = (viewId) => {
        // Hide all app "view-*" sections dynamically so new screens do not
        // require helper code updates to participate in navigation state.
        document.querySelectorAll('[id^="view-"]').forEach(el => {
            el.classList.add('view-hidden');
            // Fallback if stale CSS is cached and view-hidden rule isn't applied.
            el.style.display = 'none';
            el.hidden = true;
            el.setAttribute('aria-hidden', 'true');
        });
        const target = document.getElementById(viewId);
        if (target) {
            target.classList.remove('view-hidden');
            target.style.removeProperty('display');
            target.hidden = false;
            target.setAttribute('aria-hidden', 'false');
        }
    };
})(typeof module !== 'undefined' && module.exports ? module.exports : (window.AppHelpers = {}));

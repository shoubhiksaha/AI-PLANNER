/**
 * Shared HTTP preamble for every browser-facing endpoint:
 * standard headers → CORS/preflight → method → content-type → App Check →
 * Firebase ID token (verified email) → per-user rate limit.
 *
 * Every error uses the C3 envelope: { error, errorCode }.
 */
const { getAuth } = require('firebase-admin/auth');
const { getAppCheck } = require('firebase-admin/app-check');
const { logger } = require('firebase-functions/logger');
const { defineString } = require('firebase-functions/params');
const { checkRateLimit } = require('./rateLimit');
const {
    setStandardHeaders,
    applyCors,
    handleOptions,
    isJsonRequest,
    RATE_LIMIT_DEFAULT,
} = require('../utils');
const { getE2EFakes } = require('../testing/e2eFakes');

const REQUIRE_APP_CHECK = defineString('REQUIRE_APP_CHECK', { default: 'false' });

const ERROR_CODES = Object.freeze({
    AUTH_INVALID: 'AUTH_INVALID',
    REAUTH_REQUIRED: 'REAUTH_REQUIRED',
    GOOGLE_TOKEN_EXPIRED: 'GOOGLE_TOKEN_EXPIRED',
    ORIGIN_NOT_ALLOWED: 'ORIGIN_NOT_ALLOWED',
    GOOGLE_ACCOUNT_MISMATCH: 'GOOGLE_ACCOUNT_MISMATCH',
    EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
    PLAN_LIMIT: 'PLAN_LIMIT',
    INSUFFICIENT_CREDITS: 'INSUFFICIENT_CREDITS',
    NOTION_NOT_CONFIGURED: 'NOTION_NOT_CONFIGURED',
    INVALID_IMAGE: 'INVALID_IMAGE',
    BYOK_INVALID: 'BYOK_INVALID',
    BAD_REQUEST: 'BAD_REQUEST',
    RATE_LIMITED: 'RATE_LIMITED',
    SYNC_IN_PROGRESS: 'SYNC_IN_PROGRESS',
    INTERNAL: 'INTERNAL',
    AI_UNAVAILABLE: 'AI_UNAVAILABLE',
    SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
});

/** Send a C3 error envelope. `extra` may carry creditRefunded and similar fields. */
function sendError(res, status, errorCode, error, extra = {}) {
    return res.status(status).send({ error, errorCode, ...extra });
}

function getVerifiedEmail(decodedToken) {
    if (decodedToken?.email_verified !== true) return null;
    return typeof decodedToken?.email === 'string' && decodedToken.email.trim()
        ? decodedToken.email.trim().toLowerCase()
        : null;
}

function appCheckRequired() {
    return String(REQUIRE_APP_CHECK.value()).toLowerCase() === 'true';
}

async function enforceAppCheck(req, res, extra = {}) {
    if (!appCheckRequired()) return true;
    const appCheckToken = req.headers['x-firebase-appcheck'];
    if (!appCheckToken || typeof appCheckToken !== 'string') {
        sendError(res, 401, ERROR_CODES.AUTH_INVALID, 'App Check token required.', extra);
        return false;
    }
    try {
        await getAppCheck().verifyToken(appCheckToken);
        return true;
    } catch (_) {
        sendError(res, 401, ERROR_CODES.AUTH_INVALID, 'App Check verification failed.', extra);
        return false;
    }
}

/**
 * Verify a Firebase ID token and resolve the caller's verified email.
 * Returns { decodedToken, email } or sends 401/403 and returns null.
 */
async function authenticate(res, idToken, { checkRevoked = false, extra = {} } = {}) {
    if (!idToken || typeof idToken !== 'string') {
        sendError(res, 401, ERROR_CODES.AUTH_INVALID, 'Please sign in again.', extra);
        return null;
    }
    let decodedToken;
    try {
        decodedToken = await getAuth().verifyIdToken(idToken, checkRevoked);
    } catch (err) {
        logger.warn('ID token rejected', { code: err?.code || 'unknown', reason: String(err?.message || '').slice(0, 200) });
        sendError(res, 401, ERROR_CODES.AUTH_INVALID, 'Your session has expired. Please sign in again.', extra);
        return null;
    }
    if (typeof decodedToken?.email !== 'string' || !decodedToken.email.trim()) {
        sendError(res, 401, ERROR_CODES.AUTH_INVALID, 'Your account has no email address.', extra);
        return null;
    }
    const email = getVerifiedEmail(decodedToken);
    if (!email) {
        sendError(res, 403, ERROR_CODES.EMAIL_NOT_VERIFIED, 'Please verify your email address before using AI Planner.', extra);
        return null;
    }
    return { decodedToken, email, uid: decodedToken.uid || null };
}

async function enforceRateLimit(res, identity, endpoint, limit, extra = {}) {
    const rl = await checkRateLimit(identity, endpoint, limit);
    if (!rl.allowed) {
        res.set('Retry-After', String(Math.ceil(rl.retryAfterMs / 1000)));
        sendError(res, 429, ERROR_CODES.RATE_LIMITED, 'Too many requests. Please try again in a minute.', extra);
        return false;
    }
    return true;
}

/**
 * Run the common preamble. Returns null when a response was already sent
 * (preflight or error); otherwise returns the authenticated identity
 * ({ decodedToken, email, uid }) or {} when `auth` is false.
 *
 * @param {object} opts
 * @param {string} opts.endpoint            rate-limit bucket name
 * @param {string[]} [opts.methods]         allowed methods (default POST)
 * @param {boolean} [opts.auth]             verify the Firebase ID token (default true)
 * @param {string} [opts.tokenField]        body field holding the ID token
 * @param {boolean} [opts.checkRevoked]     verifyIdToken(checkRevoked)
 * @param {number} [opts.rateLimit]         requests per window
 * @param {Function} [opts.beforeAuth]      sync hook (req,res) => boolean; false = response sent
 * @param {object} [opts.errorExtra]        fields merged into every error body (e.g. creditRefunded)
 * @param {boolean} [opts.requireJson]      enforce Content-Type: application/json (default true)
 */
async function guardRequest(req, res, {
    endpoint,
    methods = ['POST'],
    auth = true,
    tokenField = 'idToken',
    checkRevoked = false,
    rateLimit = RATE_LIMIT_DEFAULT,
    beforeAuth = null,
    errorExtra = {},
    requireJson = true,
} = {}) {
    // C10: emulator E2E mode records the caller for the fake call log. This runs
    // before the first await so the context covers the whole request.
    const e2e = getE2EFakes();
    if (e2e) e2e.beginRequest();
    setStandardHeaders(res);
    if (handleOptions(req, res)) return null;
    if (!applyCors(req, res)) {
        sendError(res, 403, ERROR_CODES.ORIGIN_NOT_ALLOWED, 'Origin not allowed.', errorExtra);
        return null;
    }
    if (!methods.includes(req.method)) {
        sendError(res, 405, ERROR_CODES.BAD_REQUEST, 'Method not allowed.', errorExtra);
        return null;
    }
    if (requireJson && !isJsonRequest(req)) {
        sendError(res, 415, ERROR_CODES.BAD_REQUEST, 'Content-Type must be application/json.', errorExtra);
        return null;
    }
    if (beforeAuth && beforeAuth(req, res) === false) return null;
    if (!(await enforceAppCheck(req, res, errorExtra))) return null;
    if (!auth) return {};

    const identity = await authenticate(res, (req.body || {})[tokenField], { checkRevoked, extra: errorExtra });
    if (!identity) return null;
    if (e2e) e2e.setRequestEmail(identity.email);

    try {
        if (!(await enforceRateLimit(res, identity.email, endpoint, rateLimit, errorExtra))) return null;
    } catch (err) {
        logger.error('Rate limit check failed', { endpoint, error: err?.message });
        sendError(res, 503, ERROR_CODES.SERVICE_UNAVAILABLE, 'Service temporarily unavailable. Please try again.', errorExtra);
        return null;
    }
    return identity;
}

module.exports = {
    ERROR_CODES,
    REQUIRE_APP_CHECK,
    sendError,
    getVerifiedEmail,
    enforceAppCheck,
    authenticate,
    enforceRateLimit,
    guardRequest,
};

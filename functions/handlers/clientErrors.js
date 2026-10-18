/** logClientError: frontend error ingestion into GCP Error Reporting. */
const { getAuth } = require('firebase-admin/auth');
const { logger } = require('firebase-functions/logger');
const { checkRateLimit } = require('../services/rateLimit');
const { ERROR_CODES: E, sendError, guardRequest } = require('../services/requestGuard');
const { sanitizeControlCharacters } = require('../utils');

// --- GCP Error Reporting: Frontend Ingestion Endpoint ---
async function logClientErrorHandler(req, res) {
    const guard = await guardRequest(req, res, {
        endpoint: 'logClientError',
        auth: false,
        beforeAuth: (request, response) => {
            if (request.rawBody && request.rawBody.length > 16 * 1024) {
                sendError(response, 413, E.BAD_REQUEST, "Error report too large");
                return false;
            }
            return true;
        }
    });
    if (!guard) return;

    const { message, stack, url, line, column, idToken } = req.body || {};

    if (typeof message !== 'string' || !message.trim()) return sendError(res, 400, E.BAD_REQUEST, "Message required");
    if (message.length > 1000) return sendError(res, 400, E.BAD_REQUEST, "Message too large");
    if (stack !== undefined && typeof stack !== 'string') return sendError(res, 400, E.BAD_REQUEST, "Stack must be text");
    if (stack && stack.length > 5000) return sendError(res, 400, E.BAD_REQUEST, "Stack too large");

    let reporter = 'Anonymous';
    let rateLimitIdentity;
    if (idToken) {
        try {
            const decodedToken = await getAuth().verifyIdToken(idToken);
            reporter = decodedToken.uid || 'Authenticated';
            rateLimitIdentity = `uid_${decodedToken.uid || 'unknown'}`;
        } catch (_) {
            return sendError(res, 401, E.AUTH_INVALID, "Invalid identity token");
        }
    }

    try {
        const clientIp = req.ip || req.headers['x-forwarded-for'] || 'anonymous';
        const rl = await checkRateLimit(rateLimitIdentity || `ip_${clientIp}`, 'logClientError', 5);
        if (!rl.allowed) {
            return sendError(res, 429, E.RATE_LIMITED, "Rate limit exceeded");
        }
    } catch (e) {
        logger.error("Rate limit check failed", { error: e.message });
        // Fail CLOSED: if rate limiting infrastructure is down, reject the request
        return sendError(res, 503, E.SERVICE_UNAVAILABLE, "Service temporarily unavailable");
    }

    // Sanitize client-supplied fields before logging to prevent log injection
    const safeMessage = sanitizeControlCharacters(message, ' ').slice(0, 1000);
    const safeStack = sanitizeControlCharacters(stack || 'No stack trace provided', ' ').slice(0, 5000);
    let safeUrl = 'Unknown URL';
    if (typeof url === 'string') {
        try {
            const parsedUrl = new URL(url);
            safeUrl = `${parsedUrl.origin}${parsedUrl.pathname}`.slice(0, 500);
        } catch (_) {
            safeUrl = sanitizeControlCharacters(url).split(/[?#]/)[0].slice(0, 500);
        }
    }
    const safeLine = Number.isInteger(line) && line >= 0 && line <= 10_000_000 ? line : null;
    const safeColumn = Number.isInteger(column) && column >= 0 && column <= 10_000_000 ? column : null;

    // Construct a rich error string for GCP
    const errorBody = [
        `Frontend Error: ${safeMessage}`,
        `Reporter: ${reporter}`,
        `URL: ${safeUrl}${(safeLine !== null && safeColumn !== null) ? `:${safeLine}:${safeColumn}` : ''}`,
        `Stack Trace: ${safeStack}`
    ].join('\n');

    // Passing an Error object triggers native GCP Error Reporting aggregation
    logger.error("Client caught unhandled exception", new Error(errorBody));

    return res.status(200).send({ success: true });
}

module.exports = {
    logClientErrorHandler,
};

/** adminGrantCredits: one-off booster credit grant (server-to-server only). */
const { db } = require('../services/db');
const crypto = require('crypto');
const { logger } = require('firebase-functions/logger');
const { ERROR_CODES: E, sendError, enforceAppCheck } = require('../services/requestGuard');
const { grantBoosterCreditsToAllUsers, isValidGrantId } = require('../services/creditGrant');
const { setStandardHeaders, isJsonRequest } = require('../utils');
const { CREDITS_GRANT_TOKEN } = require('../params');

function constantTimeEquals(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

// --- ADMIN: one-off booster credit grant (server-to-server only) ---
// Body: { grantId, amount, confirm: `GRANT-CREDITS-<amount>`, dryRun? }.
// Re-sending the same grantId never grants twice.
async function adminGrantCreditsHandler(req, res) {
    setStandardHeaders(res);
    if (req.method !== 'POST') return sendError(res, 405, E.BAD_REQUEST, "Method not allowed");
    if (!isJsonRequest(req)) return sendError(res, 415, E.BAD_REQUEST, "Content-Type must be application/json");
    // C9: every endpoint except cashfreeWebhook honours REQUIRE_APP_CHECK.
    if (!(await enforceAppCheck(req, res))) return;

    const expectedToken = String(CREDITS_GRANT_TOKEN.value() || '').trim();
    const providedToken = String(req.get('x-credits-grant-token') || '').trim();
    if (!expectedToken || !providedToken || !constantTimeEquals(providedToken, expectedToken)) {
        return sendError(res, 403, E.AUTH_INVALID, "Forbidden");
    }

    const body = req.body || {};
    const amount = Number(body.amount ?? 25);
    if (!Number.isInteger(amount) || amount <= 0 || amount > 500) {
        return sendError(res, 400, E.BAD_REQUEST, "Invalid amount");
    }
    if (!isValidGrantId(body.grantId)) {
        return sendError(res, 400, E.BAD_REQUEST, "Invalid grantId");
    }
    // The confirmation phrase must name the exact amount being granted.
    if (body.confirm !== `GRANT-CREDITS-${amount}`) {
        return sendError(res, 400, E.BAD_REQUEST, "Invalid confirm phrase");
    }

    try {
        const firestore = db();
        const stats = await grantBoosterCreditsToAllUsers(firestore, amount, { dryRun: body.dryRun === true, grantId: body.grantId });
        logger.info("Admin credit grant completed", stats);
        return res.status(200).send({ success: true, stats });
    } catch (err) {
        if (err?.code === 'GRANT_IN_PROGRESS') {
            return sendError(res, 409, 'GRANT_IN_PROGRESS', "This grant is already running.");
        }
        logger.error("Admin credit grant failed", { error: err.message });
        return sendError(res, 500, E.INTERNAL, "Failed to grant credits");
    }
}

module.exports = {
    adminGrantCreditsHandler,
};

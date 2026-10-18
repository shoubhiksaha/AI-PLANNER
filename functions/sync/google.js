/** Google API client access and identity verification for syncPlanner. */
const { ERROR_CODES: E } = require('../services/requestGuard');
const { SyncError } = require('./errors');
const { getE2EFakes } = require('../testing/e2eFakes');

/**
 * The googleapis client (lazy-loaded: it is large and only morning/evening need it).
 * In emulator E2E mode (C10) a network-free fake with the same surface.
 */
function getGoogleApis() {
    const fakes = getE2EFakes();
    if (fakes) return fakes.googleApis;
    return require('googleapis').google;
}

function googleErrorStatus(err) {
    const status = err?.code ?? err?.status ?? err?.response?.status;
    return Number(status) || null;
}

/** Verify the Google access token belongs to the signed-in Firebase user. */
async function verifyGoogleIdentity(google, googleToken, email) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: googleToken });
    let userInfo;
    try {
        const oauth2 = google.oauth2({ version: 'v2', auth });
        userInfo = await oauth2.userinfo.get();
    } catch (err) {
        const status = googleErrorStatus(err);
        const text = String(err?.message || '');
        if ([400, 401, 403].includes(status) || /invalid[_ ]token|invalid credentials|unauthori[sz]ed|expired/i.test(text)) {
            throw new SyncError(401, E.GOOGLE_TOKEN_EXPIRED, "Your Google connection expired. Reconnect Google to continue.");
        }
        throw new SyncError(503, E.SERVICE_UNAVAILABLE, "We couldn't reach Google. Please try again.");
    }
    if (userInfo?.data?.email?.toLowerCase() !== email) {
        throw new SyncError(403, E.GOOGLE_ACCOUNT_MISMATCH, "The connected Google account doesn't match your sign-in. Reconnect Google with the same account.");
    }
    return auth;
}

module.exports = { getGoogleApis, googleErrorStatus, verifyGoogleIdentity };

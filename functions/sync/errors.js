/** Error type and failure mapping for the syncPlanner flow (C3 envelope). */
const { ERROR_CODES: E } = require('../services/requestGuard');

/** Error carrying an HTTP status and C3 errorCode through the sync flow. */
class SyncError extends Error {
    constructor(status, errorCode, message) {
        super(message);
        this.status = status;
        this.errorCode = errorCode;
    }
}

/** Map AI/service failures to the C3 envelope (status, errorCode, user message). */
function mapSyncFailure(error) {
    const code = error?.code;
    const message = String(error?.message || error || '');
    if (code === 'AI_INPUT_REJECTED' || message === 'INVALID_IMAGE_PAYLOAD') {
        return { status: 400, errorCode: E.INVALID_IMAGE, message: "We couldn't process this image. Please retake the photo and try again." };
    }
    if (code === 'BYOK_REJECTED') {
        return { status: 400, errorCode: E.BYOK_INVALID, message: "Your AI provider rejected the request. Check your API key, model and settings." };
    }
    if (code === 'AI_CONFIG_ERROR') {
        return { status: 502, errorCode: E.AI_UNAVAILABLE, message: "The AI service is temporarily unavailable. Please try again later.", serverMisconfig: true };
    }
    if (code === 'AI_UNAVAILABLE') {
        return { status: 502, errorCode: E.AI_UNAVAILABLE, message: "The AI service is busy right now. Please try again in a moment." };
    }
    return { status: 500, errorCode: E.INTERNAL, message: "Something went wrong while syncing. Please try again." };
}

module.exports = { SyncError, mapSyncFailure };

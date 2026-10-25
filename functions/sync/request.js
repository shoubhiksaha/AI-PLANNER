/** syncPlanner request parsing and validation (before any credit is touched). */
const { logger } = require('firebase-functions/logger');
const { ERROR_CODES: E, sendError } = require('../services/requestGuard');
const {
    sanitizeSyncType,
    parseImageDataArray,
    ALLOWED_SYNC_TYPES,
    MAX_REQUEST_BODY_BYTES,
    isValidClientRequestId,
} = require('../utils');
const { SyncError } = require('./errors');
const { HEIC_ERROR_MESSAGE } = require('./images');
const { modeNeedsGoogle } = require('./notesDestination');

const HEIC_DATA_URL_RE = /^data:image\/hei[cf][;,]/i;

/** guardRequest beforeAuth hook: reject oversized bodies with 413 before auth. */
function payloadSizeCheck(requestId) {
    return (request, response) => {
        if (request.rawBody && request.rawBody.length > MAX_REQUEST_BODY_BYTES) {
            logger.warn("Payload size validation failed", { requestId, size: request.rawBody.length, status: 413 });
            sendError(response, 413, E.BAD_REQUEST, "Payload too large. Max 28MB allowed.", { creditRefunded: false });
            return false;
        }
        return true;
    };
}

/** Sync mode from the request body ('night' is an alias of 'evening'). */
function syncModeOf(body) {
    return sanitizeSyncType((body || {}).syncType);
}

/**
 * Validate the sync payload. Throws SyncError (400/401) on bad input.
 * Journal and voice notes need the Google token only when notes go to Google Drive.
 * @param {{ notesDestination?: 'drive'|'notion' }} [options]
 * @returns {{ parsedImages: object[], needsGoogle: boolean, googleToken: string|undefined, clientRequestId: string|null }}
 */
function parseSyncRequest(body, mode, { notesDestination = 'notion' } = {}) {
    if (!ALLOWED_SYNC_TYPES.has(mode)) {
        throw new SyncError(400, E.BAD_REQUEST, "Invalid syncType");
    }

    // Support backward compatibility for a single image, but standardize on array
    const rawImages = body.images || (body.imageData ? [body.imageData] : []);
    const parsedImages = parseImageDataArray(rawImages);
    if (!parsedImages || parsedImages.length === 0 || parsedImages.length > 5) {
        const claimsHeic = Array.isArray(rawImages) && rawImages.length <= 5
            && rawImages.some(img => typeof img === 'string' && HEIC_DATA_URL_RE.test(img));
        throw new SyncError(400, E.INVALID_IMAGE, claimsHeic
            ? HEIC_ERROR_MESSAGE
            : "Invalid image data format, size, or too many images (max 5).");
    }

    const needsGoogle = modeNeedsGoogle(mode, notesDestination);
    const googleToken = body.googleToken;
    if (needsGoogle && (!googleToken || typeof googleToken !== 'string')) {
        throw new SyncError(401, E.GOOGLE_TOKEN_EXPIRED, "Your Google connection expired. Reconnect Google to continue.");
    }
    const clientRequestId = isValidClientRequestId(body.clientRequestId) ? body.clientRequestId.toLowerCase() : null;

    return { parsedImages, needsGoogle, googleToken, clientRequestId };
}

module.exports = { payloadSizeCheck, syncModeOf, parseSyncRequest };

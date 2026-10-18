/**
 * Server-side HEIC/HEIF → JPEG conversion (C8). Runs in memory before credits
 * are deducted; converted buffers replace the originals so every later step
 * (AI, Notion uploads) only ever sees JPEG. Nothing is stored.
 */
const { logger } = require('firebase-functions/logger');
const { ERROR_CODES: E } = require('../services/requestGuard');
const { HEIF_MIME_TYPES, isHeifContainer } = require('../utils');
const { SyncError } = require('./errors');

const HEIC_JPEG_QUALITY = 0.85;
const DOWNSCALE_MAX_BYTES = 4 * 1024 * 1024;
const DOWNSCALE_MAX_WIDTH = 2560;
const HEIC_ERROR_MESSAGE = "We couldn't read this HEIC photo. Try exporting it as JPEG.";

let sharpModule;
/** sharp is optional: when it cannot be loaded, large conversions are left as they are. */
function loadSharp() {
    if (sharpModule === undefined) {
        try {
            sharpModule = require('sharp');
        } catch (err) {
            logger.warn("sharp unavailable; HEIC conversions will not be downscaled", { error: err?.message });
            sharpModule = null;
        }
    }
    return sharpModule;
}

/** Downscale a JPEG wider than 2560 px or larger than ~4 MB (no-op without sharp). */
async function downscaleJpegIfNeeded(jpeg, { sharp = loadSharp() } = {}) {
    if (!sharp) return jpeg;
    const { width } = await sharp(jpeg).metadata();
    if (jpeg.length <= DOWNSCALE_MAX_BYTES && !(width > DOWNSCALE_MAX_WIDTH)) return jpeg;
    return sharp(jpeg)
        .resize({ width: DOWNSCALE_MAX_WIDTH, withoutEnlargement: true })
        .jpeg({ quality: Math.round(HEIC_JPEG_QUALITY * 100), mozjpeg: true })
        .toBuffer();
}

/** Convert one validated HEIF buffer to a JPEG buffer. */
async function convertHeicToJpeg(buffer) {
    if (!isHeifContainer(buffer)) throw new Error('Not a HEIF container');
    const convert = require('heic-convert');
    const output = await convert({ buffer, format: 'JPEG', quality: HEIC_JPEG_QUALITY });
    return downscaleJpegIfNeeded(Buffer.from(output));
}

/**
 * Replace every HEIC/HEIF entry of `parsedImages` with its JPEG conversion.
 * Images are converted one at a time to bound peak memory.
 * @throws {SyncError} 400 INVALID_IMAGE when a photo cannot be decoded
 */
async function convertHeicImages(parsedImages, { requestId, uid } = {}) {
    if (!parsedImages.some(img => HEIF_MIME_TYPES.has(img.mimeType))) return parsedImages;
    const converted = [];
    for (const img of parsedImages) {
        if (!HEIF_MIME_TYPES.has(img.mimeType)) {
            converted.push(img);
            continue;
        }
        let jpeg;
        try {
            jpeg = await convertHeicToJpeg(Buffer.from(img.base64Data, 'base64'));
        } catch (err) {
            logger.warn("HEIC conversion failed", { requestId, uid, error: err?.message });
            throw new SyncError(400, E.INVALID_IMAGE, HEIC_ERROR_MESSAGE);
        }
        logger.info("Converted HEIC photo to JPEG", { requestId, uid, inBytes: img.decodedBytes, outBytes: jpeg.length });
        converted.push({ mimeType: 'image/jpeg', base64Data: jpeg.toString('base64'), decodedBytes: jpeg.length });
    }
    return converted;
}

module.exports = {
    HEIC_ERROR_MESSAGE,
    DOWNSCALE_MAX_BYTES,
    DOWNSCALE_MAX_WIDTH,
    convertHeicImages,
    convertHeicToJpeg,
    downscaleJpegIfNeeded,
};

/**
 * Utility functions extracted from index.js for testability.
 * These are imported by both index.js (for production) and __tests__/ (for testing).
 */

const crypto = require('crypto');

// --- CONSTANTS ---
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES * 1.37);
const ALLOWED_SYNC_TYPES = new Set(['morning', 'evening', 'night', 'journal']);
const ALLOWED_ORIGINS = new Set([
    'https://ai-planner-project-467800.web.app',
    'https://ai-planner-project-467800.firebaseapp.com',
    'http://localhost:5000',
    'http://127.0.0.1:5000',
    'https://planner.analogdigital.tech'
]);
const ALGORITHM = 'aes-256-gcm';
const LEGACY_ALGORITHM = 'aes-256-cbc';
const RATE_LIMIT_SYNC = 10;       // syncPlanner: 10 requests per window
const RATE_LIMIT_DEFAULT = 20;    // other endpoints: 20 requests per window
const RATE_LIMIT_WINDOW_MS = 60000; // 60-second sliding window

// --- CRYPTO ---
function deriveKey(rawKey) {
    if (!rawKey) throw new Error("Missing encryption key");
    return crypto.createHash('sha256').update(rawKey).digest();
}

function encrypt(text, key) {
    if (!text) return text;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `v2:${iv.toString('hex')}:${encrypted.toString('hex')}:${authTag.toString('hex')}`;
}

function decryptCurrentGcm(payload, key) {
    const textParts = payload.split(':');
    if (textParts.length !== 4 || textParts[0] !== 'v2') return null;

    const iv = Buffer.from(textParts[1], 'hex');
    const encryptedText = Buffer.from(textParts[2], 'hex');
    const authTag = Buffer.from(textParts[3], 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encryptedText), decipher.final()]);
    return decrypted.toString('utf8');
}

function decryptLegacyCbc(payload, key) {
    const textParts = payload.split(':');
    if (textParts.length !== 2) return null;

    const iv = Buffer.from(textParts[0], 'hex');
    const encryptedText = Buffer.from(textParts[1], 'hex');
    const decipher = crypto.createDecipheriv(LEGACY_ALGORITHM, key, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

function decryptStoredNotionKey(text, key) {
    if (!text) return text;
    try {
        if (text.startsWith('v2:')) {
            return { value: decryptCurrentGcm(text, key), needsMigration: false };
        }
        if (text.includes(':')) {
            return { value: decryptLegacyCbc(text, key), needsMigration: true };
        }
        // Plaintext leftover from older storage style.
        return { value: text, needsMigration: true };
    } catch (e) {
        return { value: null, needsMigration: false };
    }
}

// --- VALIDATION ---
function sanitizeSyncType(value) {
    const syncType = (typeof value === 'string' ? value : 'morning').toLowerCase();
    return syncType === 'night' ? 'evening' : syncType;
}

function parseImageDataUrl(imageData) {
    if (typeof imageData !== 'string') return null;
    if (imageData.length > MAX_BASE64_LENGTH) return null;

    const match = imageData.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return null;

    // Defense-in-depth: verify decoded byte size doesn't exceed limit
    const base64Str = match[2];
    const padding = (base64Str.endsWith('==') ? 2 : base64Str.endsWith('=') ? 1 : 0);
    const decodedBytes = Math.floor((base64Str.length * 3) / 4) - padding;
    if (decodedBytes > MAX_IMAGE_BYTES) return null;

    return {
        mimeType: match[1].toLowerCase(),
        base64Data: base64Str
    };
}

function parseImageDataArray(imagesArray) {
    if (!Array.isArray(imagesArray)) return null;
    if (imagesArray.length === 0 || imagesArray.length > 5) return null;

    const parsedImages = [];
    for (const imgStr of imagesArray) {
        const parsed = parseImageDataUrl(imgStr);
        if (!parsed) return null; // If any single image is invalid/too large, reject all
        parsedImages.push(parsed);
    }
    return parsedImages;
}

function normalizeNotionDbId(rawDbId) {
    if (typeof rawDbId !== 'string') return null;
    const cleaned = rawDbId.replace(/-/g, '').trim();
    return /^[a-f0-9]{32}$/i.test(cleaned) ? cleaned : null;
}

function isLikelyNotionKey(value) {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (trimmed.length < 20 || trimmed.length > 256) return false;
    return trimmed.startsWith('secret_');
}

function isJsonRequest(req) {
    const contentType = req.get('content-type') || '';
    return contentType.toLowerCase().includes('application/json');
}

// --- HTTP HELPERS ---
function setStandardHeaders(res) {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
}

function applyCors(req, res) {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (!ALLOWED_ORIGINS.has(origin)) return false;

    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    return true;
}

function handleOptions(req, res) {
    if (req.method !== 'OPTIONS') return false;
    if (!applyCors(req, res)) {
        res.status(403).send({ error: "Origin not allowed" });
        return true;
    }
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-byok-token, x-byok-provider, x-byok-model, x-byok-baseurl, x-byok-apiversion');
    res.status(204).send('');
    return true;
}

function validateTokenFormat(token) {
    if (typeof token !== 'string') return false;
    if (token.length < 20) return false;
    if (token.length > 5000) return false;
    return true;
}

function parseDateTime(timeString, dateString) {
    if (!timeString || !dateString) return null;

    timeString = String(timeString).trim();
    dateString = String(dateString).trim();

    // Support 24-hour and 12-hour formats
    const match = timeString.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i);
    if (!match) return null;

    let hours = parseInt(match[1]);
    const minutes = match[2] ? parseInt(match[2]) : 0;
    
    if (isNaN(hours) || hours < 0 || hours > 23) return null;
    if (minutes < 0 || minutes > 59) return null;

    const modifier = match[3] ? match[3].toUpperCase() : null;
    if (modifier) {
        if (hours < 1 || hours > 12) return null;
    }
    if (modifier === 'PM' && hours < 12) hours += 12;
    if (modifier === 'AM' && hours === 12) hours = 0;

    let year, month, day;
    const dateMatch = dateString.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateMatch) {
        year = parseInt(dateMatch[1]);
        month = parseInt(dateMatch[2]) - 1;
        day = parseInt(dateMatch[3]);
    } else {
        const tempDate = new Date(dateString);
        if (isNaN(tempDate.getTime())) return null;
        year = tempDate.getFullYear();
        month = tempDate.getMonth();
        day = tempDate.getDate();
    }

    const d = new Date(year, month, day);
    if (isNaN(d.getTime())) return null;

    d.setHours(hours, minutes, 0, 0);
    return d;
}

module.exports = {
    // Constants
    MAX_IMAGE_BYTES,
    MAX_BASE64_LENGTH,
    ALLOWED_SYNC_TYPES,
    ALLOWED_ORIGINS,
    ALGORITHM,
    LEGACY_ALGORITHM,
    RATE_LIMIT_SYNC,
    RATE_LIMIT_DEFAULT,
    RATE_LIMIT_WINDOW_MS,
    // Crypto
    deriveKey,
    encrypt,
    decryptCurrentGcm,
    decryptLegacyCbc,
    decryptStoredNotionKey,
    // Validation
    sanitizeSyncType,
    parseImageDataUrl,
    parseImageDataArray,
    normalizeNotionDbId,
    isLikelyNotionKey,
    isJsonRequest,
    parseDateTime,
    validateTokenFormat,
    // HTTP
    setStandardHeaders,
    applyCors,
    handleOptions,
};

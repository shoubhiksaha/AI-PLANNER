/**
 * Utility functions extracted from index.js for testability.
 * These are imported by both index.js (for production) and __tests__/ (for testing).
 */

const crypto = require('crypto');
const net = require('net');

// --- CONSTANTS ---
// Cloud Functions gen 2 rejects uncompressed HTTP requests above 32MB before
// application code runs. The client resizes images before upload; these caps are
// defense-in-depth for direct API calls and multi-image batches.
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 24 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES = 28 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES * 1.37);
const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_SYNC_TYPES = new Set(['morning', 'evening', 'night', 'journal']);
const ALLOWED_BYOK_PROVIDERS = new Set([
    'openai', 'anthropic', 'google', 'azure', 'cohere', 'huggingface',
    'groq', 'deepseek', 'mistral', 'perplexity', 'together',
    'openrouter', 'ollama', 'local'
]);
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

function hasExpectedImageSignature(mimeType, bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 4) return false;
    if (mimeType === 'image/jpeg') {
        return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    }
    if (mimeType === 'image/png') {
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        return bytes.length >= png.length && bytes.subarray(0, png.length).equals(png);
    }
    if (mimeType === 'image/webp') {
        return bytes.length >= 12
            && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
            && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
    }
    return false;
}

function parseImageDataUrl(imageData) {
    if (typeof imageData !== 'string') return null;
    if (imageData.length > MAX_BASE64_LENGTH) return null;

    const match = imageData.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return null;
    const mimeType = match[1].toLowerCase();
    if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) return null;

    // Defense-in-depth: verify decoded byte size doesn't exceed limit
    const base64Str = match[2];
    const padding = (base64Str.endsWith('==') ? 2 : base64Str.endsWith('=') ? 1 : 0);
    const decodedBytes = Math.floor((base64Str.length * 3) / 4) - padding;
    if (decodedBytes <= 0 || decodedBytes > MAX_IMAGE_BYTES) return null;

    let bytes;
    try {
        bytes = Buffer.from(base64Str, 'base64');
    } catch (_) {
        return null;
    }
    if (bytes.length !== decodedBytes || !hasExpectedImageSignature(mimeType, bytes)) return null;

    return {
        mimeType,
        base64Data: base64Str,
        decodedBytes
    };
}

function parseImageDataArray(imagesArray) {
    if (!Array.isArray(imagesArray)) return null;
    if (imagesArray.length === 0 || imagesArray.length > 5) return null;

    const parsedImages = [];
    let totalDecodedBytes = 0;
    for (const imgStr of imagesArray) {
        const parsed = parseImageDataUrl(imgStr);
        if (!parsed) return null; // If any single image is invalid/too large, reject all
        totalDecodedBytes += parsed.decodedBytes;
        if (totalDecodedBytes > MAX_TOTAL_IMAGE_BYTES) return null;
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
    // Shape check only; Notion token validity is confirmed via validateNotionCredentials.
    return trimmed.length >= 20 && trimmed.length <= 256;
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
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Firebase-AppCheck, x-byok-token, x-byok-provider, x-byok-model, x-byok-baseurl, x-byok-apiversion');
    res.status(204).send('');
    return true;
}

function validateTokenFormat(token) {
    if (typeof token !== 'string') return false;
    if (token.length < 20) return false;
    if (token.length > 5000) return false;
    return true;
}

function ipv4ToInt(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    const octets = parts.map(Number);
    if (octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    return (((octets[0] << 24) >>> 0)
        + (octets[1] << 16)
        + (octets[2] << 8)
        + octets[3]) >>> 0;
}

function ipv4InCidr(ip, network, prefix) {
    const value = ipv4ToInt(ip);
    const base = ipv4ToInt(network);
    if (value === null || base === null) return false;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (value & mask) === (base & mask);
}

function parseIpv6ToBigInt(input) {
    let ip = input.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
    if (ip.includes('.')) {
        const lastColon = ip.lastIndexOf(':');
        const ipv4 = ip.slice(lastColon + 1);
        const value = ipv4ToInt(ipv4);
        if (value === null) return null;
        ip = `${ip.slice(0, lastColon)}:${((value >>> 16) & 0xffff).toString(16)}:${(value & 0xffff).toString(16)}`;
    }

    const halves = ip.split('::');
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
    const groups = [...left, ...Array(missing).fill('0'), ...right];
    if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return null;

    return groups.reduce((acc, group) => (acc << 16n) + BigInt(parseInt(group, 16)), 0n);
}

function ipv6InCidr(ip, network, prefix) {
    const value = parseIpv6ToBigInt(ip);
    const base = parseIpv6ToBigInt(network);
    if (value === null || base === null) return false;
    const shift = 128n - BigInt(prefix);
    return (value >> shift) === (base >> shift);
}

function isPrivateOrReservedIp(rawIp) {
    const ip = String(rawIp || '').replace(/^\[|\]$/g, '').split('%')[0];
    const family = net.isIP(ip);
    if (family === 4) {
        const blocked = [
            ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
            ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
            ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
            ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
            ['224.0.0.0', 4], ['240.0.0.0', 4]
        ];
        return blocked.some(([network, prefix]) => ipv4InCidr(ip, network, prefix));
    }
    if (family === 6) {
        const mapped = parseIpv6ToBigInt(ip);
        const mappedPrefix = parseIpv6ToBigInt('::ffff:0:0');
        if (mapped !== null && mappedPrefix !== null && (mapped >> 32n) === (mappedPrefix >> 32n)) {
            const value = Number(mapped & 0xffffffffn);
            const ipv4 = `${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`;
            return isPrivateOrReservedIp(ipv4);
        }
        const blocked = [
            ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64],
            ['2001:db8::', 32], ['2001:10::', 28], ['fc00::', 7],
            ['fe80::', 10], ['ff00::', 8]
        ];
        return blocked.some(([network, prefix]) => ipv6InCidr(ip, network, prefix));
    }
    return true;
}

function validateBYOKBaseUrl(value) {
    if (typeof value !== 'string' || value.length < 8 || value.length > 2048) {
        return { valid: false, error: 'Base URL must be between 8 and 2048 characters.' };
    }
    try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'https:') return { valid: false, error: 'Base URL must use HTTPS.' };
        if (parsed.username || parsed.password) return { valid: false, error: 'Base URL credentials are not allowed.' };
        if (parsed.hash) return { valid: false, error: 'Base URL fragments are not allowed.' };
        if (parsed.port && parsed.port !== '443') return { valid: false, error: 'Only HTTPS port 443 is allowed.' };
        const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        if (
            !hostname
            || hostname === 'localhost'
            || hostname === 'metadata.google.internal'
            || hostname.endsWith('.localhost')
            || hostname.endsWith('.local')
            || hostname.endsWith('.internal')
        ) {
            return { valid: false, error: 'Internal or reserved hostnames are not allowed.' };
        }
        if (net.isIP(hostname) && isPrivateOrReservedIp(hostname)) {
            return { valid: false, error: 'Private or reserved IP addresses are not allowed.' };
        }
        parsed.port = '';
        return { valid: true, url: parsed.toString() };
    } catch (_) {
        return { valid: false, error: 'Base URL is invalid.' };
    }
}

function validateBYOKConfig({ apiKey, provider, modelName, baseUrl, apiVersion } = {}, { allowCustomUrl = false } = {}) {
    const normalizedApiKey = typeof apiKey === 'string' ? apiKey.trim() : apiKey;
    if (!validateTokenFormat(normalizedApiKey)) return { valid: false, error: 'API key format is invalid.' };

    const normalizedProvider = typeof provider === 'string' ? provider.trim().toLowerCase() : 'openai';
    if (!ALLOWED_BYOK_PROVIDERS.has(normalizedProvider)) {
        return { valid: false, error: 'AI provider is not supported.' };
    }

    const normalizedModel = typeof modelName === 'string' ? modelName.trim() : '';
    if (!normalizedModel || normalizedModel.length > 200 || !/^[a-zA-Z0-9._:/-]+$/.test(normalizedModel)) {
        return { valid: false, error: 'Model name format is invalid.' };
    }

    let normalizedBaseUrl;
    if (baseUrl) {
        if (!allowCustomUrl) return { valid: false, error: 'Custom BYOK URLs are disabled.' };
        const urlCheck = validateBYOKBaseUrl(String(baseUrl).trim());
        if (!urlCheck.valid) return urlCheck;
        normalizedBaseUrl = urlCheck.url;
    }
    if (!normalizedBaseUrl && ['azure', 'ollama', 'local'].includes(normalizedProvider)) {
        return { valid: false, error: 'This provider requires a custom BYOK base URL.' };
    }

    let normalizedApiVersion;
    if (apiVersion) {
        normalizedApiVersion = String(apiVersion).trim();
        if (normalizedApiVersion.length > 64 || !/^[a-zA-Z0-9.-]+$/.test(normalizedApiVersion)) {
            return { valid: false, error: 'API version format is invalid.' };
        }
    }

    return {
        valid: true,
        config: {
            apiKey: normalizedApiKey,
            provider: normalizedProvider,
            modelName: normalizedModel,
            ...(normalizedBaseUrl ? { baseUrl: normalizedBaseUrl } : {}),
            ...(normalizedApiVersion ? { apiVersion: normalizedApiVersion } : {})
        }
    };
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

/** Calendar-day delta between two YYYY-MM-DD strings (local-date math, DST-safe). */
function calendarDayDiff(fromDateStr, toDateStr) {
    const fromParts = fromDateStr.split('-').map(Number);
    const toParts = toDateStr.split('-').map(Number);
    const fromDate = new Date(fromParts[0], fromParts[1] - 1, fromParts[2]);
    const toDate = new Date(toParts[0], toParts[1] - 1, toParts[2]);
    return Math.round((toDate - fromDate) / (1000 * 60 * 60 * 24));
}

const SYNC_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Coerce Firestore/client lastSyncDate values to YYYY-MM-DD in the user's timezone. */
function normalizeSyncDateStr(value, timeZone) {
    if (value == null || value === '') return null;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (SYNC_DATE_RE.test(trimmed)) return trimmed;
        const parsed = new Date(trimmed);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed.toLocaleDateString('en-CA', { timeZone });
        }
        const isoDay = trimmed.slice(0, 10);
        return SYNC_DATE_RE.test(isoDay) ? isoDay : null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return new Date(value).toLocaleDateString('en-CA', { timeZone });
    }
    if (typeof value === 'object') {
        if (typeof value.toDate === 'function') {
            return value.toDate().toLocaleDateString('en-CA', { timeZone });
        }
        if (typeof value.seconds === 'number') {
            return new Date(value.seconds * 1000).toLocaleDateString('en-CA', { timeZone });
        }
    }
    return null;
}

/**
 * Effective streak for display when the user has not synced recently.
 * Streak is only written to Firestore on sync; without this, a stored value
 * of 3 would show forever until the next sync even after weeks of inactivity.
 * Returns 0 when the streak has lapsed (missed days exceed available freezes).
 * Returns stored currentStreak while still within grace (synced yesterday or today).
 */
function computeDisplayStreak(userData, todayStr) {
    const storedStreak = userData.currentStreak || 0;
    const streakFreezes = userData.streakFreezes || 0;
    const timeZone = userData.timeZone || 'Asia/Kolkata';

    if (storedStreak === 0) return 0;

    const lastSyncDateStr = normalizeSyncDateStr(userData.lastSyncDate, timeZone);
    if (!lastSyncDateStr) return 0;

    const today = todayStr || new Date().toLocaleDateString('en-CA', { timeZone });
    const diffDays = calendarDayDiff(lastSyncDateStr, today);

    // Future or corrupt dates must not preserve a stale stored streak forever.
    if (!Number.isFinite(diffDays) || diffDays < 0) return 0;

    if (diffDays <= 1) return storedStreak;

    const daysMissed = diffDays - 1;
    if (streakFreezes >= daysMissed) return storedStreak;

    return 0;
}

module.exports = {
    // Constants
    MAX_IMAGE_BYTES,
    MAX_TOTAL_IMAGE_BYTES,
    MAX_REQUEST_BODY_BYTES,
    MAX_BASE64_LENGTH,
    ALLOWED_IMAGE_MIME_TYPES,
    ALLOWED_SYNC_TYPES,
    ALLOWED_BYOK_PROVIDERS,
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
    validateBYOKBaseUrl,
    validateBYOKConfig,
    isPrivateOrReservedIp,
    calendarDayDiff,
    normalizeSyncDateStr,
    computeDisplayStreak,
    // HTTP
    setStandardHeaders,
    applyCors,
    handleOptions,
};

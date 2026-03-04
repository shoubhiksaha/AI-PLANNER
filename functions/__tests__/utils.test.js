/**
 * Unit tests for AI Planner Cloud Functions utilities.
 * Run: cd functions && npm test
 */

const {
    deriveKey,
    encrypt,
    decryptCurrentGcm,
    decryptLegacyCbc,
    decryptStoredNotionKey,
    sanitizeSyncType,
    parseImageDataUrl,
    normalizeNotionDbId,
    isLikelyNotionKey,
    isJsonRequest,
    setStandardHeaders,
    applyCors,
    handleOptions,
    validateTokenFormat,
    parseDateTime,
    MAX_IMAGE_BYTES,
    MAX_BASE64_LENGTH,
    ALLOWED_ORIGINS,
    ALLOWED_SYNC_TYPES,
} = require('../utils');

// Shared test key (32 bytes from hashing a test secret)
const TEST_SECRET = 'test-encryption-key-for-jest';
const testKey = deriveKey(TEST_SECRET);

// ============================================
// ENCRYPTION / DECRYPTION
// ============================================
describe('Encryption', () => {
    test('deriveKey produces a 32-byte Buffer', () => {
        const key = deriveKey('any-secret');
        expect(Buffer.isBuffer(key)).toBe(true);
        expect(key.length).toBe(32);
    });

    test('deriveKey throws on empty/null input', () => {
        expect(() => deriveKey('')).toThrow('Missing encryption key');
        expect(() => deriveKey(null)).toThrow();
        expect(() => deriveKey(undefined)).toThrow();
    });

    test('deriveKey is deterministic (same input = same key)', () => {
        const key1 = deriveKey('my-secret');
        const key2 = deriveKey('my-secret');
        expect(key1.equals(key2)).toBe(true);
    });

    test('encrypt returns v2 format string', () => {
        const encrypted = encrypt('secret_abc123', testKey);
        expect(encrypted).toMatch(/^v2:[a-f0-9]+:[a-f0-9]+:[a-f0-9]+$/);
    });

    test('encrypt returns falsy for empty/null input', () => {
        expect(encrypt('', testKey)).toBeFalsy();
        expect(encrypt(null, testKey)).toBeFalsy();
        expect(encrypt(undefined, testKey)).toBeFalsy();
    });

    test('encrypt produces unique ciphertext each time (random IV)', () => {
        const e1 = encrypt('same-text', testKey);
        const e2 = encrypt('same-text', testKey);
        expect(e1).not.toBe(e2); // Different IVs = different output
    });

    test('encrypt → decryptCurrentGcm roundtrip', () => {
        const original = 'secret_MyN0tionKey123456789';
        const encrypted = encrypt(original, testKey);
        const decrypted = decryptCurrentGcm(encrypted, testKey);
        expect(decrypted).toBe(original);
    });

    test('decryptCurrentGcm rejects wrong key', () => {
        const encrypted = encrypt('secret_test', testKey);
        const wrongKey = deriveKey('wrong-key');
        expect(() => decryptCurrentGcm(encrypted, wrongKey)).toThrow();
    });

    test('decryptCurrentGcm returns null for invalid format', () => {
        expect(decryptCurrentGcm('not-encrypted', testKey)).toBe(null);
        expect(decryptCurrentGcm('v1:abc:def:ghi', testKey)).toBe(null);
        expect(decryptCurrentGcm('v2:only-two-parts', testKey)).toBe(null);
    });

    test('decryptCurrentGcm rejects tampered ciphertext', () => {
        const encrypted = encrypt('secret_test', testKey);
        const parts = encrypted.split(':');
        // Tamper with the encrypted data
        parts[2] = parts[2].replace(/^./, 'f');
        const tampered = parts.join(':');
        expect(() => decryptCurrentGcm(tampered, testKey)).toThrow();
    });
});

// ============================================
// DECRYPT STORED NOTION KEY (Migration Logic)
// ============================================
describe('decryptStoredNotionKey', () => {
    test('decrypts v2 (GCM) encrypted keys', () => {
        const encrypted = encrypt('secret_mykey123456789', testKey);
        const result = decryptStoredNotionKey(encrypted, testKey);
        expect(result.value).toBe('secret_mykey123456789');
        expect(result.needsMigration).toBe(false);
    });

    test('returns plaintext with needsMigration=true for unencrypted keys', () => {
        const result = decryptStoredNotionKey('secret_plaintext_old_key', testKey);
        expect(result.value).toBe('secret_plaintext_old_key');
        expect(result.needsMigration).toBe(true);
    });

    test('returns falsy for null/undefined/empty', () => {
        expect(decryptStoredNotionKey(null, testKey)).toBeFalsy();
        expect(decryptStoredNotionKey(undefined, testKey)).toBeFalsy();
        expect(decryptStoredNotionKey('', testKey)).toBeFalsy();
    });

    test('returns value=null for corrupted encrypted data', () => {
        const result = decryptStoredNotionKey('v2:bad:data:here', testKey);
        expect(result.value).toBe(null);
        expect(result.needsMigration).toBe(false);
    });
});

// ============================================
// SYNC TYPE VALIDATION
// ============================================
describe('sanitizeSyncType', () => {
    test('returns valid sync types unchanged', () => {
        expect(sanitizeSyncType('morning')).toBe('morning');
        expect(sanitizeSyncType('evening')).toBe('evening');
        expect(sanitizeSyncType('journal')).toBe('journal');
    });

    test('maps "night" to "evening"', () => {
        expect(sanitizeSyncType('night')).toBe('evening');
        expect(sanitizeSyncType('Night')).toBe('evening');
        expect(sanitizeSyncType('NIGHT')).toBe('evening');
    });

    test('lowercases input', () => {
        expect(sanitizeSyncType('MORNING')).toBe('morning');
        expect(sanitizeSyncType('Journal')).toBe('journal');
    });

    test('defaults to "morning" for non-string inputs', () => {
        expect(sanitizeSyncType(null)).toBe('morning');
        expect(sanitizeSyncType(undefined)).toBe('morning');
        expect(sanitizeSyncType(123)).toBe('morning');
        expect(sanitizeSyncType({})).toBe('morning');
    });
});

// ============================================
// IMAGE DATA URL PARSING
// ============================================
describe('parseImageDataUrl', () => {
    const validJpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
    const validPng = 'data:image/png;base64,iVBORw0KGgo=';

    test('parses valid JPEG data URL', () => {
        const result = parseImageDataUrl(validJpeg);
        expect(result).not.toBeNull();
        expect(result.mimeType).toBe('image/jpeg');
        expect(result.base64Data).toBe('/9j/4AAQSkZJRg==');
    });

    test('parses valid PNG data URL', () => {
        const result = parseImageDataUrl(validPng);
        expect(result).not.toBeNull();
        expect(result.mimeType).toBe('image/png');
    });

    test('returns null for non-string input', () => {
        expect(parseImageDataUrl(null)).toBeNull();
        expect(parseImageDataUrl(123)).toBeNull();
        expect(parseImageDataUrl(undefined)).toBeNull();
    });

    test('returns null for invalid format', () => {
        expect(parseImageDataUrl('not-a-data-url')).toBeNull();
        expect(parseImageDataUrl('data:text/plain;base64,abc')).toBeNull();
        expect(parseImageDataUrl('')).toBeNull();
    });

    test('returns null for oversized data', () => {
        // Create a string longer than MAX_BASE64_LENGTH
        const huge = 'data:image/jpeg;base64,' + 'A'.repeat(MAX_IMAGE_BYTES * 2);
        expect(parseImageDataUrl(huge)).toBeNull();
    });
});

// ============================================
// NOTION DATABASE ID NORMALIZATION
// ============================================
describe('normalizeNotionDbId', () => {
    test('accepts valid 32-char hex ID', () => {
        expect(normalizeNotionDbId('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBe('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6');
    });

    test('strips dashes from UUID-format IDs', () => {
        const withDashes = 'a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d6';
        expect(normalizeNotionDbId(withDashes)).toBe('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6');
    });

    test('accepts uppercase hex', () => {
        expect(normalizeNotionDbId('A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6')).toBe('A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6');
    });

    test('returns null for invalid IDs', () => {
        expect(normalizeNotionDbId('too-short')).toBeNull();
        expect(normalizeNotionDbId('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toBeNull(); // non-hex
        expect(normalizeNotionDbId('')).toBeNull();
    });

    test('returns null for non-string input', () => {
        expect(normalizeNotionDbId(null)).toBeNull();
        expect(normalizeNotionDbId(123)).toBeNull();
        expect(normalizeNotionDbId(undefined)).toBeNull();
    });
});

// ============================================
// NOTION KEY VALIDATION
// ============================================
describe('isLikelyNotionKey', () => {
    test('accepts valid Notion keys', () => {
        expect(isLikelyNotionKey('secret_abcdefghijklmnop')).toBe(true);
        expect(isLikelyNotionKey('secret_1234567890abcdef1234')).toBe(true);
    });

    test('rejects keys that do not start with "secret_"', () => {
        expect(isLikelyNotionKey('notsecret_abcdefghijklmnop')).toBe(false);
        expect(isLikelyNotionKey('ABCDEFGHIJKLMNOPQRSTUVWXYZ')).toBe(false);
    });

    test('rejects keys that are too short', () => {
        expect(isLikelyNotionKey('secret_abc')).toBe(false); // < 20 chars total
    });

    test('rejects keys that are too long', () => {
        expect(isLikelyNotionKey('secret_' + 'a'.repeat(300))).toBe(false); // > 256 chars
    });

    test('rejects non-string input', () => {
        expect(isLikelyNotionKey(null)).toBe(false);
        expect(isLikelyNotionKey(123)).toBe(false);
        expect(isLikelyNotionKey(undefined)).toBe(false);
    });

    test('trims whitespace before checking', () => {
        expect(isLikelyNotionKey('  secret_abcdefghijklmnop  ')).toBe(true);
    });
});

// ============================================
// JSON REQUEST CHECK
// ============================================
describe('isJsonRequest', () => {
    const mockReq = (contentType) => ({
        get: (header) => header === 'content-type' ? contentType : null
    });

    test('returns true for application/json', () => {
        expect(isJsonRequest(mockReq('application/json'))).toBe(true);
    });

    test('returns true for application/json with charset', () => {
        expect(isJsonRequest(mockReq('application/json; charset=utf-8'))).toBe(true);
    });

    test('returns true regardless of case', () => {
        expect(isJsonRequest(mockReq('Application/JSON'))).toBe(true);
    });

    test('returns false for other content types', () => {
        expect(isJsonRequest(mockReq('text/html'))).toBe(false);
        expect(isJsonRequest(mockReq('multipart/form-data'))).toBe(false);
    });

    test('returns false when content-type is missing', () => {
        expect(isJsonRequest(mockReq(null))).toBe(false);
        expect(isJsonRequest(mockReq(undefined))).toBe(false);
    });
});

// ============================================
// HTTP HELPERS
// ============================================
describe('setStandardHeaders', () => {
    test('sets Cache-Control and X-Content-Type-Options', () => {
        const headers = {};
        const mockRes = { set: (k, v) => { headers[k] = v; } };
        setStandardHeaders(mockRes);
        expect(headers['Cache-Control']).toBe('no-store');
        expect(headers['X-Content-Type-Options']).toBe('nosniff');
    });
});

describe('applyCors', () => {
    const mockReqRes = (origin) => {
        const headers = {};
        return {
            req: { headers: { origin } },
            res: { set: (k, v) => { headers[k] = v; } },
            headers
        };
    };

    test('returns true and sets headers for allowed origins', () => {
        const { req, res, headers } = mockReqRes('https://ai-planner-project-467800.web.app');
        expect(applyCors(req, res)).toBe(true);
        expect(headers['Access-Control-Allow-Origin']).toBe('https://ai-planner-project-467800.web.app');
        expect(headers['Vary']).toBe('Origin');
    });

    test('returns true when no origin header (same-origin request)', () => {
        const { req, res } = mockReqRes(undefined);
        expect(applyCors(req, res)).toBe(true);
    });

    test('returns false for disallowed origins', () => {
        const { req, res } = mockReqRes('https://evil-site.com');
        expect(applyCors(req, res)).toBe(false);
    });

    test('localhost origins are allowed', () => {
        const { req, res } = mockReqRes('http://localhost:5000');
        expect(applyCors(req, res)).toBe(true);
    });

    test('firebaseapp.com origin is allowed', () => {
        const { req, res } = mockReqRes('https://ai-planner-project-467800.firebaseapp.com');
        expect(applyCors(req, res)).toBe(true);
    });

    test('127.0.0.1 origin is allowed', () => {
        const { req, res } = mockReqRes('http://127.0.0.1:5000');
        expect(applyCors(req, res)).toBe(true);
    });

    test('rejects localhost on wrong port', () => {
        const { req, res } = mockReqRes('http://localhost:3000');
        expect(applyCors(req, res)).toBe(false);
    });
});

// ============================================
// HANDLE OPTIONS (CORS PREFLIGHT)
// ============================================
describe('handleOptions', () => {
    const createMockReqRes = (method, origin) => {
        const headers = {};
        let statusCode = null;
        let body = null;
        const res = {
            set: (k, v) => { headers[k] = v; },
            status: (code) => { statusCode = code; return res; },
            send: (data) => { body = data; }
        };
        const req = { method, headers: { origin } };
        return { req, res, headers, getStatus: () => statusCode, getBody: () => body };
    };

    test('returns false for non-OPTIONS requests', () => {
        const { req, res } = createMockReqRes('POST', 'https://ai-planner-project-467800.web.app');
        expect(handleOptions(req, res)).toBe(false);
    });

    test('returns false for GET requests', () => {
        const { req, res } = createMockReqRes('GET', 'https://ai-planner-project-467800.web.app');
        expect(handleOptions(req, res)).toBe(false);
    });

    test('handles OPTIONS from allowed origin with 204', () => {
        const { req, res, headers, getStatus } = createMockReqRes('OPTIONS', 'https://ai-planner-project-467800.web.app');
        expect(handleOptions(req, res)).toBe(true);
        expect(getStatus()).toBe(204);
        expect(headers['Access-Control-Allow-Methods']).toBe('POST, OPTIONS');
        expect(headers['Access-Control-Allow-Headers']).toBe('Content-Type, Authorization');
    });

    test('rejects OPTIONS from disallowed origin with 403', () => {
        const { req, res, getStatus, getBody } = createMockReqRes('OPTIONS', 'https://evil.com');
        expect(handleOptions(req, res)).toBe(true);
        expect(getStatus()).toBe(403);
        expect(getBody()).toEqual({ error: "Origin not allowed" });
    });
});

// ============================================
// VALIDATE TOKEN FORMAT
// ============================================
describe('validateTokenFormat', () => {
    test('accepts valid token strings', () => {
        expect(validateTokenFormat('a'.repeat(20))).toBe(true);
        expect(validateTokenFormat('a'.repeat(100))).toBe(true);
        expect(validateTokenFormat('a'.repeat(5000))).toBe(true);
    });

    test('rejects tokens that are too short', () => {
        expect(validateTokenFormat('short')).toBe(false);
        expect(validateTokenFormat('a'.repeat(19))).toBe(false);
    });

    test('rejects tokens that are too long', () => {
        expect(validateTokenFormat('a'.repeat(5001))).toBe(false);
    });

    test('rejects non-string inputs', () => {
        expect(validateTokenFormat(null)).toBe(false);
        expect(validateTokenFormat(undefined)).toBe(false);
        expect(validateTokenFormat(12345678901234567890)).toBe(false);
        expect(validateTokenFormat({})).toBe(false);
        expect(validateTokenFormat([])).toBe(false);
    });
});

// ============================================
// CONSTANTS VERIFICATION
// ============================================
describe('Constants', () => {
    test('MAX_IMAGE_BYTES is 20MB', () => {
        expect(MAX_IMAGE_BYTES).toBe(20 * 1024 * 1024);
    });

    test('MAX_BASE64_LENGTH accounts for ~37% base64 overhead', () => {
        expect(MAX_BASE64_LENGTH).toBe(Math.ceil(MAX_IMAGE_BYTES * 1.37));
    });

    test('ALLOWED_SYNC_TYPES contains all expected types', () => {
        expect(ALLOWED_SYNC_TYPES.has('morning')).toBe(true);
        expect(ALLOWED_SYNC_TYPES.has('evening')).toBe(true);
        expect(ALLOWED_SYNC_TYPES.has('night')).toBe(true);
        expect(ALLOWED_SYNC_TYPES.has('journal')).toBe(true);
        expect(ALLOWED_SYNC_TYPES.size).toBe(4);
    });

    test('ALLOWED_ORIGINS contains production and dev origins', () => {
        expect(ALLOWED_ORIGINS.has('https://ai-planner-project-467800.web.app')).toBe(true);
        expect(ALLOWED_ORIGINS.has('https://ai-planner-project-467800.firebaseapp.com')).toBe(true);
        expect(ALLOWED_ORIGINS.has('http://localhost:5000')).toBe(true);
        expect(ALLOWED_ORIGINS.has('http://127.0.0.1:5000')).toBe(true);
        expect(ALLOWED_ORIGINS.size).toBe(4);
    });
});

// ============================================
// ENCRYPTION EDGE CASES
// ============================================
describe('Encryption Edge Cases', () => {
    test('handles Unicode text (emoji, CJK characters)', () => {
        const unicode = '🔑 Notion密钥 키 مفتاح';
        const encrypted = encrypt(unicode, testKey);
        const decrypted = decryptCurrentGcm(encrypted, testKey);
        expect(decrypted).toBe(unicode);
    });

    test('handles very long text', () => {
        const longText = 'secret_' + 'x'.repeat(500);
        const encrypted = encrypt(longText, testKey);
        const decrypted = decryptCurrentGcm(encrypted, testKey);
        expect(decrypted).toBe(longText);
    });

    test('handles special characters in keys', () => {
        const special = 'secret_key+with/special=chars&more!@#$%';
        const encrypted = encrypt(special, testKey);
        const decrypted = decryptCurrentGcm(encrypted, testKey);
        expect(decrypted).toBe(special);
    });

    test('legacy CBC encrypt → decrypt roundtrip', () => {
        // Manually create a CBC-encrypted payload for testing migration
        const crypto = require('crypto');
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', testKey, iv);
        let encrypted = cipher.update('secret_legacy_key_12345', 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const payload = iv.toString('hex') + ':' + encrypted;

        const decrypted = decryptLegacyCbc(payload, testKey);
        expect(decrypted).toBe('secret_legacy_key_12345');
    });

    test('decryptLegacyCbc returns null for wrong format', () => {
        expect(decryptLegacyCbc('no-colon-here-at-all', testKey)).toBe(null);
        expect(decryptLegacyCbc('part1:part2:part3', testKey)).toBe(null);
    });

    test('decryptStoredNotionKey detects CBC format and marks for migration', () => {
        const crypto = require('crypto');
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', testKey, iv);
        let encrypted = cipher.update('secret_oldkey_123456', 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const payload = iv.toString('hex') + ':' + encrypted;

        const result = decryptStoredNotionKey(payload, testKey);
        expect(result.value).toBe('secret_oldkey_123456');
        expect(result.needsMigration).toBe(true);
    });
});

// ============================================
// PARSE IMAGE DATA URL - ADDITIONAL MIME TYPES
// ============================================
describe('parseImageDataUrl - Mime Types', () => {
    test('parses HEIC data URL', () => {
        const result = parseImageDataUrl('data:image/heic;base64,AAAA');
        expect(result).not.toBeNull();
        expect(result.mimeType).toBe('image/heic');
    });

    test('parses WebP data URL', () => {
        const result = parseImageDataUrl('data:image/webp;base64,AAAA');
        expect(result).not.toBeNull();
        expect(result.mimeType).toBe('image/webp');
    });

    test('parses SVG+XML data URL', () => {
        const result = parseImageDataUrl('data:image/svg+xml;base64,PHN2Zz4=');
        expect(result).not.toBeNull();
        expect(result.mimeType).toBe('image/svg+xml');
    });

    test('normalizes uppercase mime type', () => {
        const result = parseImageDataUrl('data:image/JPEG;base64,AAAA');
        expect(result).not.toBeNull();
        expect(result.mimeType).toBe('image/jpeg');
    });

    test('rejects video mime types', () => {
        expect(parseImageDataUrl('data:video/mp4;base64,AAAA')).toBeNull();
    });

    test('rejects application mime types', () => {
        expect(parseImageDataUrl('data:application/pdf;base64,AAAA')).toBeNull();
    });
});

// ============================================
// NOTION KEY - ADDITIONAL EDGE CASES
// ============================================
describe('isLikelyNotionKey - Edge Cases', () => {
    test('accepts key at exactly 20 chars', () => {
        expect(isLikelyNotionKey('secret_abcdefghijk')).toBe(false); // 18 chars
        expect(isLikelyNotionKey('secret_abcdefghijklm')).toBe(true); // 20 chars
    });

    test('accepts key at exactly 256 chars', () => {
        const key256 = 'secret_' + 'a'.repeat(249);
        expect(key256.length).toBe(256);
        expect(isLikelyNotionKey(key256)).toBe(true);
    });

    test('rejects key at 257 chars', () => {
        const key257 = 'secret_' + 'a'.repeat(250);
        expect(key257.length).toBe(257);
        expect(isLikelyNotionKey(key257)).toBe(false);
    });
});

// ============================================
// NOTION DB ID - ADDITIONAL EDGE CASES
// ============================================
describe('normalizeNotionDbId - Edge Cases', () => {
    test('handles IDs with mixed casing', () => {
        const mixedCase = 'aAbBcCdD-eEfF-1122-3344-556677889900';
        const result = normalizeNotionDbId(mixedCase);
        expect(result).toBe('aAbBcCdDeEfF11223344556677889900');
    });

    test('rejects IDs with spaces in the middle', () => {
        expect(normalizeNotionDbId('a1b2c3d4 e5f6a7b8c9d0e1f2a3b4c5d6')).toBeNull();
    });

    test('rejects IDs that are 31 chars', () => {
        expect(normalizeNotionDbId('a'.repeat(31))).toBeNull();
    });

    test('rejects IDs that are 33 chars', () => {
        expect(normalizeNotionDbId('a'.repeat(33))).toBeNull();
    });
});

// ============================================
// PARSE DATE TIME (Bug fix verification)
// ============================================
describe('parseDateTime', () => {
    const testDate = '6-August-2025';

    // --- Standard AM/PM ---
    test('parses "9 AM" correctly', () => {
        const result = parseDateTime('9 AM', testDate);
        expect(result).not.toBeNull();
        expect(result.getHours()).toBe(9);
        expect(result.getMinutes()).toBe(0);
    });

    test('parses "12 PM" (noon) correctly', () => {
        const result = parseDateTime('12 PM', testDate);
        expect(result).not.toBeNull();
        expect(result.getHours()).toBe(12);
    });

    test('parses "12 AM" (midnight) correctly', () => {
        const result = parseDateTime('12 AM', testDate);
        expect(result).not.toBeNull();
        expect(result.getHours()).toBe(0);
    });

    test('parses "1 PM" correctly (13:00)', () => {
        const result = parseDateTime('1 PM', testDate);
        expect(result).not.toBeNull();
        expect(result.getHours()).toBe(13);
    });

    test('parses "11 PM" correctly (23:00)', () => {
        const result = parseDateTime('11 PM', testDate);
        expect(result).not.toBeNull();
        expect(result.getHours()).toBe(23);
    });

    // --- Bug fix: minute-format inputs ---
    test('parses "9:30 AM" correctly (preserves minutes)', () => {
        const result = parseDateTime('9:30 AM', testDate);
        expect(result).not.toBeNull();
        expect(result.getHours()).toBe(9);
        expect(result.getMinutes()).toBe(30);
    });

    test('parses "12:45 PM" correctly (preserves minutes)', () => {
        const result = parseDateTime('12:45 PM', testDate);
        expect(result).not.toBeNull();
        expect(result.getHours()).toBe(12);
        expect(result.getMinutes()).toBe(45);
    });

    test('parses "6:00 PM" correctly', () => {
        const result = parseDateTime('6:00 PM', testDate);
        expect(result).not.toBeNull();
        expect(result.getHours()).toBe(18);
        expect(result.getMinutes()).toBe(0);
    });

    // --- Case insensitivity ---
    test('handles lowercase am/pm', () => {
        expect(parseDateTime('9 am', testDate).getHours()).toBe(9);
        expect(parseDateTime('3 pm', testDate).getHours()).toBe(15);
    });

    test('handles mixed case Am/Pm', () => {
        expect(parseDateTime('9 Am', testDate).getHours()).toBe(9);
        expect(parseDateTime('3 Pm', testDate).getHours()).toBe(15);
    });

    // --- Invalid inputs ---
    test('returns null for null/undefined inputs', () => {
        expect(parseDateTime(null, testDate)).toBeNull();
        expect(parseDateTime('9 AM', null)).toBeNull();
        expect(parseDateTime(null, null)).toBeNull();
        expect(parseDateTime(undefined, undefined)).toBeNull();
    });

    test('returns null for invalid time formats', () => {
        expect(parseDateTime('nine AM', testDate)).toBeNull();
        expect(parseDateTime('25:00', testDate)).toBeNull();
        expect(parseDateTime('', testDate)).toBeNull();
    });

    test('returns null for hour 0 (invalid in 12-hour format)', () => {
        expect(parseDateTime('0 AM', testDate)).toBeNull();
    });

    test('returns null for hour 13+ (invalid in 12-hour format)', () => {
        expect(parseDateTime('13 PM', testDate)).toBeNull();
        expect(parseDateTime('99 AM', testDate)).toBeNull();
    });

    test('returns null for invalid date strings', () => {
        expect(parseDateTime('9 AM', 'not-a-date')).toBeNull();
        expect(parseDateTime('9 AM', 'abcdefg')).toBeNull();
    });

    // --- Whitespace handling ---
    test('trims whitespace from inputs', () => {
        const result = parseDateTime('  9 AM  ', '  6-August-2025  ');
        expect(result).not.toBeNull();
        expect(result.getHours()).toBe(9);
    });

    // --- Date object correctness ---
    test('sets correct date from date string', () => {
        const result = parseDateTime('9 AM', '15-January-2026');
        expect(result).not.toBeNull();
        expect(result.getFullYear()).toBe(2026);
        expect(result.getMonth()).toBe(0); // January = 0
        expect(result.getDate()).toBe(15);
    });

    // --- Audit Report Section A: Edge cases ---
    test('returns null for invalid minutes (9:60 AM)', () => {
        expect(parseDateTime('9:60 AM', testDate)).toBeNull();
    });

    test('parses "9:05 AM" correctly (5 minutes)', () => {
        const result = parseDateTime('9:05 AM', testDate);
        expect(result).not.toBeNull();
        expect(result.getHours()).toBe(9);
        expect(result.getMinutes()).toBe(5);
    });

    test('rejects single-digit minutes "9:5 AM" (invalid format)', () => {
        // Our regex requires exactly 2 digits for minutes (?::(\\d{2}))
        expect(parseDateTime('9:5 AM', testDate)).toBeNull();
    });

    test('rejects inner whitespace " 9 : 30 AM " (colons with spaces)', () => {
        // The regex anchors to ^...$ so inner spaces around colon don't match
        expect(parseDateTime(' 9 : 30 AM ', testDate)).toBeNull();
    });
});

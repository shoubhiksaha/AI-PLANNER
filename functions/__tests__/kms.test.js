// Shared mock references — set before require()
const mockEncrypt = jest.fn();
const mockDecrypt = jest.fn();

jest.mock('@google-cloud/kms', () => ({
    KeyManagementServiceClient: jest.fn().mockImplementation(() => ({
        encrypt: mockEncrypt,
        decrypt: mockDecrypt
    }))
}));

jest.mock('firebase-functions/params', () => ({
    defineString: (name) => {
        if (name === 'KMS_KEY_NAME') {
            return { value: () => process.env.KMS_KEY_NAME };
        }
        return { value: () => '' };
    }
}));

const { generateAndWrapDEK, unwrapAndDecrypt } = require('../services/kms');

describe('KMS Service Tests', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env = { ...originalEnv };
        process.env.KMS_KEY_NAME = 'projects/test-project/locations/global/keyRings/test-ring/cryptoKeys/test-key';
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    test('generateAndWrapDEK throws error if KMS_KEY_NAME is missing', async () => {
        delete process.env.KMS_KEY_NAME;
        await expect(generateAndWrapDEK('test-api-key')).rejects.toThrow('KMS_KEY_NAME environment variable is missing.');
    });

    test('generateAndWrapDEK returns valid envelope payload', async () => {
        mockEncrypt.mockResolvedValue([{ ciphertext: Buffer.from('mocked-wrapped-dek') }]);

        const payload = await generateAndWrapDEK('plain-secret');

        expect(mockEncrypt).toHaveBeenCalledTimes(1);
        expect(payload).toHaveProperty('encryptedKey');
        expect(payload).toHaveProperty('wrappedDek');
        expect(payload).toHaveProperty('iv');
        expect(payload).toHaveProperty('authTag');
        expect(payload.wrappedDek).toBe(Buffer.from('mocked-wrapped-dek').toString('base64'));
    });

    test('unwrapAndDecrypt throws error if KMS_KEY_NAME is missing', async () => {
        delete process.env.KMS_KEY_NAME;
        await expect(unwrapAndDecrypt('enc', 'wrap', 'iv', 'tag')).rejects.toThrow('KMS_KEY_NAME environment variable is missing.');
    });

    test('unwrapAndDecrypt successfully decrypts the payload', async () => {
        const crypto = require('crypto');
        const dek = crypto.randomBytes(32);

        // Encrypt a test secret with the DEK
        const secret = 'super-secret-api-key';
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
        let encryptedKey = cipher.update(secret, 'utf8', 'base64');
        encryptedKey += cipher.final('base64');
        const authTag = cipher.getAuthTag().toString('base64');

        // Mock KMS returning our known DEK
        mockDecrypt.mockResolvedValue([{ plaintext: dek }]);

        const result = await unwrapAndDecrypt(
            encryptedKey,
            Buffer.from('mocked-wrap').toString('base64'),
            iv.toString('base64'),
            authTag
        );

        expect(mockDecrypt).toHaveBeenCalledTimes(1);
        expect(result).toBe(secret);
    });

    test('unwrapAndDecrypt rejects a truncated auth tag (S-16)', async () => {
        const crypto = require('crypto');
        const dek = crypto.randomBytes(32);
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
        let encryptedKey = cipher.update('super-secret-api-key', 'utf8', 'base64');
        encryptedKey += cipher.final('base64');
        const shortTag = cipher.getAuthTag().subarray(0, 4).toString('base64');
        mockDecrypt.mockResolvedValue([{ plaintext: Buffer.from(dek) }]);

        await expect(unwrapAndDecrypt(encryptedKey, 'd3JhcA==', iv.toString('base64'), shortTag))
            .rejects.toThrow('authentication tag length');
    });

    describe('owner binding with AAD (S-16)', () => {
        const { keyBindingAad } = require('../utils');
        beforeEach(() => {
            // Identity "KMS": the wrapped DEK is the DEK itself.
            mockEncrypt.mockImplementation(async ({ plaintext }) => [{ ciphertext: Buffer.from(plaintext) }]);
            mockDecrypt.mockImplementation(async ({ ciphertext }) => [{ plaintext: Buffer.from(ciphertext) }]);
        });

        test('v3 round-trip: bound payload carries version 3 and decrypts with the same AAD', async () => {
            const aad = keyBindingAad('a@example.com', 'byok');
            const p = await generateAndWrapDEK('sk-bound-key-1234567890', { aad });
            expect(p.version).toBe(3);
            await expect(unwrapAndDecrypt(p.encryptedKey, p.wrappedDek, p.iv, p.authTag, { aad })).resolves.toBe('sk-bound-key-1234567890');
        });

        test('a v3 payload copied to another user (different AAD) or read without AAD fails', async () => {
            const p = await generateAndWrapDEK('sk-bound-key-1234567890', { aad: keyBindingAad('a@example.com', 'byok') });
            await expect(unwrapAndDecrypt(p.encryptedKey, p.wrappedDek, p.iv, p.authTag, { aad: keyBindingAad('b@example.com', 'byok') })).rejects.toThrow();
            await expect(unwrapAndDecrypt(p.encryptedKey, p.wrappedDek, p.iv, p.authTag)).rejects.toThrow();
        });

        test('unbound (legacy) payloads have no version and decrypt without AAD', async () => {
            const p = await generateAndWrapDEK('sk-legacy-key-1234567890');
            expect(p.version).toBeUndefined();
            await expect(unwrapAndDecrypt(p.encryptedKey, p.wrappedDek, p.iv, p.authTag)).resolves.toBe('sk-legacy-key-1234567890');
        });
    });
});

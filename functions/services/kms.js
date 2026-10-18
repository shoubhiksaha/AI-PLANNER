const { KeyManagementServiceClient } = require('@google-cloud/kms');
const crypto = require('crypto');
const { defineString } = require('firebase-functions/params');
const { KEY_BINDING_VERSION } = require('../utils');
const { getE2EFakes } = require('../testing/e2eFakes');

// Expect format: projects/PROJECT_ID/locations/LOCATION/keyRings/RING_NAME/cryptoKeys/KEY_NAME
const KMS_KEY_NAME = defineString('KMS_KEY_NAME');
let realClient = null;

/**
 * The KMS client and key name. In emulator E2E mode (C10) a local AES-GCM fake
 * stands in for Cloud KMS.
 */
function kmsBackend() {
    const fakes = getE2EFakes();
    if (fakes) return fakes.kms;
    if (!realClient) realClient = new KeyManagementServiceClient();
    return { client: realClient, keyName: KMS_KEY_NAME.value() };
}
// byokKmsData.version for payloads bound to their owner with AES-GCM AAD.
const BYOK_BINDING_VERSION = KEY_BINDING_VERSION;

/**
 * Generates a local DEK, encrypts the API key with it, and wraps the DEK via KMS.
 * Returns the enveloped payload to be saved in Firestore.
 *
 * With `aad` (see utils.keyBindingAad) the local AES-GCM encryption is bound to
 * the owner and the payload carries `version: 3`; unwrapAndDecrypt must then be
 * given the same AAD.
 */
async function generateAndWrapDEK(plaintextApiKey, { aad = null } = {}) {
    const { client, keyName } = kmsBackend();
    if (!keyName) {
        throw new Error('KMS_KEY_NAME environment variable is missing.');
    }

    // 1. Generate Data Encryption Key (DEK)
    const dek = crypto.randomBytes(32);

    // 2. Encrypt plaintextApiKey locally with DEK
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv, { authTagLength: 16 });
    if (aad) cipher.setAAD(aad);
    
    let encryptedKey = cipher.update(plaintextApiKey, 'utf8', 'base64');
    encryptedKey += cipher.final('base64');
    const authTag = cipher.getAuthTag().toString('base64');

    // 3. Wrap DEK through Cloud KMS
    const [result] = await client.encrypt({
        name: keyName,
        plaintext: dek,
    });

    const wrappedDek = Buffer.from(result.ciphertext).toString('base64');

    // Flash/clear local active memory
    dek.fill(0);

    return {
        encryptedKey,
        wrappedDek,
        iv: iv.toString('base64'),
        authTag,
        ...(aad ? { version: BYOK_BINDING_VERSION } : {})
    };
}

/**
 * Contacts KMS to unwrap the DEK, using it to dynamically decrypt the API key
 * strictly in volatile memory.
 */
async function unwrapAndDecrypt(encryptedKey, wrappedDek, ivBase64, authTagBase64, { aad = null } = {}) {
    const { client, keyName } = kmsBackend();
    if (!keyName) {
        throw new Error('KMS_KEY_NAME environment variable is missing.');
    }

    // 1. Unwrap the DEK from KMS
    const [result] = await client.decrypt({
        name: keyName,
        ciphertext: Buffer.from(wrappedDek, 'base64'),
    });

    const dek = Buffer.from(result.plaintext);

    // 2. Local DEK Decryption
    const iv = Buffer.from(ivBase64, 'base64');
    const authTag = Buffer.from(authTagBase64, 'base64');

    if (authTag.length !== 16) {
        dek.fill(0);
        throw new Error('Invalid BYOK authentication tag length.');
    }
    // Pin the tag length so a truncated tag can never be accepted.
    const decipher = crypto.createDecipheriv('aes-256-gcm', dek, iv, { authTagLength: 16 });
    if (aad) decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    
    let plaintextApiKey = decipher.update(encryptedKey, 'base64', 'utf8');
    plaintextApiKey += decipher.final('utf8');

    // Destruct DEK from memory
    dek.fill(0);

    return plaintextApiKey;
}

module.exports = {
    BYOK_BINDING_VERSION,
    generateAndWrapDEK,
    unwrapAndDecrypt
};

const { KeyManagementServiceClient } = require('@google-cloud/kms');
const crypto = require('crypto');
const { defineString } = require('firebase-functions/params');

// Expect format: projects/PROJECT_ID/locations/LOCATION/keyRings/RING_NAME/cryptoKeys/KEY_NAME
const KMS_KEY_NAME = defineString('KMS_KEY_NAME');
const client = new KeyManagementServiceClient();

/**
 * Generates a local DEK, encrypts the API key with it, and wraps the DEK via KMS.
 * Returns the enveloped payload to be saved in Firestore.
 */
async function generateAndWrapDEK(plaintextApiKey) {
    const keyName = KMS_KEY_NAME.value();
    if (!keyName) {
        throw new Error('KMS_KEY_NAME environment variable is missing.');
    }

    // 1. Generate Data Encryption Key (DEK)
    const dek = crypto.randomBytes(32);

    // 2. Encrypt plaintextApiKey locally with DEK
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
    
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
        authTag
    };
}

/**
 * Contacts KMS to unwrap the DEK, using it to dynamically decrypt the API key
 * strictly in volatile memory.
 */
async function unwrapAndDecrypt(encryptedKey, wrappedDek, ivBase64, authTagBase64) {
    const keyName = KMS_KEY_NAME.value();
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

    const decipher = crypto.createDecipheriv('aes-256-gcm', dek, iv);
    decipher.setAuthTag(authTag);
    
    let plaintextApiKey = decipher.update(encryptedKey, 'base64', 'utf8');
    plaintextApiKey += decipher.final('utf8');

    // Destruct DEK from memory
    dek.fill(0);

    return plaintextApiKey;
}

module.exports = {
    generateAndWrapDEK,
    unwrapAndDecrypt
};

/** BYOK (bring-your-own-key) resolution for syncPlanner. */
const { logger } = require('firebase-functions/logger');
const { ERROR_CODES: E } = require('../services/requestGuard');
const { unwrapAndDecrypt, generateAndWrapDEK } = require('../services/kms');
const { validateBYOKConfig, keyBindingAad, KEY_BINDING_VERSION } = require('../utils');
const { customBYOKUrlsEnabled } = require('../params');
const { SyncError } = require('./errors');

function toAdapterConfig(normalized) {
    const config = {
        apiKey: normalized.apiKey,
        provider: normalized.provider,
        modelName: normalized.modelName
    };
    if (normalized.baseUrl) config.customUrl = normalized.baseUrl;
    if (normalized.apiVersion) config.apiVersion = normalized.apiVersion;
    return config;
}

/**
 * Re-wrap a legacy (unbound) stored BYOK key as a v3 payload bound to its owner.
 * Best effort: a failure is logged and never fails the sync.
 */
async function rebindStoredByok(userRef, kms, plaintextKey, aad, { requestId, uid }) {
    try {
        const payload = await generateAndWrapDEK(plaintextKey, { aad });
        if (!payload || !payload.encryptedKey || !payload.wrappedDek || !payload.iv || !payload.authTag) {
            throw new Error('KMS returned an incomplete payload');
        }
        await userRef.set({ byokKmsData: { ...kms, ...payload, version: KEY_BINDING_VERSION } }, { merge: true });
        logger.info("Re-bound stored BYOK key to its owner (v3)", { requestId, uid });
    } catch (err) {
        logger.warn("Could not re-bind stored BYOK key as v3", { requestId, uid, error: err?.message });
    }
}

/**
 * Resolve the BYOK configuration for this request:
 *  1. validated X-BYOK-* headers (session-only key from the browser), or
 *  2. the user's KMS-wrapped stored key.
 * A stored config the current policy rejects falls back to credits with a warning.
 */
async function resolveByok(req, userData, { requestId, uid, warnings, email, userRef }) {
    const headerKey = req.headers['x-byok-token'];
    const claimsByok = ['x-byok-provider', 'x-byok-model', 'x-byok-baseurl', 'x-byok-apiversion'].some(h => req.headers[h]);
    if (!headerKey && claimsByok) {
        // Fail closed: never silently bill credits when the client meant to use its own key.
        throw new SyncError(400, E.BYOK_INVALID, "Your AI key was not received. Re-enter it in Settings and try again.");
    }
    if (headerKey) {
        const validation = validateBYOKConfig({
            apiKey: headerKey,
            provider: req.headers['x-byok-provider'] || 'openai',
            modelName: req.headers['x-byok-model'] || 'gpt-4o',
            baseUrl: req.headers['x-byok-baseurl'],
            apiVersion: req.headers['x-byok-apiversion']
        }, { allowCustomUrl: customBYOKUrlsEnabled() });
        if (!validation.valid) {
            throw new SyncError(400, E.BYOK_INVALID, `Your AI key settings are invalid: ${validation.error}`);
        }
        logger.info("Traffic Cop: routing via session BYOK headers", { requestId, uid, provider: validation.config.provider });
        return toAdapterConfig(validation.config);
    }

    const kms = userData.byokKmsData;
    if (!kms) return null;

    const aad = keyBindingAad(email, 'byok');
    const bound = Number(kms.version) === KEY_BINDING_VERSION;
    let decryptedKey;
    try {
        decryptedKey = await unwrapAndDecrypt(kms.encryptedKey, kms.wrappedDek, kms.iv, kms.authTag, bound ? { aad } : {});
    } catch (err) {
        logger.error("KMS Decryption error", { error: err.message, requestId, uid });
        throw new SyncError(500, E.INTERNAL, "We couldn't unlock your saved AI key. Please save it again in Settings.");
    }
    if (!bound) await rebindStoredByok(userRef, kms, decryptedKey, aad, { requestId, uid });
    const storedValidation = validateBYOKConfig({
        apiKey: decryptedKey,
        provider: kms.provider || 'openai',
        modelName: kms.modelName || 'gpt-4o',
        baseUrl: kms.baseUrl,
        apiVersion: kms.apiVersion
    }, { allowCustomUrl: customBYOKUrlsEnabled() });
    if (!storedValidation.valid) {
        logger.warn("Stored BYOK configuration rejected by current policy; falling back to credits", { requestId, uid, reason: storedValidation.error });
        warnings.push(`Your saved AI key settings are no longer supported (${storedValidation.error}). This sync used your credits instead — update or remove your key in Settings.`);
        return null;
    }
    logger.info("Traffic Cop: routing via stored KMS BYOK key", { requestId, uid, provider: storedValidation.config.provider });
    return toAdapterConfig(storedValidation.config);
}

module.exports = { toAdapterConfig, rebindStoredByok, resolveByok };

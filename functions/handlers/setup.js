/** Stored-key setup endpoints: setupNotion, setupBYOK and byokSession. */
const { FieldValue } = require('firebase-admin/firestore');
const { db } = require('../services/db');
const { logger } = require('firebase-functions/logger');
const { ERROR_CODES: E, sendError, guardRequest } = require('../services/requestGuard');
const { encrypt, validateNotionCredentials } = require('../services/notion');
const { generateAndWrapDEK } = require('../services/kms');
const { normalizeNotionDbId, isLikelyNotionKey, validateBYOKConfig, keyBindingAad } = require('../utils');
const { customBYOKUrlsEnabled } = require('../params');

// --- SETUP ENDPOINT: setupNotion ---
// POST { idToken, notionKey, notionDbId } saves; POST { idToken, action: 'delete' } removes.
async function setupNotionHandler(req, res) {
    const identity = await guardRequest(req, res, { endpoint: 'setupNotion' });
    if (!identity) return;
    const { email: userEmail, uid } = identity;

    const body = req.body || {};
    const firestore = db();
    const userRef = firestore.collection('users').doc(userEmail);

    if (body.action === 'delete') {
        try {
            const del = FieldValue.delete();
            await userRef.set({ notionKey: del, notionDbId: del }, { merge: true });
            logger.info("Deleted Notion settings", { uid });
            return res.status(200).send({ deleted: true });
        } catch (err) {
            logger.error("Notion delete error", { error: err.message, uid });
            return sendError(res, 500, E.INTERNAL, "Failed to remove Notion settings.");
        }
    }

    const notionKey = typeof body.notionKey === 'string' ? body.notionKey.trim() : '';
    const notionDbId = normalizeNotionDbId(body.notionDbId);
    if (!isLikelyNotionKey(notionKey) || !notionDbId) {
        return sendError(res, 400, E.BAD_REQUEST, "Invalid setup payload");
    }

    try {
        const notionValidation = await validateNotionCredentials(notionKey, notionDbId);
        if (!notionValidation.valid) {
            return sendError(res, 400, E.BAD_REQUEST, notionValidation.error);
        }

        const encryptedKey = encrypt(notionKey, userEmail);
        await userRef.set({ notionKey: encryptedKey, notionDbId }, { merge: true });

        logger.info("Stored encrypted Notion settings", { uid });
        return res.status(200).send({ success: true, text: "Notion setup saved securely." });
    } catch (err) {
        logger.error("Setup error", { error: err.message, uid });
        return sendError(res, 500, E.INTERNAL, "Failed to securely save keys.");
    }
}

// --- SETUP ENDPOINT: setupBYOK ---
// POST { idToken, apiKey, provider, modelName, ... } stores a KMS-wrapped key;
// POST { idToken, action: 'delete' } removes it together with legacy key fields.
async function setupBYOKHandler(req, res) {
    const identity = await guardRequest(req, res, { endpoint: 'setupBYOK' });
    if (!identity) return;
    const { email: userEmail, uid } = identity;

    const body = req.body || {};
    const firestore = db();
    const userRef = firestore.collection('users').doc(userEmail);
    const del = () => FieldValue.delete();

    if (body.action === 'delete') {
        try {
            await userRef.set({ byokKmsData: del(), geminiKey: del(), byokConfig: del() }, { merge: true });
            logger.info("Deleted stored BYOK configuration", { uid });
            return res.status(200).send({ deleted: true });
        } catch (err) {
            logger.error("BYOK delete error", { error: err.message, uid });
            return sendError(res, 500, E.INTERNAL, "Failed to remove BYOK settings.");
        }
    }

    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (!apiKey) {
        return sendError(res, 400, E.BAD_REQUEST, "Invalid setup payload");
    }

    try {
        const byokValidation = validateBYOKConfig(
            { apiKey, provider: body.provider || 'openai', modelName: body.modelName || 'gpt-4o', baseUrl: body.baseUrl, apiVersion: body.apiVersion },
            { allowCustomUrl: customBYOKUrlsEnabled() }
        );
        if (!byokValidation.valid) {
            return sendError(res, 400, E.BYOK_INVALID, byokValidation.error);
        }
        const normalizedConfig = byokValidation.config;

        const kmsPayload = await generateAndWrapDEK(normalizedConfig.apiKey, { aad: keyBindingAad(userEmail, 'byok') });
        const byokDataToSave = {
            ...kmsPayload,
            provider: normalizedConfig.provider,
            modelName: normalizedConfig.modelName
        };
        if (normalizedConfig.baseUrl) byokDataToSave.baseUrl = normalizedConfig.baseUrl;
        if (normalizedConfig.apiVersion) byokDataToSave.apiVersion = normalizedConfig.apiVersion;
        // Legacy fields never worked as BYOK; drop them whenever a real key is saved.
        await userRef.set({ byokKmsData: byokDataToSave, geminiKey: del(), byokConfig: del() }, { merge: true });

        logger.info("Stored wrapped BYOK KMS data", { uid, provider: normalizedConfig.provider });
        return res.status(200).send({ success: true, text: "BYOK settings saved securely." });
    } catch (err) {
        logger.error("BYOK Setup error", { error: err.message, uid });
        return sendError(res, 500, E.INTERNAL, "Failed to securely save keys.");
    }
}

// --- ENDPOINT: byokSession (stateless BYOK validation) ---
// POST validates a session-only BYOK config and sets NO cookies: the browser keeps
// the key in sessionStorage and sends it to /syncPlanner as X-BYOK-* headers.
// DELETE expires the legacy byok_token/byok_meta cookies left by older builds.
async function byokSessionHandler(req, res) {
    if (req.method === 'DELETE') {
        // Clearing expired cookies is harmless, so this needs neither auth nor a JSON body.
        const identity = await guardRequest(req, res, { endpoint: 'byokSession', methods: ['DELETE'], auth: false, requireJson: false });
        if (!identity) return;
        const cookieOpts = 'Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0';
        res.set('Set-Cookie', [
            `byok_token=; ${cookieOpts}`,
            `byok_meta=; ${cookieOpts}`,
        ]);
        return res.status(200).send({ success: true, text: 'BYOK session cleared.' });
    }

    const identity = await guardRequest(req, res, { endpoint: 'byokSession' });
    if (!identity) return;

    const body = req.body || {};
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (!apiKey) {
        return sendError(res, 400, E.BYOK_INVALID, 'API key is required.');
    }

    const byokValidation = validateBYOKConfig(
        { apiKey, provider: body.provider || 'openai', modelName: body.modelName || 'gpt-4o', baseUrl: body.baseUrl, apiVersion: body.apiVersion },
        { allowCustomUrl: customBYOKUrlsEnabled() }
    );
    if (!byokValidation.valid) {
        return sendError(res, 400, E.BYOK_INVALID, byokValidation.error);
    }
    const nc = byokValidation.config;
    return res.status(200).send({ valid: true, provider: nc.provider, modelName: nc.modelName });
}

module.exports = {
    setupNotionHandler,
    setupBYOKHandler,
    byokSessionHandler,
};

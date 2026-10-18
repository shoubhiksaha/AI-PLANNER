/** Notion prerequisites, checked BEFORE any credit is deducted. */
const { logger } = require('firebase-functions/logger');
const { ERROR_CODES: E } = require('../services/requestGuard');
const { getDecryptedNotionKeyAndMigrate } = require('../services/notion');
const { SyncError } = require('./errors');

/**
 * Journal and voice notes require a working Notion connection (400 otherwise);
 * evening uses Notion opportunistically when configured.
 * @returns {Promise<string|null>} the decrypted Notion key, or null
 */
async function resolveNotionKey(mode, userRef, preData, { requestId, uid, email }) {
    if (mode === 'journal' || mode === 'voice_note') {
        if (!preData.notionKey || !preData.notionDbId) {
            throw new SyncError(400, E.NOTION_NOT_CONFIGURED, "Notion not setup. Please provide keys.");
        }
        const decryptedNotionKey = await getDecryptedNotionKeyAndMigrate(userRef, preData, email);
        if (!decryptedNotionKey) {
            logger.error("Failed to decrypt Notion key", { requestId, uid, syncMode: mode });
            throw new SyncError(400, E.NOTION_NOT_CONFIGURED, "Your Notion connection needs to be set up again in Settings.");
        }
        return decryptedNotionKey;
    }
    if (mode === 'evening' && preData.notionKey && preData.notionDbId) {
        return getDecryptedNotionKeyAndMigrate(userRef, preData, email);
    }
    return null;
}

module.exports = { resolveNotionKey };

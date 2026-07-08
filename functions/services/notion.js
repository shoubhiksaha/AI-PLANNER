const { logger } = require("firebase-functions/logger");
const { Client } = require("@notionhq/client");
const { defineSecret } = require('firebase-functions/params');
const { uploadToNotion } = require("notion-multipart-uploader");
const {
    deriveKey,
    encrypt: _encryptWithKey,
    decryptCurrentGcm: _decryptGcmWithKey,
    decryptLegacyCbc: _decryptCbcWithKey
} = require('../utils');

const NOTION_ENCRYPTION_KEY = defineSecret('NOTION_ENCRYPTION_KEY');
const NOTION_ENCRYPTION_KEY_V2 = defineSecret('NOTION_ENCRYPTION_KEY_V2');

function getCryptoKeyNew() {
    const v2 = NOTION_ENCRYPTION_KEY_V2.value();
    if (v2) return deriveKey(v2);
    return deriveKey(NOTION_ENCRYPTION_KEY.value());
}

function getCryptoKeyOld() {
    return deriveKey(NOTION_ENCRYPTION_KEY.value());
}

function encrypt(text) {
    if (!text) return text;
    return _encryptWithKey(text, getCryptoKeyNew());
}

function decryptStoredNotionKey(text) {
    if (!text) return text;

    try {
        if (text.startsWith('v2:')) {
            const val = _decryptGcmWithKey(text, getCryptoKeyNew());
            if (val) return { value: val, needsMigration: false };
        }
    } catch (e) { /* ignore */ }

    try {
        const oldKey = getCryptoKeyOld();
        if (text.startsWith('v2:')) {
            const val = _decryptGcmWithKey(text, oldKey);
            return { value: val, needsMigration: !!val };
        }
        if (text.includes(':')) {
            const val = _decryptCbcWithKey(text, oldKey);
            return { value: val, needsMigration: !!val };
        }
        return { value: text, needsMigration: true };
    } catch (e) {
        logger.error("Decryption failed for stored Notion key.", { error: e.message });
        return { value: null, needsMigration: false, error: "Decryption failed. Please re-connect Notion in your settings." };
    }
}

async function getDecryptedNotionKeyAndMigrate(userRef, userData) {
    if (!userData?.notionKey) return null;

    const { value, needsMigration } = decryptStoredNotionKey(userData.notionKey);
    if (!value) return null;

    if (needsMigration) {
        await userRef.set({ notionKey: encrypt(value) }, { merge: true });
    }

    return value;
}

async function validateNotionCredentials(apiKey, databaseId) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
        const headers = {
            "Authorization": `Bearer ${apiKey}`,
            "Notion-Version": "2022-06-28"
        };
        const [identityResponse, databaseResponse] = await Promise.all([
            fetch("https://api.notion.com/v1/users/me", {
                method: "GET",
                headers,
                redirect: "error",
                signal: controller.signal
            }),
            fetch(`https://api.notion.com/v1/databases/${encodeURIComponent(databaseId)}`, {
                method: "GET",
                headers,
                redirect: "error",
                signal: controller.signal
            })
        ]);

        if (!identityResponse.ok) {
            return { valid: false, error: "Notion rejected the integration token." };
        }
        if (!databaseResponse.ok) {
            return { valid: false, error: "The Notion database is unavailable to this integration." };
        }
        return { valid: true };
    } catch (error) {
        if (error?.name === 'AbortError') {
            return { valid: false, error: "Notion validation timed out." };
        }
        return { valid: false, error: "Could not validate Notion settings." };
    } finally {
        clearTimeout(timeout);
    }
}

// Helper to upload file to Notion (using custom multipart uploader package)
async function uploadFileToNotion(apiKey, fileBuffer, mimeType, filename = "journal.jpg") {
    try {
        logger.info(`Uploading ${filename} to Notion using notion-multipart-uploader...`);
        const fileId = await uploadToNotion(
            apiKey,
            fileBuffer,
            mimeType,
            filename,
            { retries: 3, timeoutMs: 60000 }
        );
        logger.info(`Notion File Uploaded Successfully: ${fileId}`);
        return fileId;
    } catch (e) {
        logger.error("Notion Direct Upload Error:", { error: e.message });
        throw e;
    }
}

function normalizeBrainDumpText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

const NOTION_SDK_VERSION = '2025-09-03';

function createNotionClient(notionApiKey) {
    return new Client({
        auth: notionApiKey,
        notionVersion: NOTION_SDK_VERSION,
    });
}

async function resolveDataSourceId(notion, databaseId) {
    const database = await notion.databases.retrieve({ database_id: databaseId });
    const dataSourceId = database?.data_sources?.[0]?.id;
    if (!dataSourceId) {
        throw new Error('No data source found for this Notion database.');
    }
    return dataSourceId;
}

async function queryDatabasePages(notion, databaseId, filter) {
    const dataSourceId = await resolveDataSourceId(notion, databaseId);
    return notion.dataSources.query({
        data_source_id: dataSourceId,
        filter,
    });
}

async function createPageInDatabase(notion, databaseId, { properties, children }) {
    const dataSourceId = await resolveDataSourceId(notion, databaseId);
    return notion.pages.create({
        parent: { type: 'data_source_id', data_source_id: dataSourceId },
        properties,
        children,
    });
}

/**
 * @returns {{ ok: true, status: 'created' | 'duplicate' } | { ok: false, reason: string }}
 */
async function syncBrainDumpToNotion(plannerData, notionApiKey, databaseId, imageFileId, audioFileId) {
    const brainDumpText = normalizeBrainDumpText(plannerData?.brainDump);
    const hasText = brainDumpText.length > 0;

    if (!hasText && !imageFileId && !audioFileId) {
        return { ok: false, reason: 'Nothing to save (no text, image, or audio uploaded).' };
    }

    if (!notionApiKey || notionApiKey.includes("YOUR_")) {
        logger.warn("Notion API Key not configured.");
        return { ok: false, reason: 'Notion API key is not configured.' };
    }

    const notion = createNotionClient(notionApiKey);
    const pageTitle = `Brain Dump - ${plannerData.date}`;

    try {
        const existingPages = await queryDatabasePages(notion, databaseId, {
            property: "Name",
            title: { equals: pageTitle },
        });

        if (existingPages.results.length > 0) {
            logger.info("Notion page already exists for this date, skipping duplicate creation.");
            return { ok: true, status: 'duplicate' };
        }

        const children = [];

        if (hasText) {
            children.push({
                object: 'block',
                type: 'paragraph',
                paragraph: {
                    rich_text: [{ type: 'text', text: { content: brainDumpText } }]
                }
            });
        }

        if (imageFileId) {
            children.push({
                object: 'block',
                type: 'image',
                image: {
                    type: 'file_upload',
                    file_upload: { id: imageFileId }
                }
            });
        }

        if (audioFileId) {
            children.push({
                object: 'block',
                type: 'file',
                file: {
                    type: 'file_upload',
                    file_upload: { id: audioFileId }
                }
            });
        }

        await createPageInDatabase(notion, databaseId, {
            properties: {
                "Name": { title: [{ text: { content: pageTitle } }] }
            },
            children,
        });
        return { ok: true, status: 'created' };
    } catch (err) {
        logger.error("Notion Sync Error:", { error: err.message });
        return { ok: false, reason: err.message || 'Notion page creation failed.' };
    }
}

module.exports = {
    encrypt,
    getDecryptedNotionKeyAndMigrate,
    validateNotionCredentials,
    uploadFileToNotion,
    syncBrainDumpToNotion,
    normalizeBrainDumpText,
    createNotionClient,
    createPageInDatabase,
    resolveDataSourceId,
};

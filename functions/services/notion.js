const { logger } = require("firebase-functions/logger");
const { Client } = require("@notionhq/client");
const { defineSecret } = require('firebase-functions/params');
const { uploadToNotion } = require("notion-multipart-uploader");
const { getE2EFakes } = require('../testing/e2eFakes');
const {
    deriveKey,
    encryptBound,
    keyBindingAad,
    decryptStoredNotionKey: _decryptStoredWithKey,
    chunkText,
} = require('../utils');

// Notion API limits: 100 children per request, 2,000 characters per rich_text.
const NOTION_MAX_CHILDREN = 100;
const NOTION_MAX_TEXT = 2000;

const NOTION_ENCRYPTION_KEY_V2 = defineSecret('NOTION_ENCRYPTION_KEY_V2');

function getCryptoKey() {
    return deriveKey(NOTION_ENCRYPTION_KEY_V2.value());
}

/** Encrypt a Notion key for storage, bound to its owner (`v3:`; AAD aiplanner:v3:<email>:notionKey). */
function encrypt(text, email) {
    if (!text) return text;
    return encryptBound(text, getCryptoKey(), keyBindingAad(email, 'notionKey'));
}

/**
 * Decrypt the stored Notion key with the active secret. Delegates to the single
 * format-aware implementation in utils (v3 bound GCM, v2 GCM, legacy iv:cipher
 * CBC, plaintext), so legacy ciphertext is never mistaken for a plaintext token.
 */
function decryptStoredNotionKey(text, email) {
    if (!text) return text;
    let result = null;
    try {
        result = _decryptStoredWithKey(text, getCryptoKey(), keyBindingAad(email, 'notionKey'));
    } catch (_) {
        result = null;
    }
    if (!result || !result.value) {
        logger.error("Decryption failed for stored Notion key.");
        return { value: null, needsMigration: false, error: "Decryption failed. Please re-connect Notion in your settings." };
    }
    return result;
}

/**
 * Decrypt the user's Notion key. Anything older than v3 is re-encrypted as v3
 * and saved in the same request; that re-save is best effort and never fails
 * the caller.
 * @param {object} userRef   users/{email} document reference
 * @param {object} userData  the user document's data
 * @param {string} [email]   owner email (defaults to the document id)
 */
async function getDecryptedNotionKeyAndMigrate(userRef, userData, email = userRef?.id) {
    if (!userData?.notionKey) return null;

    const { value, needsMigration } = decryptStoredNotionKey(userData.notionKey, email);
    if (!value) return null;

    if (needsMigration) {
        try {
            await userRef.set({ notionKey: encrypt(value, email) }, { merge: true });
        } catch (err) {
            logger.warn("Could not re-encrypt stored Notion key as v3", { error: err?.message });
        }
    }

    return value;
}

async function validateNotionCredentials(apiKey, databaseId) {
    const fakes = getE2EFakes();
    if (fakes) return fakes.notion.validateCredentials(apiKey, databaseId);
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
        logger.info(`Uploading ${filename} to Notion using notion-multipart-uploader...`, { bytes: fileBuffer?.length || 0 });
        const upload = getE2EFakes()?.notion.uploadToNotion || uploadToNotion;
        const fileId = await upload(
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
    const NotionClient = getE2EFakes()?.notion.Client || Client;
    return new NotionClient({
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

/** Paragraph blocks for `text`, one per non-empty line, each ≤ 2,000 characters. */
function buildParagraphBlocks(text) {
    const blocks = [];
    const paragraphs = String(text || '').split('\n').filter(p => p.trim() !== '');
    for (const paragraph of paragraphs) {
        for (const chunk of chunkText(paragraph, NOTION_MAX_TEXT)) {
            blocks.push({
                object: 'block',
                type: 'paragraph',
                paragraph: { rich_text: [{ type: 'text', text: { content: chunk } }] }
            });
        }
    }
    return blocks;
}

/**
 * Create a page with any number of children: the first 100 go with pages.create,
 * the rest are appended in batches of 100.
 */
async function createPageInDatabase(notion, databaseId, { properties, children = [] }) {
    const dataSourceId = await resolveDataSourceId(notion, databaseId);
    const allChildren = Array.isArray(children) ? children : [];
    const page = await notion.pages.create({
        parent: { type: 'data_source_id', data_source_id: dataSourceId },
        properties,
        children: allChildren.slice(0, NOTION_MAX_CHILDREN),
    });
    for (let i = NOTION_MAX_CHILDREN; i < allChildren.length; i += NOTION_MAX_CHILDREN) {
        await notion.blocks.children.append({
            block_id: page.id,
            children: allChildren.slice(i, i + NOTION_MAX_CHILDREN),
        });
    }
    return page;
}

/**
 * @returns {{ ok: true, status: 'created' | 'duplicate' } | { ok: false, reason: string }}
 */
async function syncBrainDumpToNotion(plannerData, notionApiKey, databaseId, fileId) {
    const brainDumpText = normalizeBrainDumpText(plannerData?.brainDump);
    const hasText = brainDumpText.length > 0;

    if (!hasText && !fileId) {
        return { ok: false, reason: 'Nothing to save (no Brain Dump text and no image uploaded).' };
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

        const children = hasText ? buildParagraphBlocks(brainDumpText) : [];

        if (fileId) {
            children.push({
                object: 'block',
                type: 'image',
                image: {
                    type: 'file_upload',
                    file_upload: { id: fileId }
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
    buildParagraphBlocks,
    resolveDataSourceId,
    NOTION_MAX_CHILDREN,
    NOTION_MAX_TEXT,
};

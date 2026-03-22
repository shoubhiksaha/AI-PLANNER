const { logger } = require("firebase-functions/logger");
const { defineSecret } = require('firebase-functions/params');
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

// Helper to upload file to Notion (Direct Upload - Corrected 2-Step Flow)
async function uploadFileToNotion(apiKey, fileBuffer, mimeType) {
    try {
        logger.info("Step 1: Init Notion Upload...");
        const createRes = await fetch("https://api.notion.com/v1/file_uploads", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "Notion-Version": "2022-06-28"
            },
            body: JSON.stringify({
                filename: "journal.jpg",
                content_type: mimeType
            })
        });

        if (!createRes.ok) throw new Error(`Notion Init Upload Failed: ${await createRes.text()}`);
        const uploadObj = await createRes.json();
        const { id, upload_url } = uploadObj;

        logger.info(`Step 1 Success. ID: ${id}. Step 2: Uploading Binary...`);

        const form = new FormData();
        const blob = new Blob([fileBuffer], { type: mimeType });
        form.append("file", blob, "journal.jpg");

        const uploadRes = await fetch(upload_url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Notion-Version": "2022-06-28"
            },
            body: form
        });

        if (!uploadRes.ok) throw new Error(`Notion Binary Upload Failed: ${await uploadRes.text()}`);

        logger.info(`Notion File Uploaded Successfully: ${id}`);
        return id;
    } catch (e) {
        logger.error("Notion Direct Upload Error:", { error: e.message });
        throw e;
    }
}

async function syncBrainDumpToNotion(plannerData, notionApiKey, databaseId, fileId) {
    if ((!plannerData.brainDump || plannerData.brainDump.trim() === '') && !fileId) return false;

    if (!notionApiKey || notionApiKey.includes("YOUR_")) {
        console.warn("Notion API Key not configured.");
        return false;
    }

    const { Client } = require("@notionhq/client");
    const notion = new Client({ auth: notionApiKey });
    const pageTitle = `Brain Dump - ${plannerData.date}`;

    try {
        const children = [];

        if (plannerData.brainDump) {
            children.push({
                object: 'block',
                type: 'paragraph',
                paragraph: {
                    rich_text: [{ type: 'text', text: { content: plannerData.brainDump } }]
                }
            });
        }

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

        await notion.pages.create({
            parent: { database_id: databaseId },
            properties: {
                "Name": { title: [{ text: { content: pageTitle } }] }
            },
            children: children
        });
        return true;
    } catch (err) {
        logger.error("Notion Sync Error:", { error: err.message });
        return false;
    }
}

module.exports = {
    encrypt,
    getDecryptedNotionKeyAndMigrate,
    uploadFileToNotion,
    syncBrainDumpToNotion
};

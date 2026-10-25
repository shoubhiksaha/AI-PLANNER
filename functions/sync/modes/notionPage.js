/**
 * Shared Notion branch for journal and voice-note syncs: uploads every file,
 * runs the AI step in parallel and creates one database page.
 */
const { logger } = require('firebase-functions/logger');
const { getPlannerDataFromImages } = require('../../services/gemini');
const {
    uploadFileToNotion,
    createNotionClient,
    createPageInDatabase,
    buildParagraphBlocks,
} = require('../../services/notion');
const { extensionForMime, redactSensitive } = require('../../utils');

/**
 * @param {object} ctx            sync context (see sync/handler.js)
 * @param {object} opts
 * @param {string} opts.aiSyncType      prompt type for the AI step
 * @param {string} opts.label           'Journal' | 'Voice Note'
 * @param {string} opts.failureWarning  warning shown when extraction failed
 */
async function syncToNotionPage(ctx, { aiSyncType, label, failureWarning }) {
    const { mode, requestId, uid, parsedImages, byokConfig, aiOptions, userData, preData, timeZone, warnings, decryptedNotionKey } = ctx;
    const notion = createNotionClient(decryptedNotionKey);
    logger.info(`Starting parallel ${mode} processing (Zero Storage)...`, { requestId, uid, syncMode: mode });

    const fileUploadPromises = parsedImages.map((img, i) => uploadFileToNotion(
        decryptedNotionKey,
        Buffer.from(img.base64Data, 'base64'),
        img.mimeType,
        `${mode}_${i + 1}.${extensionForMime(img.mimeType)}`
    ));

    const [fileUploadIds, extraction] = await Promise.all([
        Promise.all(fileUploadPromises),
        getPlannerDataFromImages(parsedImages, aiSyncType, byokConfig, aiOptions)
            .then(data => ({ ok: true, data }))
            .catch(err => {
                const log = err?.code === 'AI_CONFIG_ERROR' ? logger.error : logger.warn;
                log(`Extraction failed for ${mode}`, { requestId, uid, syncMode: mode, code: err?.code, error: redactSensitive(err?.message || err) });
                return { ok: false, data: { date: null, transcription: "" } };
            })
    ]);
    const extractionOk = extraction.ok;
    if (!extractionOk) warnings.push(failureWarning);

    let itemDate = new Date().toLocaleDateString('en-US', { timeZone });
    if (extraction.data && extraction.data.date) itemDate = extraction.data.date;

    // Create Notion Page with File Attachments
    const childrenBlocks = fileUploadIds.map((id, index) => {
        const blockType = parsedImages[index].mimeType.startsWith('audio/') ? 'file' : 'image';
        return {
            object: 'block',
            type: blockType,
            [blockType]: { type: 'file_upload', file_upload: { id } }
        };
    });
    if (extraction.data && extraction.data.transcription) {
        childrenBlocks.push(...buildParagraphBlocks(extraction.data.transcription));
    }

    const page = await createPageInDatabase(notion, userData.notionDbId || preData.notionDbId, {
        properties: { "Name": { title: [{ text: { content: `${label} - ${itemDate}` } }] } },
        children: childrenBlocks,
    });
    const isVoice = mode === 'voice_note';
    const pageUrl = page && typeof page.url === 'string' && /^https:\/\/(www\.)?notion\.so\//.test(page.url) ? page.url : null;
    return {
        msg: `${label} synced to Notion! Date: ${itemDate}`,
        counts: isVoice ? { voiceNotes: 1 } : { journalPages: parsedImages.length },
        dataSynced: true,
        extractionOk,
        partial: false,
        savedTo: 'notion',
        ...(pageUrl ? { links: { notion: pageUrl } } : {}),
        notes: [],
    };
}

module.exports = { syncToNotionPage };

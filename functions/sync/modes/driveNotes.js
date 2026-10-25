/**
 * Google Drive branch for journal pages, voice notes and evening brain dumps.
 * Mirrors the Notion branch (sync/modes/notionPage.js): files are uploaded while
 * the AI step runs, and a transcription becomes a Google Doc next to them.
 */
const { logger } = require('firebase-functions/logger');
const { getPlannerDataFromImages } = require('../../services/gemini');
const { ensureNotesFolder, uploadFile, createDoc, trashFile, fileExists, folderUrl } = require('../../services/googleDrive');
const { normalizeBrainDumpText } = require('../../services/notion');
const { extensionForMime, redactSensitive, toIsoDate } = require('../../utils');

function driveClient(ctx) {
    return ctx.google.drive({ version: 'v3', auth: ctx.auth });
}

function cachedFolders(ctx) {
    return (ctx.userData && ctx.userData.driveFolders) || (ctx.preData && ctx.preData.driveFolders) || {};
}

/**
 * When a save fails part-way, the files it already uploaded go to the Drive trash, so a retry
 * doesn't leave duplicates behind. Best effort: a failed clean-up is logged, not thrown.
 */
async function trashUploads(ctx, drive, files) {
    await Promise.all(files.map(file => trashFile(drive, file.id).catch(err => {
        logger.warn('Could not move an upload to the trash after a failed save', {
            requestId: ctx.requestId, uid: ctx.uid, syncMode: ctx.mode, error: redactSensitive(err?.message || err),
        });
    })));
}

/** Uploads every file or none: if one upload fails, the others go to the trash. */
async function uploadAll(ctx, drive, uploads) {
    const results = await Promise.allSettled(uploads.map(upload => uploadFile(drive, upload)));
    const files = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    const failed = results.find(r => r.status === 'rejected');
    if (failed) {
        await trashUploads(ctx, drive, files);
        throw failed.reason;
    }
    return files;
}

/** Writes the Doc; if that fails, the files it would have linked to go to the trash first. */
async function createDocOrTrashUploads(ctx, drive, doc, files) {
    try {
        return await createDoc(drive, doc);
    } catch (err) {
        await trashUploads(ctx, drive, files);
        throw err;
    }
}

/**
 * Journal or voice note → Drive.
 * @param {object} ctx  sync context (see sync/handler.js)
 * @param {object} opts
 * @param {string} opts.aiSyncType      prompt type for the AI step
 * @param {'journal'|'voiceNote'} opts.kind
 * @param {string} opts.label           'Journal' | 'Voice note' (file names)
 * @param {string} opts.failureWarning  warning shown when extraction failed
 */
async function syncToDrive(ctx, { aiSyncType, kind, label, failureWarning }) {
    const { mode, requestId, uid, parsedImages, byokConfig, aiOptions, timeZone, warnings, userRef } = ctx;
    const drive = driveClient(ctx);
    logger.info(`Starting ${mode} → Google Drive`, { requestId, uid, syncMode: mode });

    const [folderId, extraction] = await Promise.all([
        ensureNotesFolder(drive, { kind, userRef, cachedFolders: cachedFolders(ctx) }),
        getPlannerDataFromImages(parsedImages, aiSyncType, byokConfig, aiOptions)
            .then(data => ({ ok: true, data }))
            .catch(err => {
                const log = err?.code === 'AI_CONFIG_ERROR' ? logger.error : logger.warn;
                log(`Extraction failed for ${mode}`, { requestId, uid, syncMode: mode, code: err?.code, error: redactSensitive(err?.message || err) });
                return { ok: false, data: { date: null, transcription: '' } };
            }),
    ]);
    if (!extraction.ok) warnings.push(failureWarning);

    const date = toIsoDate(extraction.data && extraction.data.date, timeZone);
    const numbered = kind === 'journal' || parsedImages.length > 1;
    const files = await uploadAll(ctx, drive, parsedImages.map((img, i) => ({
        name: `${date} ${label}${numbered ? ` ${i + 1}` : ''}.${extensionForMime(img.mimeType)}`,
        mimeType: img.mimeType,
        buffer: Buffer.from(img.base64Data, 'base64'),
        parentId: folderId,
    })));

    const notes = [];
    const transcription = String((extraction.data && extraction.data.transcription) || '').trim();
    if (transcription) {
        const heading = kind === 'journal' ? 'Photos:' : 'Recording:';
        await createDocOrTrashUploads(ctx, drive, {
            name: `${date} ${label}`,
            text: `${transcription}\n\n${heading}\n${files.map(f => f.webViewLink).join('\n')}`,
            parentId: folderId,
        }, files);
        notes.push('The transcription was saved as a Google Doc next to it.');
    }

    const counts = kind === 'journal' ? { journalPages: parsedImages.length } : { voiceNotes: 1 };
    return {
        msg: `${label} saved to Google Drive. Date: ${date}`,
        counts,
        dataSynced: true,
        extractionOk: extraction.ok,
        partial: false,
        savedTo: 'drive',
        links: { drive: folderUrl(folderId) },
        notes,
    };
}

/**
 * Evening brain dump → Drive: one Google Doc per date, plus the page photo.
 * Only a page that has brain-dump text is saved, so an evening page without one
 * doesn't fill Drive with photos (and doesn't count as synced data).
 * @returns {Promise<{ ok: true, status: 'created'|'duplicate', folderId: string } | { ok: false, empty?: boolean, reason: string }>}
 */
async function saveBrainDumpToDrive(ctx, { plannerData, date }) {
    if (plannerData.brainDump != null && typeof plannerData.brainDump !== 'string') {
        return { ok: false, reason: `AI returned brainDump as ${typeof plannerData.brainDump}; expected handwritten text.` };
    }
    const text = normalizeBrainDumpText(plannerData.brainDump);
    const image = ctx.parsedImages[0];
    const hasImage = !!(image && image.base64Data);
    if (!text) {
        return { ok: false, empty: true, reason: 'No brain dump text found on the page.' };
    }

    const drive = driveClient(ctx);
    const folderId = await ensureNotesFolder(drive, { kind: 'brainDump', userRef: ctx.userRef, cachedFolders: cachedFolders(ctx) });
    const docName = `${date} Brain dump`;
    if (await fileExists(drive, { name: docName, parentId: folderId })) {
        return { ok: true, status: 'duplicate', folderId };
    }

    const photo = hasImage
        ? await uploadFile(drive, {
            name: `${docName}.${extensionForMime(image.mimeType)}`,
            mimeType: image.mimeType,
            buffer: Buffer.from(image.base64Data, 'base64'),
            parentId: folderId,
        })
        : null;
    await createDocOrTrashUploads(ctx, drive, {
        name: docName,
        text: [text, photo ? `Photo: ${photo.webViewLink}` : ''].filter(Boolean).join('\n\n'),
        parentId: folderId,
    }, photo ? [photo] : []);
    return { ok: true, status: 'created', folderId };
}

module.exports = { syncToDrive, saveBrainDumpToDrive };

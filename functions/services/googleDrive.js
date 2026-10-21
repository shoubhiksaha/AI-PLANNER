/**
 * Google Drive storage for journal pages, brain dumps and voice notes.
 *
 * Files live under "AI Planner/<Journal|Brain dumps|Voice notes>" in the user's
 * My Drive. The app's drive.file scope only sees files it created, so a folder
 * the user made by hand with the same name is never touched. Folder ids are
 * cached on the user document as `driveFolders`; a cached folder that was
 * deleted or trashed is found again by name or recreated.
 */
const { Readable } = require('stream');
const { logger } = require('firebase-functions/logger');

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOC_MIME = 'application/vnd.google-apps.document';
const ROOT_FOLDER_NAME = 'AI Planner';
const NOTES_FOLDERS = Object.freeze({
    journal: 'Journal',
    brainDump: 'Brain dumps',
    voiceNote: 'Voice notes',
});

function folderUrl(folderId) {
    return `https://drive.google.com/drive/folders/${folderId}`;
}

function fileUrl(fileId) {
    return `https://drive.google.com/file/d/${fileId}/view`;
}

/** Quote a value for a Drive `q` string literal. */
function quoteQuery(value) {
    return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function driveErrorStatus(err) {
    return Number(err?.code ?? err?.status ?? err?.response?.status) || null;
}

function isNotFoundError(err) {
    return driveErrorStatus(err) === 404;
}

async function findByName(drive, { name, parentId, folder }) {
    const q = [
        `name = ${quoteQuery(name)}`,
        `${quoteQuery(parentId)} in parents`,
        folder ? `mimeType = '${FOLDER_MIME}'` : `mimeType != '${FOLDER_MIME}'`,
        'trashed = false',
    ].join(' and ');
    const res = await drive.files.list({ q, fields: 'files(id,name)', pageSize: 1, spaces: 'drive' });
    return res?.data?.files?.[0]?.id || null;
}

async function createFolder(drive, name, parentId) {
    const res = await drive.files.create({
        requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId] },
        fields: 'id',
    });
    return res.data.id;
}

/** A cached folder is usable when it still exists and isn't in the trash. */
async function isUsableFolder(drive, folderId) {
    if (!folderId) return false;
    try {
        const res = await drive.files.get({ fileId: folderId, fields: 'id,trashed' });
        return !!res?.data && res.data.trashed !== true;
    } catch (err) {
        if (isNotFoundError(err)) return false;
        throw err;
    }
}

async function findOrCreateFolder(drive, name, parentId) {
    return (await findByName(drive, { name, parentId, folder: true })) || createFolder(drive, name, parentId);
}

/**
 * The folder id for `kind` ('journal' | 'brainDump' | 'voiceNote'), creating
 * "AI Planner" and the subfolder when needed and caching both on the user doc.
 * @returns {Promise<string>}
 */
async function ensureNotesFolder(drive, { kind, userRef, cachedFolders = {} }) {
    const subName = NOTES_FOLDERS[kind];
    if (!subName) throw new Error(`Unknown Drive folder kind: ${kind}`);
    const cached = cachedFolders && typeof cachedFolders === 'object' ? cachedFolders : {};

    if (await isUsableFolder(drive, cached[kind])) return cached[kind];

    let rootId = cached.root;
    if (!(await isUsableFolder(drive, rootId))) {
        rootId = await findOrCreateFolder(drive, ROOT_FOLDER_NAME, 'root');
    }
    const folderId = await findOrCreateFolder(drive, subName, rootId);
    if (cached[kind]) logger.warn("Cached Drive folder was gone; using a new one", { kind });

    // The whole map is written so a shallow merge never drops the other folders.
    await userRef.set({ driveFolders: { ...cached, root: rootId, [kind]: folderId } }, { merge: true });
    return folderId;
}

/** @returns {Promise<{ id: string, webViewLink: string }>} */
async function uploadFile(drive, { name, mimeType, buffer, parentId }) {
    const res = await drive.files.create({
        requestBody: { name, parents: [parentId] },
        media: { mimeType, body: Readable.from(buffer) },
        fields: 'id,webViewLink',
    });
    const id = res.data.id;
    return { id, webViewLink: res.data.webViewLink || fileUrl(id) };
}

/** A Google Doc made by converting plain text. @returns {Promise<{ id: string, webViewLink: string }>} */
async function createDoc(drive, { name, text, parentId }) {
    const res = await drive.files.create({
        requestBody: { name, mimeType: DOC_MIME, parents: [parentId] },
        media: { mimeType: 'text/plain', body: String(text || '') },
        fields: 'id,webViewLink',
    });
    const id = res.data.id;
    return { id, webViewLink: res.data.webViewLink || `https://docs.google.com/document/d/${id}/edit` };
}

/** Whether a (non-folder) file with this name already exists in the folder. */
async function fileExists(drive, { name, parentId }) {
    return !!(await findByName(drive, { name, parentId, folder: false }));
}

module.exports = {
    FOLDER_MIME,
    DOC_MIME,
    ROOT_FOLDER_NAME,
    NOTES_FOLDERS,
    folderUrl,
    fileUrl,
    quoteQuery,
    isNotFoundError,
    ensureNotesFolder,
    uploadFile,
    createDoc,
    fileExists,
};

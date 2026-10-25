/**
 * Notes destination (Google Drive or Notion) and the Drive storage service.
 */
const {
    resolveNotesDestination,
    isValidNotesDestination,
    modeNeedsGoogle,
} = require('../sync/notesDestination');
const {
    ensureNotesFolder,
    uploadFile,
    createDoc,
    trashFile,
    fileExists,
    folderUrl,
    quoteQuery,
    FOLDER_MIME,
    DOC_MIME,
} = require('../services/googleDrive');
const { toIsoDate } = require('../utils');

describe('resolveNotesDestination', () => {
    test.each([
        [{}, 'drive'],
        [null, 'drive'],
        [{ notionKey: 'v3:x', notionDbId: 'db' }, 'notion'],
        [{ notionKey: 'v3:x' }, 'drive'],
        [{ notionKey: 'v3:x', notionDbId: 'db', notesDestination: 'drive' }, 'drive'],
        [{ notesDestination: 'notion' }, 'notion'],
        [{ notesDestination: 'dropbox', notionKey: 'v3:x', notionDbId: 'db' }, 'notion'],
        [{ notesDestination: 'dropbox' }, 'drive'],
    ])('%j → %s', (userData, expected) => {
        expect(resolveNotesDestination(userData)).toBe(expected);
    });

    test('only drive and notion are valid', () => {
        expect(isValidNotesDestination('drive')).toBe(true);
        expect(isValidNotesDestination('notion')).toBe(true);
        expect(isValidNotesDestination('Drive')).toBe(false);
        expect(isValidNotesDestination(undefined)).toBe(false);
    });

    test.each([
        ['morning', 'notion', true],
        ['evening', 'notion', true],
        ['journal', 'drive', true],
        ['voice_note', 'drive', true],
        ['journal', 'notion', false],
        ['voice_note', 'notion', false],
        ['unknown', 'drive', false],
    ])('modeNeedsGoogle(%s, %s) → %s', (mode, destination, expected) => {
        expect(modeNeedsGoogle(mode, destination)).toBe(expected);
    });
});

describe('toIsoDate', () => {
    const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    test.each([
        ['2025-01-15', '2025-01-15'],
        ['15-January-2025', '2025-01-15'],
        ['January 15, 2025', '2025-01-15'],
    ])('%s → %s', (input, expected) => {
        expect(toIsoDate(input, 'Asia/Kolkata')).toBe(expected);
    });

    test.each([['2025-13-45'], ['garbage'], [''], [null], ['15 March 1850']])('%j falls back to today', (input) => {
        expect(toIsoDate(input, 'Asia/Kolkata')).toBe(today());
    });
});

/** A tiny in-memory Drive with the files.list/get/create surface the service uses. */
function fakeDrive({ files = [] } = {}) {
    const store = new Map(files.map(f => [f.id, { trashed: false, ...f }]));
    let n = 0;
    const parse = (q, re) => {
        const m = q.match(re);
        return m ? m[1].replace(/\\(.)/g, '$1') : undefined;
    };
    return {
        store,
        files: {
            list: jest.fn(async ({ q }) => {
                const name = parse(q, /name = '((?:[^'\\]|\\.)*)'/);
                const parent = parse(q, /'((?:[^'\\]|\\.)*)' in parents/);
                const folder = q.includes(`mimeType = '${FOLDER_MIME}'`);
                return {
                    data: {
                        files: [...store.values()]
                            .filter(f => !f.trashed && f.name === name && f.parent === parent && (f.mimeType === FOLDER_MIME) === folder)
                            .map(f => ({ id: f.id, name: f.name })),
                    },
                };
            }),
            get: jest.fn(async ({ fileId }) => {
                const f = store.get(fileId);
                if (!f) {
                    const err = new Error('File not found');
                    err.code = 404;
                    throw err;
                }
                return { data: { id: f.id, trashed: f.trashed } };
            }),
            create: jest.fn(async ({ requestBody, media }) => {
                const id = `id-${++n}`;
                store.set(id, {
                    id,
                    name: requestBody.name,
                    mimeType: requestBody.mimeType || media?.mimeType,
                    parent: requestBody.parents[0],
                    trashed: false,
                });
                return { data: { id, webViewLink: `https://drive.google.com/file/d/${id}/view` } };
            }),
        },
    };
}

const userRef = () => ({ set: jest.fn().mockResolvedValue(undefined) });

describe('ensureNotesFolder', () => {
    test('creates "AI Planner" and the subfolder once, then caches both on the user doc', async () => {
        const drive = fakeDrive();
        const ref = userRef();
        const id = await ensureNotesFolder(drive, { kind: 'journal', userRef: ref, cachedFolders: {} });

        const created = drive.files.create.mock.calls.map(([arg]) => [arg.requestBody.name, arg.requestBody.parents[0], arg.requestBody.mimeType]);
        expect(created).toEqual([
            ['AI Planner', 'root', FOLDER_MIME],
            ['Journal', 'id-1', FOLDER_MIME],
        ]);
        expect(id).toBe('id-2');
        expect(ref.set).toHaveBeenCalledWith({ driveFolders: { root: 'id-1', journal: 'id-2' } }, { merge: true });
    });

    test('a usable cached folder is used without listing or creating anything', async () => {
        const drive = fakeDrive({ files: [{ id: 'root-1', name: 'AI Planner', mimeType: FOLDER_MIME, parent: 'root' }, { id: 'j-1', name: 'Journal', mimeType: FOLDER_MIME, parent: 'root-1' }] });
        const ref = userRef();
        await expect(ensureNotesFolder(drive, { kind: 'journal', userRef: ref, cachedFolders: { root: 'root-1', journal: 'j-1' } })).resolves.toBe('j-1');
        expect(drive.files.list).not.toHaveBeenCalled();
        expect(drive.files.create).not.toHaveBeenCalled();
        expect(ref.set).not.toHaveBeenCalled();
    });

    test('a deleted cached subfolder is recreated inside the existing root, keeping other cached ids', async () => {
        const drive = fakeDrive({ files: [{ id: 'root-1', name: 'AI Planner', mimeType: FOLDER_MIME, parent: 'root' }] });
        const ref = userRef();
        const id = await ensureNotesFolder(drive, { kind: 'brainDump', userRef: ref, cachedFolders: { root: 'root-1', brainDump: 'gone', journal: 'j-9' } });
        expect(drive.files.create).toHaveBeenCalledTimes(1);
        expect(drive.files.create.mock.calls[0][0].requestBody).toEqual({ name: 'Brain dumps', mimeType: FOLDER_MIME, parents: ['root-1'] });
        expect(ref.set).toHaveBeenCalledWith({ driveFolders: { root: 'root-1', brainDump: id, journal: 'j-9' } }, { merge: true });
    });

    test('a trashed cache with a lost id finds the folders again by name instead of duplicating them', async () => {
        const drive = fakeDrive({
            files: [
                { id: 'old-root', name: 'AI Planner', mimeType: FOLDER_MIME, parent: 'root', trashed: true },
                { id: 'root-2', name: 'AI Planner', mimeType: FOLDER_MIME, parent: 'root' },
                { id: 'v-2', name: 'Voice notes', mimeType: FOLDER_MIME, parent: 'root-2' },
            ],
        });
        const ref = userRef();
        await expect(ensureNotesFolder(drive, { kind: 'voiceNote', userRef: ref, cachedFolders: { root: 'old-root' } })).resolves.toBe('v-2');
        expect(drive.files.create).not.toHaveBeenCalled();
        expect(ref.set).toHaveBeenCalledWith({ driveFolders: { root: 'root-2', voiceNote: 'v-2' } }, { merge: true });
    });

    test('Drive errors other than 404 are not swallowed', async () => {
        const drive = fakeDrive();
        const err = new Error('Rate limit');
        err.code = 429;
        drive.files.get.mockRejectedValueOnce(err);
        await expect(ensureNotesFolder(drive, { kind: 'journal', userRef: userRef(), cachedFolders: { journal: 'j-1' } })).rejects.toThrow('Rate limit');
    });

    test('an unknown folder kind is a programming error', async () => {
        await expect(ensureNotesFolder(fakeDrive(), { kind: 'photos', userRef: userRef() })).rejects.toThrow('Unknown Drive folder kind');
    });
});

describe('Drive files', () => {
    test('uploadFile streams the bytes with the right name, type and parent', async () => {
        const drive = fakeDrive();
        const file = await uploadFile(drive, { name: '2026-01-02 Journal 1.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('abc'), parentId: 'f-1' });
        const arg = drive.files.create.mock.calls[0][0];
        expect(arg.requestBody).toEqual({ name: '2026-01-02 Journal 1.jpg', parents: ['f-1'] });
        expect(arg.media.mimeType).toBe('image/jpeg');
        const chunks = [];
        for await (const chunk of arg.media.body) chunks.push(Buffer.from(chunk));
        expect(Buffer.concat(chunks).toString()).toBe('abc');
        expect(arg.fields).toBe('id,webViewLink');
        expect(file).toEqual({ id: 'id-1', webViewLink: 'https://drive.google.com/file/d/id-1/view' });
    });

    test('createDoc converts plain text into a Google Doc', async () => {
        const drive = fakeDrive();
        await createDoc(drive, { name: '2026-01-02 Journal', text: 'Hello', parentId: 'f-1' });
        expect(drive.files.create).toHaveBeenCalledWith({
            requestBody: { name: '2026-01-02 Journal', mimeType: DOC_MIME, parents: ['f-1'] },
            media: { mimeType: 'text/plain', body: 'Hello' },
            fields: 'id,webViewLink',
        });
    });

    test('links fall back to the standard URLs when Drive omits webViewLink', async () => {
        const drive = { files: { create: jest.fn().mockResolvedValue({ data: { id: 'x1' } }) } };
        await expect(uploadFile(drive, { name: 'a', mimeType: 'image/png', buffer: Buffer.from('a'), parentId: 'p' }))
            .resolves.toEqual({ id: 'x1', webViewLink: 'https://drive.google.com/file/d/x1/view' });
        await expect(createDoc(drive, { name: 'a', text: 'b', parentId: 'p' }))
            .resolves.toEqual({ id: 'x1', webViewLink: 'https://docs.google.com/document/d/x1/edit' });
    });

    test('trashFile moves a file to the Drive trash instead of deleting it', async () => {
        const drive = { files: { update: jest.fn().mockResolvedValue({ data: {} }) } };
        await trashFile(drive, 'id-7');
        expect(drive.files.update).toHaveBeenCalledWith({ fileId: 'id-7', requestBody: { trashed: true } });
    });

    test('fileExists matches files (not folders) by exact name in the folder', async () => {
        const drive = fakeDrive({
            files: [
                { id: 'd1', name: "2026-01-02 Brain dump", mimeType: DOC_MIME, parent: 'f-1' },
                { id: 'd2', name: "Mum's notes", mimeType: DOC_MIME, parent: 'f-1' },
            ],
        });
        await expect(fileExists(drive, { name: '2026-01-02 Brain dump', parentId: 'f-1' })).resolves.toBe(true);
        await expect(fileExists(drive, { name: '2026-01-02 Brain dump', parentId: 'f-2' })).resolves.toBe(false);
        await expect(fileExists(drive, { name: "Mum's notes", parentId: 'f-1' })).resolves.toBe(true);
    });

    test('query values are quoted and escaped', () => {
        expect(quoteQuery("it's")).toBe("'it\\'s'");
        expect(quoteQuery('a\\b')).toBe("'a\\\\b'");
        expect(folderUrl('abc')).toBe('https://drive.google.com/drive/folders/abc');
    });
});

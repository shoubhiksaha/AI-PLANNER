jest.mock('firebase-functions/params', () => ({
    defineSecret: jest.fn(() => ({ value: () => 'test-encryption-key-for-jest' })),
}));

const mockDatabasesRetrieve = jest.fn();
const mockDataSourcesQuery = jest.fn();
const mockPagesCreate = jest.fn();
const mockBlocksAppend = jest.fn();

jest.mock('@notionhq/client', () => ({
    Client: jest.fn(() => ({
        databases: { retrieve: mockDatabasesRetrieve },
        dataSources: { query: mockDataSourcesQuery },
        pages: { create: mockPagesCreate },
        blocks: { children: { append: mockBlocksAppend } },
    })),
}));

jest.mock('notion-multipart-uploader', () => ({ uploadToNotion: jest.fn() }));

const {
    syncBrainDumpToNotion,
    normalizeBrainDumpText,
    buildParagraphBlocks,
    createPageInDatabase,
    getDecryptedNotionKeyAndMigrate,
    encrypt,
} = require('../services/notion');
const utils = require('../utils');

describe('notion service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockDatabasesRetrieve.mockResolvedValue({
            data_sources: [{ id: 'data-source-1' }],
        });
        mockDataSourcesQuery.mockResolvedValue({ results: [] });
        mockPagesCreate.mockResolvedValue({ id: 'page-1' });
    });

    test('normalizeBrainDumpText trims strings and rejects non-strings', () => {
        expect(normalizeBrainDumpText('  hello  ')).toBe('hello');
        expect(normalizeBrainDumpText(null)).toBe('');
        expect(normalizeBrainDumpText(123)).toBe('');
    });

    test('syncBrainDumpToNotion returns reason when there is no text or image', async () => {
        const result = await syncBrainDumpToNotion({ date: '2025-01-01', brainDump: '   ' }, 'ntn_test_token_1234567890', 'db-id', null);
        expect(result).toEqual({
            ok: false,
            reason: 'Nothing to save (no Brain Dump text and no image uploaded).',
        });
    });

    test('syncBrainDumpToNotion queries dataSources and creates page with text and image', async () => {
        const result = await syncBrainDumpToNotion(
            { date: '2025-01-01', brainDump: 'Ideas here' },
            'ntn_test_token_1234567890',
            'db-id',
            'file-123'
        );

        expect(result).toEqual({ ok: true, status: 'created' });
        expect(mockDatabasesRetrieve).toHaveBeenCalledWith({ database_id: 'db-id' });
        expect(mockDataSourcesQuery).toHaveBeenCalledWith({
            data_source_id: 'data-source-1',
            filter: { property: 'Name', title: { equals: 'Brain Dump - 2025-01-01' } },
        });
        expect(mockPagesCreate).toHaveBeenCalledWith(expect.objectContaining({
            parent: { type: 'data_source_id', data_source_id: 'data-source-1' },
        }));
    });

    test('syncBrainDumpToNotion reports duplicate pages', async () => {
        mockDataSourcesQuery.mockResolvedValue({ results: [{ id: 'existing-page' }] });

        const result = await syncBrainDumpToNotion(
            { date: '2025-01-01', brainDump: 'Ideas here' },
            'ntn_test_token_1234567890',
            'db-id',
            null
        );

        expect(result).toEqual({ ok: true, status: 'duplicate' });
        expect(mockPagesCreate).not.toHaveBeenCalled();
    });

    test('syncBrainDumpToNotion surfaces API errors', async () => {
        mockPagesCreate.mockRejectedValue(new Error('Could not find property with name: Name'));

        const result = await syncBrainDumpToNotion(
            { date: '2025-01-01', brainDump: 'Ideas here' },
            'ntn_test_token_1234567890',
            'db-id',
            null
        );

        expect(result.ok).toBe(false);
        expect(result.reason).toContain('Could not find property with name: Name');
    });

    test('buildParagraphBlocks splits long paragraphs into ≤2000-char rich_text (B-10)', () => {
        const blocks = buildParagraphBlocks(`short\n\n${'a'.repeat(4100)}`);
        expect(blocks).toHaveLength(4);
        expect(blocks.map(b => b.paragraph.rich_text[0].text.content.length)).toEqual([5, 2000, 2000, 100]);
    });

    test('createPageInDatabase sends 100 children then appends the rest (B-10)', async () => {
        const notion = new (require('@notionhq/client').Client)();
        const children = Array.from({ length: 250 }, (_, i) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: String(i) } }] } }));
        await createPageInDatabase(notion, 'db-id', { properties: {}, children });
        expect(mockPagesCreate.mock.calls[0][0].children).toHaveLength(100);
        expect(mockBlocksAppend).toHaveBeenCalledTimes(2);
        expect(mockBlocksAppend.mock.calls[0][0]).toEqual({ block_id: 'page-1', children: children.slice(100, 200) });
        expect(mockBlocksAppend.mock.calls[1][0].children).toHaveLength(50);
    });

    test('brain dump text longer than 2000 characters is chunked', async () => {
        const result = await syncBrainDumpToNotion({ date: '2025-01-01', brainDump: 'b'.repeat(2500) }, 'ntn_test_token_1234567890', 'db-id', null);
        expect(result).toEqual({ ok: true, status: 'created' });
        const texts = mockPagesCreate.mock.calls[0][0].children.map(c => c.paragraph.rich_text[0].text.content.length);
        expect(texts).toEqual([2000, 500]);
    });

    describe('getDecryptedNotionKeyAndMigrate (B-25)', () => {
        const key = utils.deriveKey('test-encryption-key-for-jest');
        const userRef = { id: 'owner@example.com', set: jest.fn().mockResolvedValue() };

        beforeEach(() => userRef.set.mockClear());

        test('legacy CBC iv:cipher is decrypted and re-encrypted, not used as plaintext', async () => {
            const crypto = require('crypto');
            const iv = crypto.randomBytes(16);
            const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
            const legacy = iv.toString('hex') + ':' + cipher.update('secret_legacy_token_123', 'utf8', 'hex') + cipher.final('hex');

            const value = await getDecryptedNotionKeyAndMigrate(userRef, { notionKey: legacy });
            expect(value).toBe('secret_legacy_token_123');
            expect(userRef.set).toHaveBeenCalledWith({ notionKey: expect.stringMatching(/^v3:/) }, { merge: true });
        });

        test('undecryptable legacy ciphertext returns null and is not migrated', async () => {
            const value = await getDecryptedNotionKeyAndMigrate(userRef, { notionKey: `${'0'.repeat(32)}:${'1'.repeat(32)}` });
            expect(value).toBeNull();
            expect(userRef.set).not.toHaveBeenCalled();
        });

        test('plaintext tokens are migrated to v3', async () => {
            const value = await getDecryptedNotionKeyAndMigrate(userRef, { notionKey: 'ntn_plaintext_token_123456' });
            expect(value).toBe('ntn_plaintext_token_123456');
            expect(userRef.set).toHaveBeenCalledTimes(1);
        });

        test('v3 round-trip: a bound key decrypts for its owner without re-saving', async () => {
            const stored = encrypt('ntn_owner_token_1234567890', 'owner@example.com');
            expect(stored).toMatch(/^v3:/);
            await expect(getDecryptedNotionKeyAndMigrate(userRef, { notionKey: stored })).resolves.toBe('ntn_owner_token_1234567890');
            expect(userRef.set).not.toHaveBeenCalled();
        });

        test('a v3 ciphertext copied into another user\'s document does not decrypt', async () => {
            const stored = encrypt('ntn_owner_token_1234567890', 'owner@example.com');
            const otherRef = { id: 'attacker@example.com', set: jest.fn() };
            await expect(getDecryptedNotionKeyAndMigrate(otherRef, { notionKey: stored })).resolves.toBeNull();
            // An explicit email wins over the document id.
            await expect(getDecryptedNotionKeyAndMigrate(otherRef, { notionKey: stored }, 'owner@example.com')).resolves.toBe('ntn_owner_token_1234567890');
            expect(otherRef.set).not.toHaveBeenCalled();
        });

        test('v2 → v3 lazy migration: decrypts the legacy key and saves a v3 bound to the owner', async () => {
            const v2 = utils.encrypt('ntn_v2_token_1234567890', key);
            const value = await getDecryptedNotionKeyAndMigrate(userRef, { notionKey: v2 });
            expect(value).toBe('ntn_v2_token_1234567890');
            const saved = userRef.set.mock.calls[0][0].notionKey;
            expect(saved).toMatch(/^v3:/);
            expect(utils.decryptBoundGcm(saved, key, utils.keyBindingAad('owner@example.com', 'notionKey'))).toBe('ntn_v2_token_1234567890');
        });

        test('a failed v3 re-save never fails the request', async () => {
            userRef.set.mockRejectedValueOnce(new Error('firestore down'));
            const v2 = utils.encrypt('ntn_v2_token_1234567890', key);
            await expect(getDecryptedNotionKeyAndMigrate(userRef, { notionKey: v2 })).resolves.toBe('ntn_v2_token_1234567890');
        });

        test('without an owner email a v3 key cannot be decrypted', async () => {
            const stored = encrypt('ntn_owner_token_1234567890', 'owner@example.com');
            await expect(getDecryptedNotionKeyAndMigrate({ set: jest.fn() }, { notionKey: stored })).resolves.toBeNull();
        });
    });
});

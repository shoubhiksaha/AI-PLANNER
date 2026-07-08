jest.mock('firebase-functions/params', () => ({
    defineSecret: jest.fn(() => ({ value: () => 'test-encryption-key-for-jest' })),
}));

const mockDatabasesRetrieve = jest.fn();
const mockDataSourcesQuery = jest.fn();
const mockPagesCreate = jest.fn();

jest.mock('@notionhq/client', () => ({
    Client: jest.fn(() => ({
        databases: { retrieve: mockDatabasesRetrieve },
        dataSources: { query: mockDataSourcesQuery },
        pages: { create: mockPagesCreate },
    })),
}));

const { syncBrainDumpToNotion, normalizeBrainDumpText } = require('../services/notion');

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
            reason: 'Nothing to save (no text, image, or audio uploaded).',
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
});

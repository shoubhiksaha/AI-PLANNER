const { UniversalAIAdapter } = require('../services/UniversalAIAdapter');

describe('UniversalAIAdapter', () => {
    beforeEach(() => {
        global.fetch = jest.fn();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('OpenAI provider successfully returns extracted text', async () => {
        const adapter = new UniversalAIAdapter({ apiKey: 'sk-123', provider: 'openai', modelName: 'gpt-4o' });
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: '```json\n{"date": "2025-01-01"}\n```' } }]
            })
        });

        const result = await adapter.chat('system prompt', 'user prompt', [{ mimeType: 'image/jpeg', base64Data: 'fake' }], 'test-req');
        expect(result).toBe('```json\n{"date": "2025-01-01"}\n```');
    });

    test('Google provider successfully returns extracted text', async () => {
        const adapter = new UniversalAIAdapter({ apiKey: 'ai-123', provider: 'google', modelName: 'gemini-1.5-flash' });
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                candidates: [{ content: { parts: [{ text: '{"date": "2025-01-01"}' }] } }]
            })
        });

        const result = await adapter.chat('system', 'user', [{ mimeType: 'image/jpeg', base64Data: 'fake' }], 'test-req');
        expect(result).toBe('{"date": "2025-01-01"}');
    });

    test('Anthropic provider throws error on non-OK response', async () => {
        const adapter = new UniversalAIAdapter({ apiKey: 'ant-123', provider: 'anthropic', modelName: 'claude-3-opus' });
        global.fetch.mockResolvedValue({
            ok: false,
            status: 400,
            text: async () => 'Bad Request'
        });

        await expect(adapter.chat('system', 'user', [{ mimeType: 'image/jpeg', base64Data: 'fake' }], 'test-req'))
            .rejects.toThrow('Anthropic API Er'); // To match either Anthropic API Error: 400 or just throw format
    });

    test('Unsupported provider fallback creates correct payload', async () => {
        const adapter = new UniversalAIAdapter({ apiKey: 'cust-123', provider: 'other', baseUrl: 'https://api.other.com/v1/chat/completions', modelName: 'custom-model' });
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: '{"success": true}' } }]
            })
        });

        const result = await adapter.chat('system', 'user', [], 'test-req');
        expect(result).toBe('{"success": true}');
        expect(global.fetch).toHaveBeenCalledWith('https://api.other.com/v1/chat/completions', expect.objectContaining({
            headers: expect.objectContaining({ 'Authorization': 'Bearer cust-123' })
        }));
    });

    test('Anthropic provider successfully returns extracted text', async () => {
        const adapter = new UniversalAIAdapter({ apiKey: 'ant-123', provider: 'anthropic', modelName: 'claude-3-5-sonnet' });
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                content: [{ text: '{"success": true}' }]
            })
        });

        const result = await adapter.chat('system', 'user', [{ mimeType: 'image/jpeg', base64Data: 'fake' }], 'test-req');
        expect(result).toBe('{"success": true}');
    });

    test('Throws error when choices/candidates are missing', async () => {
        const adapter = new UniversalAIAdapter({ apiKey: 'sk-123', provider: 'openai', modelName: 'gpt-4o' });
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [] // empty
            })
        });

        await expect(adapter.chat('system', 'user', [], 'test-req'))
            .rejects.toThrow('No extraction returned');
    });

    test('Handles OpenRouter fallback payload construction correctly', async () => {
        const adapter = new UniversalAIAdapter({ apiKey: 'sk-123', provider: 'openrouter', modelName: 'meta-llama/llama-3.1-70b-instruct' });
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'success text' } }]
            })
        });

        const result = await adapter.chat('system', 'user', [], 'test-req');
        expect(result).toBe('success text');
        expect(global.fetch).toHaveBeenCalledWith('https://openrouter.ai/api/v1/chat/completions', expect.any(Object));
    });
});

const { UniversalAIAdapter } = require('../services/UniversalAIAdapter');

describe('UniversalAIAdapter', () => {
    beforeEach(() => {
        global.fetch = jest.fn();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    // ──────────────────────────────────────────────────────────────────────────
    // Constructor & URL auto-configuration
    // ──────────────────────────────────────────────────────────────────────────
    describe('constructor', () => {
        test('throws if apiKey is missing', () => {
            expect(() => new UniversalAIAdapter({ provider: 'openai' }))
                .toThrow('API Key is required');
        });

        test('defaults to openai provider and gpt-4o model', () => {
            const a = new UniversalAIAdapter({ apiKey: 'k' });
            expect(a.provider).toBe('openai');
            expect(a.modelName).toBe('gpt-4o');
            expect(a.baseUrl).toBe('https://api.openai.com/v1/chat/completions');
        });

        test('auto-configures google URL with model name', () => {
            const a = new UniversalAIAdapter({ apiKey: 'k', provider: 'google', modelName: 'gemini-pro' });
            expect(a.baseUrl).toContain('gemini-pro');
        });

        test('respects custom baseUrl over auto-config', () => {
            const a = new UniversalAIAdapter({ apiKey: 'k', provider: 'openai', baseUrl: 'https://custom.api.com' });
            expect(a.baseUrl).toBe('https://custom.api.com');
        });

        test('groq gets correct base URL', () => {
            const a = new UniversalAIAdapter({ apiKey: 'k', provider: 'groq' });
            expect(a.baseUrl).toBe('https://api.groq.com/openai/v1/chat/completions');
        });

        test('deepseek gets correct base URL', () => {
            const a = new UniversalAIAdapter({ apiKey: 'k', provider: 'deepseek' });
            expect(a.baseUrl).toBe('https://api.deepseek.com/v1/chat/completions');
        });
    });

    // ──────────────────────────────────────────────────────────────────────────
    // OpenAI-compatible providers
    // ──────────────────────────────────────────────────────────────────────────
    describe('OpenAI-compatible providers', () => {
        test('openai: returns content from choices[0].message.content', async () => {
            const adapter = new UniversalAIAdapter({ apiKey: 'sk-123', provider: 'openai', modelName: 'gpt-4o' });
            global.fetch.mockResolvedValue({
                ok: true,
                json: async () => ({ choices: [{ message: { content: '{"date": "2025-01-01"}' } }] })
            });
            const result = await adapter.chat('sys', 'usr', [{ mimeType: 'image/jpeg', base64Data: 'abc' }], 'req-1');
            expect(result).toBe('{"date": "2025-01-01"}');
        });

        test('openai: includes image_url objects in userContent', async () => {
            const adapter = new UniversalAIAdapter({ apiKey: 'sk-123', provider: 'openai' });
            global.fetch.mockResolvedValue({
                ok: true,
                json: async () => ({ choices: [{ message: { content: '{}' } }] })
            });
            await adapter.chat('sys', 'usr', [{ mimeType: 'image/png', base64Data: 'base64data' }], 'req');
            const body = JSON.parse(global.fetch.mock.calls[0][1].body);
            const userContent = body.messages[1].content;
            expect(userContent).toContainEqual(expect.objectContaining({ type: 'image_url' }));
        });

        test('openai: throws on non-OK HTTP response', async () => {
            const adapter = new UniversalAIAdapter({ apiKey: 'sk-123', provider: 'openai' });
            global.fetch.mockResolvedValue({ ok: false, status: 401, text: async () => 'Unauthorized' });
            await expect(adapter.chat('s', 'u', [], 'req')).rejects.toThrow('openai API Error: 401');
        });

        test('openai: throws "No extraction returned" on empty choices', async () => {
            const adapter = new UniversalAIAdapter({ apiKey: 'sk-123', provider: 'openai' });
            global.fetch.mockResolvedValue({ ok: true, json: async () => ({ choices: [] }) });
            await expect(adapter.chat('s', 'u', [], 'req')).rejects.toThrow('No extraction returned');
        });

        test('openai: throws when message.content is not a string', async () => {
            const adapter = new UniversalAIAdapter({ apiKey: 'sk-123', provider: 'openai' });
            global.fetch.mockResolvedValue({
                ok: true,
                json: async () => ({ choices: [{ message: { content: null } }] })
            });
            await expect(adapter.chat('s', 'u', [], 'req')).rejects.toThrow('No extraction returned');
        });

        test('ollama: strips response_format and sets stream:false', async () => {
            const adapter = new UniversalAIAdapter({ apiKey: 'k', provider: 'ollama', baseUrl: 'http://localhost:11434' });
            global.fetch.mockResolvedValue({
                ok: true,
                json: async () => ({ choices: [{ message: { content: '{}' } }] })
            });
            await adapter.chat('s', 'u', [], 'req');
            const body = JSON.parse(global.fetch.mock.calls[0][1].body);
            expect(body.response_format).toBeUndefined();
            expect(body.stream).toBe(false);
        });

        test('azure: builds deployment URL with api-version', async () => {
            const adapter = new UniversalAIAdapter({
                apiKey: 'az-key', provider: 'azure',
                baseUrl: 'https://my.openai.azure.com',
                apiVersion: '2024-02-01', modelName: 'gpt-4'
            });
            global.fetch.mockResolvedValue({
                ok: true,
                json: async () => ({ choices: [{ message: { content: '{}' } }] })
            });
            await adapter.chat('s', 'u', [], 'req');
            const calledUrl = global.fetch.mock.calls[0][0];
            expect(calledUrl).toContain('gpt-4');
            expect(calledUrl).toContain('api-version=2024-02-01');
        });

        test('azure: sends api-key header not Authorization', async () => {
            const adapter = new UniversalAIAdapter({
                apiKey: 'az-key', provider: 'azure',
                baseUrl: 'https://my.openai.azure.com', modelName: 'gpt-4'
            });
            global.fetch.mockResolvedValue({
                ok: true,
                json: async () => ({ choices: [{ message: { content: '{}' } }] })
            });
            await adapter.chat('s', 'u', [], 'req');
            const headers = global.fetch.mock.calls[0][1].headers;
            expect(headers['api-key']).toBe('az-key');
            expect(headers['Authorization']).toBeUndefined();
        });

        test('openrouter: sends HTTP-Referer and X-Title headers', async () => {
            const adapter = new UniversalAIAdapter({ apiKey: 'or-key', provider: 'openrouter', modelName: 'meta-llama/llama-3' });
            global.fetch.mockResolvedValue({
                ok: true,
                json: async () => ({ choices: [{ message: { content: '{}' } }] })
            });
            await adapter.chat('s', 'u', [], 'req');
            const headers = global.fetch.mock.calls[0][1].headers;
            expect(headers['HTTP-Referer']).toContain('ai-planner');
            expect(headers['X-Title']).toBe('AI Planner');
        });

        test('unknown custom provider falls back to openai-compatible format', async () => {
            const adapter = new UniversalAIAdapter({
                apiKey: 'cust-key', provider: 'mycompany',
                baseUrl: 'https://api.mycompany.com/v1/chat', modelName: 'custom-model'
            });
            global.fetch.mockResolvedValue({
                ok: true,
                json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] })
            });
            const result = await adapter.chat('s', 'u', [], 'req');
            expect(result).toBe('{"ok":true}');
        });
    });

    // ──────────────────────────────────────────────────────────────────────────
    // Google provider
    // ──────────────────────────────────────────────────────────────────────────
    describe('Google provider (_chatGoogle)', () => {
        test('returns text from candidates[0].content.parts[0].text', async () => {
            const adapter = new UniversalAIAdapter({ apiKey: 'ai-key', provider: 'google', modelName: 'gemini-1.5-flash' });
            global.fetch.mockResolvedValue({
                ok: true,
                json: async () => ({
                    candidates: [{ content: { parts: [{ text: '{"date":"2025-01-01"}' }] } }]
                })
            });
            const result = await adapter.chat('sys', 'usr', [], 'req');
            expect(result).toBe('{"date":"2025-01-01"}');
        });

        test('appends API key to URL as query param', async () => {
            const adapter = new UniversalAIAdapter({ apiKey: 'my-secret-key', provider: 'google', modelName: 'gemini-pro' });
            global.fetch.mockResolvedValue({
                ok: true,
                json: async () => ({ candidates: [{ content: { parts: [{ text: '{}' }] } }] })
            });
            await adapter.chat('s', 'u', [], 'req');
            const calledUrl = global.fetch.mock.calls[0][0];
            expect(calledUrl).toContain('key=my-secret-key');
        });

        test('throws "No extraction returned" when candidates array is empty', async () => {
            const adapter = new UniversalAIAdapter({ apiKey: 'k', provider: 'google', modelName: 'gemini-pro' });
            global.fetch.mockResolvedValue({ ok: true, json: async () => ({ candidates: [] }) });
            await expect(adapter.chat('s', 'u', [], 'req')).rejects.toThrow('No extraction returned');
        });

        test('throws on non-OK HTTP response', async () => {
            const adapter = new UniversalAIAdapter({ apiKey: 'k', provider: 'google', modelName: 'gemini-pro' });
            global.fetch.mockResolvedValue({ ok: false, status: 403, text: async () => 'Forbidden' });
            await expect(adapter.chat('s', 'u', [], 'req')).rejects.toThrow('Google API Error: 403');
        });

        test('sends image as inlineData part', async () => {
            const adapter = new UniversalAIAdapter({ apiKey: 'k', provider: 'google', modelName: 'gemini-pro' });
            global.fetch.mockResolvedValue({
                ok: true,
                json: async () => ({ candidates: [{ content: { parts: [{ text: '{}' }] } }] })
            });
            await adapter.chat('sys', 'usr', [{ mimeType: 'image/jpeg', base64Data: 'b64' }], 'req');
            const body = JSON.parse(global.fetch.mock.calls[0][1].body);
            const parts = body.contents[0].parts;
            expect(parts).toContainEqual(expect.objectContaining({ inlineData: { mimeType: 'image/jpeg', data: 'b64' } }));
        });
    });

    // ──────────────────────────────────────────────────────────────────────────
    // Anthropic provider
    // ──────────────────────────────────────────────────────────────────────────
    describe('Anthropic provider (_chatAnthropic)', () => {
        test('returns raw text from content[0].text', async () => {
            const adapter = new UniversalAIAdapter({ apiKey: 'ant-key', provider: 'anthropic', modelName: 'claude-3-opus' });
            global.fetch.mockResolvedValue({
                ok: true,
                json: async () => ({ content: [{ text: '{"result":"ok"}' }] })
            });
            const result = await adapter.chat('sys', 'usr', [], 'req');
            expect(result).toBe('{"result":"ok"}');
        });

        test('strips ```json markdown code fence from Claude response', async () => {
            const adapter = new UniversalAIAdapter({ apiKey: 'ant-key', provider: 'anthropic', modelName: 'claude-3-5-sonnet' });
            global.fetch.mockResolvedValue({
                ok: true,
                json: async () => ({ content: [{ text: '```json\n{"date":"2025-01-01"}\n```' }] })
            });
            const result = await adapter.chat('sys', 'usr', [], 'req');
            expect(result).toBe('{"date":"2025-01-01"}');
        });

        test('sends images as base64 source blocks', async () => {
            const adapter = new UniversalAIAdapter({ apiKey: 'ant-key', provider: 'anthropic', modelName: 'claude-3-opus' });
            global.fetch.mockResolvedValue({
                ok: true,
                json: async () => ({ content: [{ text: '{}' }] })
            });
            await adapter.chat('sys', 'usr', [{ mimeType: 'image/png', base64Data: 'imgdata' }], 'req');
            const body = JSON.parse(global.fetch.mock.calls[0][1].body);
            expect(body.messages[0].content[0]).toMatchObject({
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'imgdata' }
            });
        });

        test('sends x-api-key header', async () => {
            const adapter = new UniversalAIAdapter({ apiKey: 'ant-key', provider: 'anthropic', modelName: 'claude-3-opus' });
            global.fetch.mockResolvedValue({
                ok: true,
                json: async () => ({ content: [{ text: '{}' }] })
            });
            await adapter.chat('s', 'u', [], 'req');
            const headers = global.fetch.mock.calls[0][1].headers;
            expect(headers['x-api-key']).toBe('ant-key');
            expect(headers['anthropic-version']).toBe('2023-06-01');
        });

        test('throws "No extraction returned" when content array is empty', async () => {
            const adapter = new UniversalAIAdapter({ apiKey: 'ant-key', provider: 'anthropic', modelName: 'claude-3-opus' });
            global.fetch.mockResolvedValue({ ok: true, json: async () => ({ content: [] }) });
            await expect(adapter.chat('s', 'u', [], 'req')).rejects.toThrow('No extraction returned');
        });

        test('throws on non-OK HTTP response', async () => {
            const adapter = new UniversalAIAdapter({ apiKey: 'ant-key', provider: 'anthropic', modelName: 'claude-3-opus' });
            global.fetch.mockResolvedValue({ ok: false, status: 529, text: async () => 'Overloaded' });
            await expect(adapter.chat('s', 'u', [], 'req')).rejects.toThrow('Anthropic API Error: 529');
        });
    });

    // ──────────────────────────────────────────────────────────────────────────
    // Cohere provider
    // ──────────────────────────────────────────────────────────────────────────
    describe('Cohere provider (_chatCohere)', () => {
        test('returns text from v2 message.content[0].text', async () => {
            const adapter = new UniversalAIAdapter({ apiKey: 'co-key', provider: 'cohere', modelName: 'command-r' });
            global.fetch.mockResolvedValue({
                ok: true,
                json: async () => ({ message: { content: [{ text: '{"answer":"ok"}' }] } })
            });
            const result = await adapter.chat('sys', 'usr', [], 'req');
            expect(result).toBe('{"answer":"ok"}');
        });

        test('falls back to data.text for v1 format', async () => {
            const adapter = new UniversalAIAdapter({ apiKey: 'co-key', provider: 'cohere', modelName: 'command' });
            global.fetch.mockResolvedValue({
                ok: true,
                json: async () => ({ text: 'v1 response text' })
            });
            const result = await adapter.chat('sys', 'usr', [], 'req');
            expect(result).toBe('v1 response text');
        });

        test('images are ignored (Cohere does not support vision)', async () => {
            const adapter = new UniversalAIAdapter({ apiKey: 'co-key', provider: 'cohere', modelName: 'command-r' });
            global.fetch.mockResolvedValue({
                ok: true,
                json: async () => ({ message: { content: [{ text: '{}' }] } })
            });
            // Should not throw even when images are passed
            await expect(
                adapter.chat('s', 'u', [{ mimeType: 'image/jpeg', base64Data: 'b64' }], 'req')
            ).resolves.toBe('{}');
        });

        test('throws on non-OK HTTP response', async () => {
            const adapter = new UniversalAIAdapter({ apiKey: 'co-key', provider: 'cohere', modelName: 'command-r' });
            global.fetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'Server Error' });
            await expect(adapter.chat('s', 'u', [], 'req')).rejects.toThrow('Cohere API Error: 500');
        });
    });

    // ──────────────────────────────────────────────────────────────────────────
    // HuggingFace provider
    // ──────────────────────────────────────────────────────────────────────────
    describe('HuggingFace provider (_chatHuggingFace)', () => {
        test('returns generated_text from array response', async () => {
            const adapter = new UniversalAIAdapter({ apiKey: 'hf-key', provider: 'huggingface', modelName: 'mistral-7b' });
            global.fetch.mockResolvedValue({
                ok: true,
                json: async () => ([{ generated_text: '{"ok":true}' }])
            });
            const result = await adapter.chat('sys', 'usr', [], 'req');
            expect(result).toBe('{"ok":true}');
        });

        test('returns JSON stringified data if response is not array', async () => {
            const adapter = new UniversalAIAdapter({ apiKey: 'hf-key', provider: 'huggingface', modelName: 'gpt2' });
            global.fetch.mockResolvedValue({
                ok: true,
                json: async () => ({ error: 'Loading' })
            });
            const result = await adapter.chat('s', 'u', [], 'req');
            expect(result).toContain('Loading');
        });

        test('combines systemPrompt and userPrompt into single inputs string', async () => {
            const adapter = new UniversalAIAdapter({ apiKey: 'hf-key', provider: 'huggingface', modelName: 'gpt2' });
            global.fetch.mockResolvedValue({
                ok: true,
                json: async () => ([{ generated_text: '{}' }])
            });
            await adapter.chat('THE SYSTEM', 'THE USER', [], 'req');
            const body = JSON.parse(global.fetch.mock.calls[0][1].body);
            expect(body.inputs).toContain('THE SYSTEM');
            expect(body.inputs).toContain('THE USER');
        });

        test('throws on non-OK HTTP response', async () => {
            const adapter = new UniversalAIAdapter({ apiKey: 'hf-key', provider: 'huggingface', modelName: 'gpt2' });
            global.fetch.mockResolvedValue({ ok: false, status: 503, text: async () => 'Unavailable' });
            await expect(adapter.chat('s', 'u', [], 'req')).rejects.toThrow('HuggingFace API Error: 503');
        });
    });
});

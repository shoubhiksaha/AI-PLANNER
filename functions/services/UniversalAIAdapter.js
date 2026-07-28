const { logger } = require('firebase-functions/logger');
const https = require('https');
const {
    isPrivateOrReservedIp,
    validateBYOKBaseUrl
} = require('../utils');

const MAX_AI_RESPONSE_BYTES = 2 * 1024 * 1024;
const AI_REQUEST_TIMEOUT_MS = 120000;

/**
 * Strips common markdown code-fence wrappers that some LLMs add around JSON.
 * e.g. ```json\n{...}\n``` → {...}
 * @param {string} raw
 * @returns {string}
 */
function stripMarkdownFences(raw) {
    if (typeof raw !== 'string') return raw;
    return raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .trim();
}

class UniversalAIAdapter {
    /**
     * Initializes the universal AI adapter for handling multiple LLM architectures.
     *
     * Supported providers and their native API formats:
     *  - openai      → /v1/chat/completions  (OpenAI spec)
     *  - anthropic   → /v1/messages          (Anthropic spec — distinct body/headers)
     *  - google      → Gemini generateContent (Google spec — distinct body structure)
     *  - cohere      → /v2/chat              (Cohere spec — distinct message schema)
     *  - huggingface → /models/{id}          (HuggingFace Inference — "inputs" key)
     *  - xai         → /v1/chat/completions  (OpenAI-compatible, xAI Grok models)
     *  - groq        → /v1/chat/completions  (OpenAI-compatible)
     *  - deepseek    → /v1/chat/completions  (OpenAI-compatible)
     *  - mistral     → /v1/chat/completions  (OpenAI-compatible)
     *  - perplexity  → /chat/completions     (OpenAI-compatible)
     *  - together    → /v1/chat/completions  (OpenAI-compatible)
     *  - openrouter  → /v1/chat/completions  (OpenAI-compatible + extra headers)
     *  - azure       → /openai/deployments/… (OpenAI-compatible + api-key header)
     *  - ollama      → /api/chat             (OpenAI-compatible minus response_format)
     *  - local       → custom baseUrl        (OpenAI-compatible minus response_format)
     *
     * @param {Object} config
     * @param {string} config.apiKey
     * @param {string} config.provider
     * @param {string} config.modelName
     * @param {string} [config.baseUrl]
     * @param {string} [config.apiVersion]
     * @param {Function} [config.fetchImpl]
     */
    constructor(config) {
        if (!config.apiKey) throw new Error("API Key is required for BYOK Adapter");

        this.apiKey = config.apiKey;
        this.provider = (config.provider || 'openai').toLowerCase();
        this.modelName = config.modelName || 'gpt-4o';

        // node-fetch v2 supports a custom HTTPS agent, which lets custom BYOK
        // requests connect to the exact public address validated below.
        this._fetchImpl = config.fetchImpl
            || (process.env.NODE_ENV === 'test' ? global.fetch : require('node-fetch'));

        if (config.baseUrl) {
            try {
                const result = validateBYOKBaseUrl(config.baseUrl);
                if (!result.valid) throw new Error(result.error);
                this._customBaseUrl = true;
                this._dnsValidated = false;
                this._validatedAddresses = [];
                this.baseUrl = result.url;
            } catch (err) {
                throw new Error("Invalid BYOK Base URL: " + err.message);
            }
        }

        if (config.apiVersion) {
            // Prevent query parameter injection via apiVersion
            if (!/^[a-zA-Z0-9.-]+$/.test(config.apiVersion)) {
                throw new Error("Invalid API Version format");
            }
            this.apiVersion = config.apiVersion;
        }

        // Auto-configure known provider base URLs.
        // NOTE: Each provider here maps to a DIFFERENT API spec — changing the base
        // URL alone is insufficient. The _chat* methods below handle the distinct
        // body formatters, auth headers, and response shapes for each provider.
        if (!this.baseUrl) {
            const urlMap = {
                openai:      'https://api.openai.com/v1/chat/completions',
                anthropic:   'https://api.anthropic.com/v1/messages',
                google:      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.modelName)}:generateContent`,
                cohere:      'https://api.cohere.ai/v2/chat',
                huggingface: `https://api-inference.huggingface.co/models/${this.modelName}`,
                xai:         'https://api.x.ai/v1/chat/completions',
                groq:        'https://api.groq.com/openai/v1/chat/completions',
                deepseek:    'https://api.deepseek.com/v1/chat/completions',
                mistral:     'https://api.mistral.ai/v1/chat/completions',
                perplexity:  'https://api.perplexity.ai/chat/completions',
                together:    'https://api.together.xyz/v1/chat/completions',
                openrouter:  'https://openrouter.ai/api/v1/chat/completions',
            };
            this.baseUrl = urlMap[this.provider];
        }
        if (!this._customBaseUrl) this._customBaseUrl = false;
    }

    /**
     * DNS rebinding protection: resolves the custom baseUrl hostname and verifies
     * the resolved IP isn't an internal/private address. Called once before first request.
     */
    async _validateBaseUrlDns() {
        // Built-in provider endpoints are hardcoded HTTPS URLs — no DNS rebinding risk.
        if (this._dnsValidated || !this._customBaseUrl) return;

        try {
            const host = new URL(this.baseUrl).hostname.replace(/^\[|\]$/g, '');
            const dns = require('dns').promises;
            const validatedAddresses = [];

            // Check IPv4 resolved addresses
            try {
                const v4 = await dns.resolve4(host);
                for (const ip of v4) {
                    if (isPrivateOrReservedIp(ip)) {
                        throw new Error(`SSRF blocked: DNS resolved to private IPv4 ${ip}`);
                    }
                    validatedAddresses.push({ address: ip, family: 4 });
                }
            } catch (e) {
                if (e && e.message && e.message.includes('SSRF blocked')) throw e;
                // NODATA/NXDOMAIN for IPv4 is ok if IPv6 exists; handled below
            }

            // Check IPv6 resolved addresses
            try {
                const v6 = await dns.resolve6(host);
                for (const ip of v6) {
                    if (isPrivateOrReservedIp(ip)) {
                        throw new Error(`SSRF blocked: DNS resolved to private IPv6 ${ip}`);
                    }
                    validatedAddresses.push({ address: ip, family: 6 });
                }
            } catch (e) {
                if (e && e.message && e.message.includes('SSRF blocked')) throw e;
                // NODATA/NXDOMAIN for IPv6 is ok
            }

            if (validatedAddresses.length === 0) {
                throw new Error('SSRF blocked: Could not validate DNS for custom URL');
            }

            // Only mark validated after successful checks
            this._validatedAddresses = validatedAddresses;
            this._dnsValidated = true;
        } catch (dnsErr) {
            if (dnsErr && dnsErr.message && dnsErr.message.includes('SSRF blocked')) throw dnsErr;
            // Fail CLOSED: if DNS resolution completely fails, block the request
            throw new Error('SSRF blocked: Could not validate DNS for custom URL');
        }
    }

    _getPinnedHttpsAgent() {
        if (!this._customBaseUrl || this._validatedAddresses.length === 0) return undefined;
        const expectedHost = new URL(this.baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
        const pinned = this._validatedAddresses[0];
        return new https.Agent({
            keepAlive: false,
            lookup: (hostname, _options, callback) => {
                if (String(hostname).toLowerCase() !== expectedHost) {
                    return callback(new Error('SSRF blocked: unexpected outbound hostname'));
                }
                callback(null, pinned.address, pinned.family);
            }
        });
    }

    async _fetch(url, options) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
        try {
            const fetchOptions = {
                ...options,
                redirect: 'error',
                signal: controller.signal,
                size: MAX_AI_RESPONSE_BYTES
            };
            if (this._customBaseUrl) {
                fetchOptions.agent = this._getPinnedHttpsAgent();
            }
            const response = await this._fetchImpl(url, fetchOptions);
            const contentLength = Number(response?.headers?.get?.('content-length') || 0);
            if (contentLength > MAX_AI_RESPONSE_BYTES) {
                throw new Error('AI response exceeded maximum allowed size');
            }
            return response;
        } finally {
            clearTimeout(timeout);
        }
    }

    /**
     * Primary entry point. Routes to the correct provider-specific body formatter.
     *
     * @param {string} systemPrompt
     * @param {string} userPrompt
     * @param {Array<{mimeType: string, base64Data: string}>} images
     * @param {string} requestId - Used for tracing
     * @returns {Promise<string>} - The JSON string payload returned by the LLM
     */
    async chat(systemPrompt, userPrompt, images = [], requestId = "system") {
        // DNS rebinding check (runs once per instance)
        await this._validateBaseUrlDns();

        logger.info(`Routing via API Adapter for provider: ${this.provider}`, { requestId, model: this.modelName });

        // Providers that use the OpenAI /v1/chat/completions spec natively or compatibly.
        // These share the same body formatter; only auth headers differ slightly.
        const openaiCompatible = [
            'openai', 'groq', 'deepseek', 'mistral', 'perplexity',
            'together', 'openrouter', 'ollama', 'local', 'xai'
        ];

        if (openaiCompatible.includes(this.provider)) {
            return this._chatOpenAICompatible(systemPrompt, userPrompt, images, requestId);
        } else if (this.provider === 'azure') {
            // Azure uses the same OpenAI spec but a different URL structure and auth header.
            return this._chatOpenAICompatible(systemPrompt, userPrompt, images, requestId);
        } else if (this.provider === 'google') {
            // Google Gemini uses a completely different request/response schema.
            return this._chatGoogle(systemPrompt, userPrompt, images, requestId);
        } else if (this.provider === 'anthropic') {
            // Anthropic Messages API: system is a top-level field, not a message role.
            return this._chatAnthropic(systemPrompt, userPrompt, images, requestId);
        } else if (this.provider === 'cohere') {
            // Cohere v2 Chat API uses a distinct message schema and auth header.
            return this._chatCohere(systemPrompt, userPrompt, images, requestId);
        } else if (this.provider === 'huggingface') {
            // HuggingFace Inference API: uses "inputs" string key, no chat roles.
            return this._chatHuggingFace(systemPrompt, userPrompt, images, requestId);
        } else {
            // Fallback: try OpenAI-compatible format for any unknown "custom" provider
            logger.warn(`Unknown provider '${this.provider}', attempting OpenAI-compatible format.`, { requestId });
            return this._chatOpenAICompatible(systemPrompt, userPrompt, images, requestId);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FORMATTER: OpenAI-compatible
    // Covers: openai, groq, deepseek, mistral, perplexity, together,
    //         openrouter, ollama, local, xai, azure
    // ─────────────────────────────────────────────────────────────────────────
    async _chatOpenAICompatible(systemPrompt, userPrompt, images, requestId) {
        const url = this.provider === 'azure'
            ? `${this.baseUrl.replace(/\/$/, '')}/openai/deployments/${encodeURIComponent(this.modelName)}/chat/completions?api-version=${encodeURIComponent(this.apiVersion || '2023-05-15')}`
            : this.baseUrl;

        const headers = { "Content-Type": "application/json" };
        if (this.provider === 'azure') {
            headers["api-key"] = this.apiKey;
        } else {
            headers["Authorization"] = `Bearer ${this.apiKey}`;
        }

        // OpenRouter requires site-identification headers per their policy.
        if (this.provider === 'openrouter') {
            headers["HTTP-Referer"] = "https://ai-planner-project-467800.web.app";
            headers["X-Title"] = "AI Planner";
        }

        // Build the user content array (text + optional vision images)
        const userContent = [{ type: "text", text: userPrompt }];
        for (const img of images) {
            userContent.push({
                type: "image_url",
                image_url: { url: `data:${img.mimeType};base64,${img.base64Data}` }
            });
        }

        const messages = [];
        if (systemPrompt) {
            messages.push({ role: "system", content: systemPrompt });
        }
        messages.push({ role: "user", content: userContent });

        const payload = {
            model: this.modelName,
            messages,
            response_format: { type: "json_object" },
            temperature: 0.1
        };

        // Ollama / local servers don't support response_format; they also need stream: false.
        if (this.provider === 'ollama' || this.provider === 'local') {
            delete payload.response_format;
            payload.stream = false;
        }

        const response = await this._fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
        if (!response.ok) {
            const errBody = await response.text().catch(() => '');
            logger.error(`${this.provider} API Error: ${response.status}`, { requestId, body: errBody });
            throw new Error(`${this.provider} API Error: ${response.status}`);
        }

        const data = await response.json();
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== 'string') {
            throw new Error('No extraction returned');
        }
        return stripMarkdownFences(content);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FORMATTER: Google Gemini
    // Uses `systemInstruction` as a top-level field (distinct from OpenAI spec).
    // Vision images are passed as `inlineData` parts.
    // ─────────────────────────────────────────────────────────────────────────
    async _chatGoogle(systemPrompt, userPrompt, images, requestId) {
        const url = `${this.baseUrl}?key=${this.apiKey}`;
        const headers = { "Content-Type": "application/json" };

        // Build user message parts: text first, then image(s)
        const userParts = [{ text: userPrompt }];
        for (const img of images) {
            userParts.push({
                inlineData: { mimeType: img.mimeType, data: img.base64Data }
            });
        }

        const payload = {
            contents: [{ role: "user", parts: userParts }],
            generationConfig: {
                responseMimeType: "application/json",
                temperature: 0.1
            }
        };

        // Gemini supports systemInstruction as a dedicated top-level field.
        // This is the correct way — not by prepending it to the user message.
        if (systemPrompt) {
            payload.systemInstruction = {
                parts: [{ text: systemPrompt }]
            };
        }

        const response = await this._fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
        if (!response.ok) {
            const errBody = await response.text().catch(() => '');
            logger.error(`Google API Error: ${response.status}`, { requestId, body: errBody });
            throw new Error(`Google API Error: ${response.status}`);
        }

        const data = await response.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (typeof text !== 'string') {
            throw new Error('No extraction returned');
        }
        return stripMarkdownFences(text);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FORMATTER: Anthropic Messages API
    // Key differences from OpenAI:
    //   - `system` is a top-level string field, NOT a message role
    //   - `max_tokens` is REQUIRED at the root level
    //   - Auth via `x-api-key` header, not `Authorization: Bearer`
    //   - `anthropic-version` header is mandatory
    //   - Vision images use a `source.type: "base64"` structure
    // ─────────────────────────────────────────────────────────────────────────
    async _chatAnthropic(systemPrompt, userPrompt, images, requestId) {
        const headers = {
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json"
        };

        // Vision images must come BEFORE the text prompt in the content array
        const userContent = [];
        for (const img of images) {
            userContent.push({
                type: "image",
                source: {
                    type: "base64",
                    media_type: img.mimeType,
                    data: img.base64Data
                }
            });
        }
        userContent.push({ type: "text", text: userPrompt });

        const payload = {
            model: this.modelName,
            max_tokens: 4096,                                    // REQUIRED — Anthropic throws 400 without this
            messages: [{ role: "user", content: userContent }],
            temperature: 0.1
        };

        // system is a top-level field in Anthropic's schema, not a role in messages[]
        if (systemPrompt) {
            payload.system = systemPrompt;
        }

        const response = await this._fetch(this.baseUrl, { method: 'POST', headers, body: JSON.stringify(payload) });
        if (!response.ok) {
            const errBody = await response.text().catch(() => '');
            logger.error(`Anthropic API Error: ${response.status}`, { requestId, body: errBody });
            throw new Error(`Anthropic API Error: ${response.status}`);
        }

        const data = await response.json();
        const rawText = data?.content?.[0]?.text;
        if (typeof rawText !== 'string') {
            throw new Error('No extraction returned');
        }
        // Claude sometimes wraps JSON in markdown code fences — strip them.
        return stripMarkdownFences(rawText);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FORMATTER: Cohere v2 Chat API
    // Key differences from OpenAI:
    //   - Auth via `Authorization: Bearer` (same header, different key prefix `sk-`)
    //   - Response shape: data.message.content[0].text  (v2)  or  data.text (v1 fallback)
    //   - Does NOT support base64 vision images (images are silently ignored)
    //   - system prompt is passed as a role:"system" message (Cohere v2 supports this)
    // ─────────────────────────────────────────────────────────────────────────
    async _chatCohere(systemPrompt, userPrompt, images, requestId) {
        const headers = {
            "Authorization": `Bearer ${this.apiKey}`,
            "Content-Type": "application/json"
        };

        if (images.length > 0) {
            logger.warn("Cohere does not support vision/image inputs. Images will be ignored.", { requestId });
        }

        // Cohere v2 accepts a messages array with system/user roles
        const messages = [];
        if (systemPrompt) {
            messages.push({ role: "system", content: systemPrompt });
        }
        messages.push({ role: "user", content: userPrompt });

        const payload = {
            model: this.modelName,
            messages,
            temperature: 0.1
        };

        const response = await this._fetch(this.baseUrl, { method: 'POST', headers, body: JSON.stringify(payload) });
        if (!response.ok) {
            const errBody = await response.text().catch(() => '');
            logger.error(`Cohere API Error: ${response.status}`, { requestId, body: errBody });
            throw new Error(`Cohere API Error: ${response.status}`);
        }

        const data = await response.json();

        // Cohere v2 response: data.message.content is an array of content blocks
        if (data?.message?.content && Array.isArray(data.message.content)) {
            const block = data.message.content.find(b => b.type === 'text' && typeof b.text === 'string');
            if (block) return stripMarkdownFences(block.text);
        }

        // Cohere v2 alternative shape
        if (typeof data?.message?.content === 'string') {
            return stripMarkdownFences(data.message.content);
        }

        // Cohere v1 fallback: data.text
        if (typeof data?.text === 'string') {
            return stripMarkdownFences(data.text);
        }

        throw new Error('No extraction returned from Cohere');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FORMATTER: HuggingFace Inference API
    // Key differences from OpenAI:
    //   - Expects a single `inputs` string key (no messages array)
    //   - Returns an array: [{ generated_text: "..." }]
    //   - Does NOT support vision or structured JSON output mode
    // ─────────────────────────────────────────────────────────────────────────
    async _chatHuggingFace(systemPrompt, userPrompt, images, requestId) {
        const headers = {
            "Authorization": `Bearer ${this.apiKey}`,
            "Content-Type": "application/json"
        };

        if (images.length > 0) {
            logger.warn("HuggingFace Inference API does not support vision/image inputs. Images will be ignored.", { requestId });
        }

        // HuggingFace text-generation models expect a flat prompt string
        const fullPrompt = systemPrompt
            ? `${systemPrompt}\n\nUser: ${userPrompt}\n\nAssistant:`
            : userPrompt;

        const payload = {
            inputs: fullPrompt,
            parameters: {
                max_new_tokens: 2048,
                return_full_text: false,
                temperature: 0.1
            }
        };

        const response = await this._fetch(this.baseUrl, { method: 'POST', headers, body: JSON.stringify(payload) });
        if (!response.ok) {
            const errBody = await response.text().catch(() => '');
            logger.error(`HuggingFace API Error: ${response.status}`, { requestId, body: errBody });
            throw new Error(`HuggingFace API Error: ${response.status}`);
        }

        const data = await response.json();
        // HuggingFace returns an array: [{ generated_text: "..." }]
        if (Array.isArray(data) && data.length > 0) {
            const text = data[0].generated_text;
            return stripMarkdownFences(typeof text === 'string' ? text : JSON.stringify(data));
        }
        return typeof data === 'string' ? data : JSON.stringify(data);
    }
}

module.exports = { UniversalAIAdapter };

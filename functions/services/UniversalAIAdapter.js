const { logger } = require('firebase-functions/logger');

class UniversalAIAdapter {
    /**
     * Initializes the universal AI adapter for handling multiple LLM architectures.
     * @param {Object} config 
     * @param {string} config.apiKey
     * @param {string} config.provider - openai, anthropic, google, azure, cohere, huggingface, groq, deepseek, ollama, local
     * @param {string} config.modelName - e.g. gpt-4o, claude-3-5-sonnet-20240620
     * @param {string} [config.baseUrl]
     * @param {string} [config.apiVersion]
     */
    constructor(config) {
        if (!config.apiKey) throw new Error("API Key is required for BYOK Adapter");
        
        this.apiKey = config.apiKey;
        this.provider = (config.provider || 'openai').toLowerCase();
        this.modelName = config.modelName || 'gpt-4o';
        if (config.baseUrl) {
            try {
                const parsedUrl = new URL(config.baseUrl);
                if (parsedUrl.protocol !== 'https:') {
                    throw new Error("Protocol must be https");
                }
                const host = parsedUrl.hostname;
                // Block Cloud Metadata and internal network SSRF attacks
                const is172LinkLocal = host.startsWith('172.') && parseInt(host.split('.')[1], 10) >= 16 && parseInt(host.split('.')[1], 10) <= 31;
                if (
                    host === '169.254.169.254' || 
                    host === 'localhost' || 
                    host === '127.0.0.1' || 
                    host === '0.0.0.0' ||
                    host === '[::1]' ||
                    host.startsWith('10.') || 
                    host.startsWith('192.168.') || 
                    is172LinkLocal ||
                    host.endsWith('.internal') ||
                    host.endsWith('.local')
                ) {
                    throw new Error("Internal or reserved hostnames are strictly prohibited");
                }

                // DNS rebinding check deferred to _validateBaseUrlDns() (async)
                this._dnsValidated = false;
                this.baseUrl = config.baseUrl;
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

        // Auto-configure base URLs per provider
        if (!this.baseUrl) {
            const urlMap = {
                openai: 'https://api.openai.com/v1/chat/completions',
                anthropic: 'https://api.anthropic.com/v1/messages',
                google: `https://generativelanguage.googleapis.com/v1beta/models/${this.modelName}:generateContent`,
                cohere: 'https://api.cohere.ai/v2/chat',
                huggingface: `https://api-inference.huggingface.co/models/${this.modelName}`,
                groq: 'https://api.groq.com/openai/v1/chat/completions',
                deepseek: 'https://api.deepseek.com/v1/chat/completions',
                mistral: 'https://api.mistral.ai/v1/chat/completions',
                perplexity: 'https://api.perplexity.ai/chat/completions',
                together: 'https://api.together.xyz/v1/chat/completions',
                openrouter: 'https://openrouter.ai/api/v1/chat/completions',
            };
            this.baseUrl = urlMap[this.provider];
        }
    }

    /**
     * DNS rebinding protection: resolves the custom baseUrl hostname and verifies
     * the resolved IP isn't an internal/private address. Called once before first request.
     */
    async _validateBaseUrlDns() {
        if (this._dnsValidated || !this.baseUrl) return;

        try {
            const host = new URL(this.baseUrl).hostname;
            const dns = require('dns').promises;

            // Check IPv4 resolved addresses
            try {
                const v4 = await dns.resolve4(host);
                for (const ip of v4) {
                    const octets = ip.split('.').map(Number);
                    if (
                        ip === '127.0.0.1' || ip === '0.0.0.0' ||
                        ip.startsWith('169.254.') ||
                        octets[0] === 10 ||
                        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
                        (octets[0] === 192 && octets[1] === 168)
                    ) {
                        throw new Error(`SSRF blocked: DNS resolved to private IPv4 ${ip}`);
                    }
                }
            } catch (e) {
                if (e && e.message && e.message.includes('SSRF blocked')) throw e;
                // NODATA/NXDOMAIN for IPv4 is ok if IPv6 exists; handled below
            }

            // Check IPv6 resolved addresses
            try {
                const v6 = await dns.resolve6(host);
                for (const ip of v6) {
                    const lower = ip.toLowerCase();
                    if (
                        lower === '::1' || lower === '::' ||
                        lower.startsWith('fe80:') ||
                        lower.startsWith('fc') || lower.startsWith('fd') ||
                        lower.startsWith('::ffff:127.') ||
                        lower.startsWith('::ffff:10.') ||
                        lower.startsWith('::ffff:192.168.')
                    ) {
                        throw new Error(`SSRF blocked: DNS resolved to private IPv6 ${ip}`);
                    }
                }
            } catch (e) {
                if (e && e.message && e.message.includes('SSRF blocked')) throw e;
                // NODATA/NXDOMAIN for IPv6 is ok
            }

            // Only mark validated after successful checks
            this._dnsValidated = true;
        } catch (dnsErr) {
            if (dnsErr && dnsErr.message && dnsErr.message.includes('SSRF blocked')) throw dnsErr;
            // Fail CLOSED: if DNS resolution completely fails, block the request
            throw new Error('SSRF blocked: Could not validate DNS for custom URL');
        }
    }

    /**
     * Executes the conversational payload and standardized base64 vision images.
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
        
        // OpenAI-compatible providers (same /v1/chat/completions format)
        const openaiCompatible = ['openai', 'groq', 'deepseek', 'mistral', 'perplexity', 'together', 'openrouter', 'ollama', 'local'];
        
        if (openaiCompatible.includes(this.provider)) {
            return this._chatOpenAICompatible(systemPrompt, userPrompt, images, requestId);
        } else if (this.provider === 'azure') {
            return this._chatOpenAICompatible(systemPrompt, userPrompt, images, requestId);
        } else if (this.provider === 'google') {
            return this._chatGoogle(systemPrompt, userPrompt, images, requestId);
        } else if (this.provider === 'anthropic') {
            return this._chatAnthropic(systemPrompt, userPrompt, images, requestId);
        } else if (this.provider === 'cohere') {
            return this._chatCohere(systemPrompt, userPrompt, images, requestId);
        } else if (this.provider === 'huggingface') {
            return this._chatHuggingFace(systemPrompt, userPrompt, images, requestId);
        } else {
            // Fallback: try OpenAI-compatible format for any unknown "custom" provider
            logger.warn(`Unknown provider '${this.provider}', attempting OpenAI-compatible format.`, { requestId });
            return this._chatOpenAICompatible(systemPrompt, userPrompt, images, requestId);
        }
    }

    async _chatOpenAICompatible(systemPrompt, userPrompt, images, requestId) {
        const url = this.provider === 'azure' 
            ? `${this.baseUrl}/openai/deployments/${this.modelName}/chat/completions?api-version=${this.apiVersion || '2023-05-15'}`
            : this.baseUrl;

        const headers = { "Content-Type": "application/json" };
        if (this.provider === 'azure') {
            headers["api-key"] = this.apiKey;
        } else {
            headers["Authorization"] = `Bearer ${this.apiKey}`;
        }
        // OpenRouter requires additional headers
        if (this.provider === 'openrouter') {
            headers["HTTP-Referer"] = "https://ai-planner-project-467800.web.app";
            headers["X-Title"] = "AI Planner";
        }

        const userContent = [{ type: "text", text: userPrompt }];
        for (const img of images) {
            userContent.push({
                type: "image_url",
                image_url: { url: `data:${img.mimeType};base64,${img.base64Data}` }
            });
        }

        const payload = {
            model: this.modelName,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userContent }
            ],
            response_format: { type: "json_object" },
            temperature: 0.1
        };

        // Ollama/local doesn't support response_format
        if (this.provider === 'ollama' || this.provider === 'local') {
            delete payload.response_format;
            payload.stream = false;
        }

        const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
        if (!response.ok) {
            logger.error(`${this.provider} API Error: ${response.status}`, { requestId });
            throw new Error(`${this.provider} API Error: ${response.status}`);
        }
        
        const data = await response.json();
        if (!data.choices || !data.choices[0] || !data.choices[0].message || typeof data.choices[0].message.content !== 'string') {
            throw new Error('No extraction returned');
        }
        return data.choices[0].message.content;
    }

    async _chatGoogle(systemPrompt, userPrompt, images, requestId) {
        const url = `${this.baseUrl}?key=${this.apiKey}`;
        const headers = { "Content-Type": "application/json" };
        
        const parts = [];
        if (systemPrompt) {
            parts.push({ text: `SYSTEM INSTRUCTION:\n${systemPrompt}\n\nUSER REQUEST:\n${userPrompt}` });
        } else {
            parts.push({ text: userPrompt });
        }

        for (const img of images) {
            parts.push({
                inlineData: { mimeType: img.mimeType, data: img.base64Data }
            });
        }

        const payload = {
            contents: [{ parts }],
            generationConfig: { 
                responseMimeType: "application/json",
                temperature: 0.1
            }
        };

        const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
        if (!response.ok) {
            logger.error(`Google API Error: ${response.status}`, { requestId });
            throw new Error(`Google API Error: ${response.status}`);
        }
        
        const data = await response.json();
        if (!data.candidates || !data.candidates[0] || !data.candidates[0].content || !data.candidates[0].content.parts || !data.candidates[0].content.parts[0] || typeof data.candidates[0].content.parts[0].text !== 'string') {
            throw new Error('No extraction returned');
        }
        return data.candidates[0].content.parts[0].text;
    }

    async _chatAnthropic(systemPrompt, userPrompt, images, requestId) {
        const headers = {
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json"
        };

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
            max_tokens: 4096,
            system: systemPrompt,
            messages: [{ role: "user", content: userContent }],
            temperature: 0.1
        };

        const response = await fetch(this.baseUrl, { method: 'POST', headers, body: JSON.stringify(payload) });
        if (!response.ok) {
            logger.error(`Anthropic API Error: ${response.status}`, { requestId });
            throw new Error(`Anthropic API Error: ${response.status}`);
        }
        
        const data = await response.json();
        if (!data.content || !data.content[0] || typeof data.content[0].text !== 'string') {
            throw new Error('No extraction returned');
        }
        let rawText = data.content[0].text;
        
        // Claude sometimes wraps JSON in markdown code fences
        if (rawText.startsWith('```json')) {
            rawText = rawText.replace(/```json\n?/, '').replace(/```$/, '').trim();
        }
        return rawText;
    }

    async _chatCohere(systemPrompt, userPrompt, images, requestId) {
        const headers = {
            "Authorization": `Bearer ${this.apiKey}`,
            "Content-Type": "application/json"
        };

        // Cohere v2 Chat API format
        const payload = {
            model: this.modelName,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            temperature: 0.1
        };

        // Note: Cohere doesn't natively support base64 vision images
        if (images.length > 0) {
            logger.warn("Cohere does not support vision/image inputs. Images will be ignored.", { requestId });
        }

        const response = await fetch(this.baseUrl, { method: 'POST', headers, body: JSON.stringify(payload) });
        if (!response.ok) {
            logger.error(`Cohere API Error: ${response.status}`, { requestId });
            throw new Error(`Cohere API Error: ${response.status}`);
        }

        const data = await response.json();
        // Cohere v2 returns message.content[0].text
        if (data.message && data.message.content) {
            return data.message.content[0].text;
        }
        // Fallback for v1 format
        return data.text || JSON.stringify(data);
    }

    async _chatHuggingFace(systemPrompt, userPrompt, images, requestId) {
        const headers = {
            "Authorization": `Bearer ${this.apiKey}`,
            "Content-Type": "application/json"
        };

        // HuggingFace Inference API expects 'inputs' key
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

        // Note: HuggingFace standard inference doesn't support vision
        if (images.length > 0) {
            logger.warn("HuggingFace Inference API does not support vision/image inputs. Images will be ignored.", { requestId });
        }

        const response = await fetch(this.baseUrl, { method: 'POST', headers, body: JSON.stringify(payload) });
        if (!response.ok) {
            logger.error(`HuggingFace API Error: ${response.status}`, { requestId });
            throw new Error(`HuggingFace API Error: ${response.status}`);
        }

        const data = await response.json();
        // HuggingFace returns an array of objects with 'generated_text'
        if (Array.isArray(data) && data.length > 0) {
            return data[0].generated_text || JSON.stringify(data);
        }
        return typeof data === 'string' ? data : JSON.stringify(data);
    }
}

module.exports = { UniversalAIAdapter };

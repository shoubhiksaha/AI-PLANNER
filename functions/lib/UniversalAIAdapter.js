class UniversalAIAdapter {
    /**
     * @param {Object} config
     * @param {string} config.apiKey
     * @param {string} [config.provider='openai'] - openai, anthropic, google, azure, groq, deepseek, ollama, local
     * @param {string} [config.modelName='gpt-4o']
     * @param {string} [config.baseUrl] - Optional override, required for azure
     * @param {string} [config.apiVersion] - Required for azure
     */
    constructor({ apiKey, provider = 'openai', modelName = 'gpt-4o', baseUrl, apiVersion }) {
        this.apiKey = apiKey;
        this.provider = provider.toLowerCase();
        this.modelName = modelName;
        this.baseUrl = baseUrl;
        this.apiVersion = apiVersion;

        // Auto-configure URLs if not provided
        if (!this.baseUrl) {
            if (this.provider === 'openai') {
                this.baseUrl = 'https://api.openai.com/v1/chat/completions';
            } else if (this.provider === 'anthropic') {
                this.baseUrl = 'https://api.anthropic.com/v1/messages';
            } else if (this.provider === 'google') {
                this.baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelName}:generateContent`;
            }
        }
    }

    /**
     * Executes the chat sequence based on active provider routing.
     * @param {string} textPrompt - The text instructions
     * @param {Array<{base64Data: string, mimeType: string}>} [images] - Optional image attachments
     * @returns {Promise<string>} - Extracted text response from the LLM
     */
    async chat(textPrompt, images = []) {
        try {
            if (['openai', 'groq', 'deepseek', 'ollama', 'local'].includes(this.provider)) {
                return await this._chatOpenAICompatible(textPrompt, images);
            } else if (this.provider === 'azure') {
                return await this._chatAzure(textPrompt, images);
            } else if (this.provider === 'google') {
                return await this._chatGoogle(textPrompt, images);
            } else if (this.provider === 'anthropic') {
                return await this._chatAnthropic(textPrompt, images);
            } else {
                throw new Error(`Provider '${this.provider}' is not supported yet.`);
            }
        } catch (error) {
            console.error(`[UniversalAIAdapter Error | ${this.provider}]:`, error.message);
            throw error;
        }
    }

    // --- ADAPTER IMPLEMENTATIONS ---

    async _chatOpenAICompatible(textPrompt, images) {
        let content = [{ type: 'text', text: textPrompt }];
        
        // Append Images for OpenAI (GPT-4o) compatible formats
        if (images && images.length > 0) {
            images.forEach(img => {
                content.push({
                    type: 'image_url',
                    image_url: { url: `data:${img.mimeType || 'image/jpeg'};base64,${img.base64Data}` }
                });
            });
        }

        const payload = {
            model: this.modelName,
            messages: [{ role: 'user', content: content }]
        };

        if (this.provider === 'ollama') payload.stream = false;

        const response = await fetch(this.baseUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) throw new Error(`OpenAI-Compatible API Error: ${response.status} ${response.statusText}`);
        const data = await response.json();
        return data.choices[0].message.content;
    }

    async _chatAzure(textPrompt, images) {
        if (!this.baseUrl || !this.apiVersion) {
            throw new Error("Azure provider requires 'baseUrl' (endpoint) and 'apiVersion'.");
        }

        let content = [{ type: 'text', text: textPrompt }];
        if (images && images.length > 0) {
            images.forEach(img => {
                content.push({
                    type: 'image_url',
                    image_url: { url: `data:${img.mimeType || 'image/jpeg'};base64,${img.base64Data}` }
                });
            });
        }

        const url = `${this.baseUrl}/openai/deployments/${this.modelName}/chat/completions?api-version=${this.apiVersion}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'api-key': this.apiKey, // Azure uses api-key instead of Bearer
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ messages: [{ role: 'user', content: content }] })
        });

        if (!response.ok) throw new Error(`Azure API Error: ${response.status} ${response.statusText}`);
        const data = await response.json();
        return data.choices[0].message.content;
    }

    async _chatGoogle(textPrompt, images) {
        const url = `${this.baseUrl}?key=${this.apiKey}`;
        
        let parts = [{ text: textPrompt }];
        if (images && images.length > 0) {
            images.forEach(img => {
                parts.push({
                    inlineData: {
                        data: img.base64Data,
                        mimeType: img.mimeType || 'image/jpeg'
                    }
                });
            });
        }

        const payload = { contents: [{ parts: parts }] };

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) throw new Error(`Google Generation API Error: ${response.status} ${response.statusText}`);
        const data = await response.json();
        return data.candidates[0].content.parts[0].text;
    }

    async _chatAnthropic(textPrompt, images) {
        let content = [];
        
        if (images && images.length > 0) {
            images.forEach(img => {
                content.push({
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: img.mimeType || 'image/jpeg',
                        data: img.base64Data
                    }
                });
            });
        }
        
        // Anthropic requires text to be pushed after images generally
        content.push({ type: 'text', text: textPrompt });

        const payload = {
            model: this.modelName,
            max_tokens: 1024,
            messages: [{ role: 'user', content: content }]
        };

        const response = await fetch(this.baseUrl, {
            method: 'POST',
            headers: {
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) throw new Error(`Anthropic API Error: ${response.status} ${response.statusText}`);
        const data = await response.json();
        return data.content[0].text;
    }
}

module.exports = UniversalAIAdapter;

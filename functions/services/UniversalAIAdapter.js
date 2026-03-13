const { logger } = require('firebase-functions/logger');

class UniversalAIAdapter {
    /**
     * Initializes the universal AI adapter for handling multiple LLM architectures.
     * @param {Object} config 
     * @param {string} config.apiKey
     * @param {string} config.provider - openai, anthropic, google, azure
     * @param {string} config.modelName - e.g. gpt-4o, claude-3-5-sonnet-20240620
     * @param {string} [config.baseUrl]
     * @param {string} [config.apiVersion]
     */
    constructor(config) {
        if (!config.apiKey) throw new Error("API Key is required for BYOK Adapter");
        
        this.apiKey = config.apiKey;
        this.provider = (config.provider || 'openai').toLowerCase();
        this.modelName = config.modelName || 'gpt-4o';
        this.baseUrl = config.baseUrl;
        this.apiVersion = config.apiVersion;

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
     * Executes the conversational payload and standardized base64 vision images.
     * @param {string} systemPrompt 
     * @param {string} userPrompt 
     * @param {Array<{mimeType: string, base64Data: string}>} images 
     * @param {string} requestId - Used for tracing
     * @returns {Promise<string>} - The JSON string payload returned by the LLM
     */
    async chat(systemPrompt, userPrompt, images = [], requestId = "system") {
        logger.info(`Routing via API Adapter for provider: ${this.provider}`, { requestId, model: this.modelName });
        
        if (this.provider === 'openai' || this.provider === 'azure') {
            return this._chatOpenAICompatible(systemPrompt, userPrompt, images, requestId);
        } else if (this.provider === 'google') {
            return this._chatGoogle(systemPrompt, userPrompt, images, requestId);
        } else if (this.provider === 'anthropic') {
            return this._chatAnthropic(systemPrompt, userPrompt, images, requestId);
        } else {
            throw new Error(`Provider '${this.provider}' is not supported.`);
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
            response_format: { type: "json_object" }, // Ensures JSON structure natively
            temperature: 0.1
        };

        const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
        if (!response.ok) {
            const errBody = await response.text();
            logger.error(`OpenAI/Azure API Error: ${response.status}`, { error: errBody, requestId });
            throw new Error(`OpenAI API Error: ${response.status}`);
        }
        
        const data = await response.json();
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
            const errBody = await response.text();
            logger.error(`Google API Error: ${response.status}`, { error: errBody, requestId });
            throw new Error(`Google API Error: ${response.status}`);
        }
        
        const data = await response.json();
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
            const errBody = await response.text();
            logger.error(`Anthropic API Error: ${response.status}`, { error: errBody, requestId });
            throw new Error(`Anthropic API Error: ${response.status}`);
        }
        
        const data = await response.json();
        let rawText = data.content[0].text;
        
        // Claude usually wraps json in markdown tags
        if (rawText.startsWith('```json')) {
            rawText = rawText.replace(/```json\n?/, '').replace(/```$/, '').trim();
        }
        return rawText;
    }
}

module.exports = { UniversalAIAdapter };

// Shared browser + test helpers (UMD)
// Browser: window.AppHelpers
// Node/Jest: require('../app-helpers')
(function (exports) {
    exports.parseJsonResponse = async (res) => {
        const text = await res.text();
        const contentType = (res.headers.get('content-type') || '').toLowerCase();

        if (!contentType.includes('application/json')) {
            const snippet = text.slice(0, 120).replace(/\s+/g, ' ').trim();
            throw new Error(`Non-JSON API response (${res.status}): ${snippet || 'empty body'}`);
        }

        try {
            return JSON.parse(text);
        } catch (e) {
            throw new Error(`Invalid JSON API response (${res.status}).`);
        }
    };

    exports.getApiUrls = (hostname, endpoint = 'syncPlanner') => {
        const projectId = (typeof window !== 'undefined' && window.__ENV_CONFIG__ && window.__ENV_CONFIG__.projectId)
            ? window.__ENV_CONFIG__.projectId
            : 'ai-planner-staging';

        const PRIMARY_API_URL = (hostname === "localhost" || hostname === "127.0.0.1")
            ? `http://127.0.0.1:5001/${projectId}/us-central1/${endpoint}`
            : `/${endpoint}`;

        return { PRIMARY_API_URL, FALLBACK_API_URL: PRIMARY_API_URL };
    };

    exports.applyTheme = (mode, htmlElement, themeBtn, themeItems, matchMediaDark) => {
        let effect = mode;
        const resolvedDarkPref = typeof matchMediaDark === 'boolean'
            ? matchMediaDark
            : !!(typeof window !== 'undefined' &&
                window.matchMedia &&
                window.matchMedia('(prefers-color-scheme: dark)').matches);

        if (mode === 'auto') {
            effect = resolvedDarkPref ? 'dark' : 'light';
        }

        htmlElement.classList.remove('dark-mode', 'oled-mode');
        if (effect === 'dark') htmlElement.classList.add('dark-mode');
        if (effect === 'oled') htmlElement.classList.add('oled-mode');

        if (!themeBtn) return;

        if (mode === 'auto') themeBtn.textContent = '⚙️';
        else if (mode === 'light') themeBtn.textContent = '☀️';
        else if (mode === 'dark') themeBtn.textContent = '🌙';
        else if (mode === 'oled') themeBtn.textContent = '🖤';

        (themeItems || []).forEach(el => {
            el.classList.remove('selected');
            if (el.textContent.toLowerCase().includes(mode)) el.classList.add('selected');
        });
    };

    exports.readApiError = async (res) => {
        const statusLine = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
        let text = '';
        try {
            text = await res.text();
        } catch (_) {
            return { message: 'Request failed.', details: statusLine };
        }

        const contentType = (res.headers.get('content-type') || '').toLowerCase();
        if (contentType.includes('application/json') && text) {
            try {
                const data = JSON.parse(text);
                const message = data.error || data.message || data.text || 'Request failed.';
                const detailLines = [statusLine, `Message: ${message}`];
                const extra = { ...data };
                delete extra.error;
                delete extra.message;
                delete extra.text;
                if (Object.keys(extra).length > 0) {
                    detailLines.push(`Response: ${JSON.stringify(extra, null, 2)}`);
                }
                return { message, details: detailLines.join('\n\n') };
            } catch (_) { /* fall through */ }
        }

        const snippet = text.slice(0, 500).replace(/\s+/g, ' ').trim();
        return {
            message: snippet ? snippet.slice(0, 120) : 'Request failed.',
            details: [statusLine, snippet ? `Response body:\n${text.slice(0, 500)}` : 'Empty response body']
                .filter(Boolean)
                .join('\n\n'),
        };
    };

    function wireActionableErrorModal() {
        if (typeof document === 'undefined') return;

        const modal = document.getElementById('actionable-error-modal');
        const knowMoreBtn = document.getElementById('actionable-error-know-more');
        const closeBtn = document.getElementById('actionable-error-close');
        const detailsEl = document.getElementById('actionable-error-details');
        if (!modal || !knowMoreBtn || !closeBtn || !detailsEl) return;
        if (modal.dataset.wired === 'true') return;
        modal.dataset.wired = 'true';

        const hideModal = () => {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            detailsEl.classList.add('hidden');
            knowMoreBtn.textContent = 'Know more';
            knowMoreBtn.setAttribute('aria-expanded', 'false');
        };

        knowMoreBtn.addEventListener('click', () => {
            const expanded = !detailsEl.classList.contains('hidden');
            if (expanded) {
                detailsEl.classList.add('hidden');
                knowMoreBtn.textContent = 'Know more';
                knowMoreBtn.setAttribute('aria-expanded', 'false');
            } else {
                detailsEl.classList.remove('hidden');
                knowMoreBtn.textContent = 'Hide details';
                knowMoreBtn.setAttribute('aria-expanded', 'true');
            }
        });

        closeBtn.addEventListener('click', hideModal);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) hideModal();
        });
    }

    exports.showActionableError = ({ summary, title, details }) => {
        if (typeof document === 'undefined') {
            throw new Error(summary);
        }

        wireActionableErrorModal();

        const modal = document.getElementById('actionable-error-modal');
        const titleEl = document.getElementById('actionable-error-title');
        const summaryEl = document.getElementById('actionable-error-summary');
        const detailsEl = document.getElementById('actionable-error-details');
        const detailsTextEl = document.getElementById('actionable-error-details-text');
        const knowMoreBtn = document.getElementById('actionable-error-know-more');

        if (!modal || !summaryEl || !detailsEl || !detailsTextEl) {
            alert(summary);
            return;
        }

        if (titleEl) titleEl.textContent = title || 'Something went wrong';
        summaryEl.textContent = summary;
        detailsTextEl.textContent = details || 'No additional details available.';
        detailsEl.classList.add('hidden');
        if (knowMoreBtn) {
            knowMoreBtn.textContent = 'Know more';
            knowMoreBtn.setAttribute('aria-expanded', 'false');
        }

        modal.classList.remove('hidden');
        modal.classList.add('flex');
    };

    exports.switchView = (viewId) => {
        // Hide all app "view-*" sections dynamically so new screens do not
        // require helper code updates to participate in navigation state.
        document.querySelectorAll('[id^="view-"]').forEach(el => {
            el.classList.add('view-hidden');
            // Fallback if stale CSS is cached and view-hidden rule isn't applied.
            el.style.display = 'none';
            el.hidden = true;
            el.setAttribute('aria-hidden', 'true');
        });
        const target = document.getElementById(viewId);
        if (target) {
            target.classList.remove('view-hidden');
            target.style.removeProperty('display');
            target.hidden = false;
            target.setAttribute('aria-hidden', 'false');
        }
    };
})(typeof module !== 'undefined' && module.exports ? module.exports : (window.AppHelpers = {}));

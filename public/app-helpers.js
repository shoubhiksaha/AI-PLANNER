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
        const PRIMARY_API_URL = (hostname === "localhost" || hostname === "127.0.0.1")
            ? `http://127.0.0.1:5001/ai-planner-project-467800/us-central1/${endpoint}`
            : `/${endpoint}`;

        const FALLBACK_MAP = {
            'syncPlanner': 'https://syncplanner-xeh5qbnxga-uc.a.run.app',
            'setupNotion': 'https://setupnotion-xeh5qbnxga-uc.a.run.app',
            'exportUserData': 'https://exportuserdata-xeh5qbnxga-uc.a.run.app',
            'deleteUserAccount': 'https://deleteuseraccount-xeh5qbnxga-uc.a.run.app',
            'logClientError': 'https://logclienterror-xeh5qbnxga-uc.a.run.app'
        };

        const FALLBACK_API_URL = FALLBACK_MAP[endpoint] || `https://${endpoint.toLowerCase()}-xeh5qbnxga-uc.a.run.app`;
        return { PRIMARY_API_URL, FALLBACK_API_URL };
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

    exports.switchView = (viewId) => {
        ['view-login', 'view-setup', 'view-dashboard', 'view-history'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.add('view-hidden');
        });
        const target = document.getElementById(viewId);
        if (target) target.classList.remove('view-hidden');
    };
})(typeof module !== 'undefined' && module.exports ? module.exports : (window.AppHelpers = {}));

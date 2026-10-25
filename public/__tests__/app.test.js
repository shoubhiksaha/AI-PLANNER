/**
 * Frontend Tests for AI Planner
 * Tests critical UI logic from shared production helpers.
 *
 * app.js imports Firebase from CDN URLs, which are not Jest-resolvable.
 * To avoid mirrored test logic drift, tests import public/app-helpers.js
 * via CommonJS (UMD export path).
 * 
 * @jest-environment jsdom
 */

const {
    parseJsonResponse,
    readApiError,
    showActionableError,
    getApiUrls,
    applyTheme,
    switchView,
    describeApiError,
    shouldOpenUpgrade,
    creditNoteForError,
    creditNoteForSuccess,
    summarizeCounts,
    normalizeSyncMode,
    maxUploadForTier,
    pageLimitFor,
    needsGoogleToken,
    needsNotion,
    resolveNotesDestination,
    friendlySyncDate,
    BYOK_SESSION_KEY,
    readByokSession,
    writeByokSession,
    clearByokSession,
    buildByokHeaders,
    generateClientRequestId,
    isTokenFresh,
    extractNotionId,
    validateNotionKey,
    isHeicFile,
    isAcceptedImage,
    buildHeatmapDays,
    activateDialog,
    PROCESSING_MESSAGE,
} = require('../app-helpers');


// ============================================
// TESTS
// ============================================

describe('parseJsonResponse', () => {
    const mockResponse = (body, status = 200, contentType = 'application/json') => ({
        status,
        text: async () => body,
        headers: {
            get: (name) => name === 'content-type' ? contentType : null
        }
    });

    test('parses valid JSON response', async () => {
        const res = mockResponse('{"success": true, "text": "Morning Sync Complete!"}');
        const data = await parseJsonResponse(res);
        expect(data).toEqual({ success: true, text: "Morning Sync Complete!" });
    });

    test('throws for non-JSON content type (HTML error page)', async () => {
        const htmlBody = '<!DOCTYPE html><html><body>502 Bad Gateway</body></html>';
        const res = mockResponse(htmlBody, 502, 'text/html');
        await expect(parseJsonResponse(res)).rejects.toThrow('Non-JSON API response (502)');
    });

    test('throws for non-JSON content type with empty body', async () => {
        const res = mockResponse('', 500, 'text/plain');
        await expect(parseJsonResponse(res)).rejects.toThrow('Non-JSON API response (500): empty body');
    });

    test('throws for malformed JSON body', async () => {
        const res = mockResponse('{invalid json+++}', 200, 'application/json');
        await expect(parseJsonResponse(res)).rejects.toThrow('Invalid JSON API response (200).');
    });

    test('handles JSON response with charset in content-type', async () => {
        const res = mockResponse('{"data": 1}', 200, 'application/json; charset=utf-8');
        const data = await parseJsonResponse(res);
        expect(data).toEqual({ data: 1 });
    });

    test('throws for missing content-type header', async () => {
        const res = {
            status: 200,
            text: async () => '{"ok": true}',
            headers: { get: () => null }
        };
        await expect(parseJsonResponse(res)).rejects.toThrow('Non-JSON API response (200)');
    });

    test('truncates long non-JSON snippets to 120 chars', async () => {
        const longBody = 'x'.repeat(200);
        const res = mockResponse(longBody, 500, 'text/html');
        try {
            await parseJsonResponse(res);
        } catch (e) {
            // The snippet should be at most 120 chars
            const match = e.message.match(/: (.+)/);
            expect(match[1].length).toBeLessThanOrEqual(120);
        }
    });
});

describe('readApiError', () => {
    const mockResponse = (body, status = 400, statusText = '', contentType = 'application/json') => ({
        status,
        statusText,
        text: async () => body,
        headers: {
            get: (name) => name === 'content-type' ? contentType : null
        }
    });

    test('extracts JSON error message and details', async () => {
        const res = mockResponse(JSON.stringify({ error: 'Notion rejected the integration token.' }), 400, 'Bad Request');
        const result = await readApiError(res);
        expect(result.message).toBe('Notion rejected the integration token.');
        expect(result.details).toContain('HTTP 400 Bad Request');
        expect(result.details).toContain('Notion rejected the integration token.');
    });

    test('handles non-JSON error responses', async () => {
        const res = mockResponse('<html>502 Bad Gateway</html>', 502, 'Bad Gateway', 'text/html');
        const result = await readApiError(res);
        expect(result.details).toContain('HTTP 502 Bad Gateway');
        expect(result.details).toContain('Response body:');
    });

    test('handles empty response bodies', async () => {
        const res = mockResponse('', 500, 'Internal Server Error', 'text/plain');
        const result = await readApiError(res);
        expect(result.details).toContain('HTTP 500 Internal Server Error');
        expect(result.details).toContain('Empty response body');
    });
});

describe('showActionableError', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="actionable-error-modal" class="hidden">
        <h3 id="actionable-error-title"></h3>
        <p id="actionable-error-summary"></p>
        <div id="actionable-error-details" class="hidden">
          <pre id="actionable-error-details-text"></pre>
        </div>
        <button id="actionable-error-know-more">Know more</button>
        <button id="actionable-error-close">Close</button>
      </div>
    `;
  });

  test('shows modal with summary and hidden details', () => {
    showActionableError({
      title: 'Notion setup failed',
      summary: 'Could not save Notion keys securely. Please try again.',
      details: 'HTTP 400\n\nMessage: Invalid setup payload',
    });

    const modal = document.getElementById('actionable-error-modal');
    expect(modal.classList.contains('flex')).toBe(true);
    expect(document.getElementById('actionable-error-title').textContent).toBe('Notion setup failed');
    expect(document.getElementById('actionable-error-summary').textContent)
      .toBe('Could not save Notion keys securely. Please try again.');
    expect(document.getElementById('actionable-error-details').classList.contains('hidden')).toBe(true);
    expect(document.getElementById('actionable-error-details-text').textContent)
      .toContain('Invalid setup payload');
  });

  test('reveals details when Know more is clicked', () => {
    showActionableError({
      summary: 'Something failed.',
      details: 'Exact backend error',
    });

    document.getElementById('actionable-error-know-more').click();
    expect(document.getElementById('actionable-error-details').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('actionable-error-know-more').textContent).toBe('Hide details');
  });
});

describe('API URL Resolution', () => {
    afterEach(() => {
        delete window.__ENV_CONFIG__;
    });

    test('uses localhost URL with projectId for local development', () => {
        const { PRIMARY_API_URL } = getApiUrls('localhost');
        expect(PRIMARY_API_URL).toContain('127.0.0.1:5001');
        expect(PRIMARY_API_URL).toContain('syncPlanner');
    });

    test('uses localhost URL for 127.0.0.1', () => {
        const { PRIMARY_API_URL } = getApiUrls('127.0.0.1');
        expect(PRIMARY_API_URL).toContain('127.0.0.1:5001');
    });

    test('C5: syncPlanner goes to the direct Cloud Functions URL of the configured project', () => {
        window.__ENV_CONFIG__ = { projectId: 'ai-planner-project-467800' };
        expect(getApiUrls('planner.analogdigital.tech').PRIMARY_API_URL)
            .toBe('https://us-central1-ai-planner-project-467800.cloudfunctions.net/syncPlanner');

        window.__ENV_CONFIG__ = { projectId: 'ai-planner-project-467800', functionsRegion: 'asia-south1' };
        expect(getApiUrls('ai-planner-staging.web.app').PRIMARY_API_URL)
            .toBe('https://asia-south1-ai-planner-project-467800.cloudfunctions.net/syncPlanner');
    });

    test('C5: functionsBaseUrl override is honoured (https only)', () => {
        window.__ENV_CONFIG__ = { projectId: 'p', functionsBaseUrl: 'https://fn.example.com/' };
        expect(getApiUrls('planner.analogdigital.tech').PRIMARY_API_URL).toBe('https://fn.example.com/syncPlanner');
        window.__ENV_CONFIG__ = { projectId: 'p', functionsBaseUrl: 'http://insecure.example.com' };
        expect(getApiUrls('planner.analogdigital.tech').PRIMARY_API_URL).toBe('https://us-central1-p.cloudfunctions.net/syncPlanner');
    });

    test('other endpoints keep the same-origin Hosting rewrite', () => {
        expect(getApiUrls('planner.analogdigital.tech', 'updateProfile').PRIMARY_API_URL).toBe('/updateProfile');
        expect(getApiUrls('ai-planner-project-467800.web.app', 'logClientError').PRIMARY_API_URL).toBe('/logClientError');
    });
});

describe('switchView', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div id="view-login"></div>
            <div id="view-setup"></div>
            <div id="view-dashboard"></div>
        `;
    });

    test('shows login view and hides others', () => {
        switchView('view-login');
        expect(document.getElementById('view-login').classList.contains('view-hidden')).toBe(false);
        expect(document.getElementById('view-setup').classList.contains('view-hidden')).toBe(true);
        expect(document.getElementById('view-dashboard').classList.contains('view-hidden')).toBe(true);
    });

    test('shows dashboard view and hides others', () => {
        switchView('view-dashboard');
        expect(document.getElementById('view-dashboard').classList.contains('view-hidden')).toBe(false);
        expect(document.getElementById('view-login').classList.contains('view-hidden')).toBe(true);
        expect(document.getElementById('view-setup').classList.contains('view-hidden')).toBe(true);
        expect(document.getElementById('view-login').style.display).toBe('none');
        expect(document.getElementById('view-login').hidden).toBe(true);
        expect(document.getElementById('view-dashboard').style.display).toBe('');
        expect(document.getElementById('view-dashboard').hidden).toBe(false);
    });

    test('applies inline display fallback so hidden views cannot remain stacked', () => {
        switchView('view-dashboard');
        expect(document.getElementById('view-login').style.display).toBe('none');
        expect(document.getElementById('view-setup').style.display).toBe('none');
        expect(document.getElementById('view-dashboard').style.display).toBe('');
    });

    test('shows setup view and hides others', () => {
        switchView('view-setup');
        expect(document.getElementById('view-setup').classList.contains('view-hidden')).toBe(false);
        expect(document.getElementById('view-login').classList.contains('view-hidden')).toBe(true);
        expect(document.getElementById('view-dashboard').classList.contains('view-hidden')).toBe(true);
    });

    test('handles missing elements gracefully without throwing', () => {
        // Remove all views from the DOM
        document.body.innerHTML = '';
        expect(() => switchView('view-dashboard')).not.toThrow();
    });
});

describe('applyTheme', () => {
    let html, btn, items;

    beforeEach(() => {
        document.body.innerHTML = `
            <button id="theme-btn"><svg><use href="#i-monitor"></use></svg></button>
            <button class="theme-item" data-theme="auto">Match device</button>
            <button class="theme-item" data-theme="light">Light</button>
            <button class="theme-item" data-theme="dark">Dark</button>
        `;
        html = document.documentElement;
        html.classList.remove('dark-mode', 'oled-mode');
        btn = document.getElementById('theme-btn');
        items = document.querySelectorAll('.theme-item');
    });

    const iconOf = () => btn.querySelector('use').getAttribute('href');

    test('applies light mode (removes all dark classes)', () => {
        html.classList.add('dark-mode'); // start in dark
        applyTheme('light', html, btn, items);
        expect(html.classList.contains('dark-mode')).toBe(false);
        expect(html.classList.contains('oled-mode')).toBe(false);
        expect(iconOf()).toBe('#i-sun');
        expect(btn.getAttribute('aria-label')).toBe('Theme: Light. Change theme or style');
    });

    test('applies dark mode', () => {
        applyTheme('dark', html, btn, items);
        expect(html.classList.contains('dark-mode')).toBe(true);
        expect(iconOf()).toBe('#i-moon');
    });

    test('the retired OLED choice maps to the near-black dark theme', () => {
        applyTheme('oled', html, btn, items);
        expect(html.classList.contains('dark-mode')).toBe(true);
        expect(html.classList.contains('oled-mode')).toBe(false);
        expect(html.dataset.themeMode).toBe('dark');
        expect([...items].find(el => el.classList.contains('selected')).dataset.theme).toBe('dark');
    });

    test('auto mode resolves to dark when system prefers dark', () => {
        applyTheme('auto', html, btn, items, true);
        expect(html.classList.contains('dark-mode')).toBe(true);
        // The chosen mode, not the resolved one: theme packs use it for the browser bar colour.
        expect(html.dataset.themeMode).toBe('auto');
        expect(iconOf()).toBe('#i-monitor');
    });

    test('auto mode resolves to light when system prefers light', () => {
        applyTheme('auto', html, btn, items, false);
        expect(html.classList.contains('dark-mode')).toBe(false);
        expect(iconOf()).toBe('#i-monitor');
    });

    test('B-30: highlights the selected theme item by data-theme', () => {
        applyTheme('dark', html, btn, items);
        const selected = [...items].filter(el => el.classList.contains('selected'));
        expect(selected).toHaveLength(1);
        expect(selected[0].dataset.theme).toBe('dark');
        expect(selected[0].getAttribute('aria-pressed')).toBe('true');
    });

    test('B-30: null/unknown mode is treated as auto', () => {
        applyTheme(null, html, btn, items, true);
        expect(html.classList.contains('dark-mode')).toBe(true);
        expect([...items].find(el => el.classList.contains('selected')).dataset.theme).toBe('auto');
    });

    test('works gracefully when themeBtn is null', () => {
        expect(() => applyTheme('dark', html, null, items)).not.toThrow();
        expect(html.classList.contains('dark-mode')).toBe(true);
    });
});

describe('Mobile detection regex', () => {
    const mobileRegex = /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i;

    test('detects iPhone user agent', () => {
        expect(mobileRegex.test('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)')).toBe(true);
    });

    test('detects Android user agent', () => {
        expect(mobileRegex.test('Mozilla/5.0 (Linux; Android 13; Pixel 7)')).toBe(true);
    });

    test('detects iPad user agent', () => {
        expect(mobileRegex.test('Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X)')).toBe(true);
    });

    test('rejects desktop Chrome user agent', () => {
        expect(mobileRegex.test('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')).toBe(false);
    });

    test('rejects desktop Firefox user agent', () => {
        expect(mobileRegex.test('Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/118.0')).toBe(false);
    });
});

describe('C3 error envelope → plain messages', () => {
    test('opens the upgrade modal only for PLAN_LIMIT and INSUFFICIENT_CREDITS', () => {
        expect(shouldOpenUpgrade('PLAN_LIMIT')).toBe(true);
        expect(shouldOpenUpgrade('INSUFFICIENT_CREDITS')).toBe(true);
        ['AUTH_INVALID', 'GOOGLE_TOKEN_EXPIRED', 'NOTION_NOT_CONFIGURED', 'RATE_LIMITED', 'INTERNAL', 'EMAIL_NOT_VERIFIED', 'ORIGIN_NOT_ALLOWED', undefined]
            .forEach(code => expect(shouldOpenUpgrade(code)).toBe(false));
        // A bare 403 without a PLAN_LIMIT code must not open the modal (the old bug)
        expect(describeApiError({ status: 403, data: { error: 'Forbidden' } }).showUpgrade).toBe(false);
    });

    test.each([
        'AUTH_INVALID', 'GOOGLE_TOKEN_EXPIRED', 'ORIGIN_NOT_ALLOWED', 'GOOGLE_ACCOUNT_MISMATCH', 'EMAIL_NOT_VERIFIED',
        'PLAN_LIMIT', 'INSUFFICIENT_CREDITS', 'NOTION_NOT_CONFIGURED', 'INVALID_IMAGE', 'BYOK_INVALID',
        'BAD_REQUEST', 'RATE_LIMITED', 'INTERNAL', 'AI_UNAVAILABLE',
    ])('%s gets a plain, non-technical message', (code) => {
        const info = describeApiError({ status: 400, data: { errorCode: code, error: 'TypeError: x is undefined\n    at foo (index.js:1:1)' } });
        expect(info.errorCode).toBe(code);
        expect(info.message).not.toMatch(/TypeError|index\.js|undefined/);
        expect(info.message.length).toBeGreaterThan(10);
    });

    test('uses the server text for specific plan/credit messages', () => {
        const info = describeApiError({ status: 402, data: { errorCode: 'INSUFFICIENT_CREDITS', error: 'Insufficient credits. Need 2, but have 1.' } });
        expect(info.message).toBe('Insufficient credits. Need 2, but have 1.');
        expect(info.showUpgrade).toBe(true);
        expect(info.retryable).toBe(false);
    });

    test('GOOGLE_TOKEN_EXPIRED asks for a Google reconnect', () => {
        const info = describeApiError({ status: 401, data: { errorCode: 'GOOGLE_TOKEN_EXPIRED', error: 'x' } });
        expect(info.needsGoogleReconnect).toBe(true);
        expect(info.message).toBe('Your Google connection expired. Reconnect Google to continue.');
    });

    test('B-03: a 504 / non-JSON gateway page means "still processing"', async () => {
        const res = { status: 504, text: async () => '<!DOCTYPE html><html>Gateway Timeout</html>', headers: { get: () => 'text/html' } };
        let parseErr;
        try { await parseJsonResponse(res); } catch (e) { parseErr = e; }
        expect(parseErr.status).toBe(504);
        expect(parseErr.nonJson).toBe(true);
        const info = describeApiError({ status: 504, error: parseErr });
        expect(info.kind).toBe('processing');
        expect(info.message).toBe(PROCESSING_MESSAGE);
        expect(info.message).not.toMatch(/Non-JSON|DOCTYPE/);
    });

    test('client timeout (AbortError) is also treated as still processing', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        expect(describeApiError({ error: err }).kind).toBe('processing');
    });

    test('network failures get a friendly retryable message', () => {
        const info = describeApiError({ error: new TypeError('Failed to fetch') });
        expect(info.message).toMatch(/Network error/);
        expect(info.retryable).toBe(true);
    });

    test('non-JSON 500 never shows the raw body', () => {
        const err = new Error('Non-JSON API response (500): <html>Internal Server Error</html>');
        err.status = 500;
        err.nonJson = true;
        const info = describeApiError({ status: 500, error: err });
        expect(info.message).not.toMatch(/Non-JSON|<html>/);
        expect(info.retryable).toBe(true);
    });
});

describe('credit notes (UX 5/6)', () => {
    test('refunded or pre-check errors say "No credit used"', () => {
        expect(creditNoteForError({ creditRefunded: true }, 1)).toBe('No credit used');
        expect(creditNoteForError({}, 1)).toBe('No credit used');
    });
    test('kept credits are reported', () => {
        expect(creditNoteForError({ creditRefunded: false }, 1)).toBe('1 credit used');
        expect(creditNoteForError({ creditRefunded: false, creditsCharged: 3 }, 1)).toBe('3 credits used');
    });
    test('success notes use creditsCharged / duplicate / BYOK', () => {
        expect(creditNoteForSuccess({ creditsCharged: 1 })).toBe('1 credit used');
        expect(creditNoteForSuccess({ creditsCharged: 0, duplicate: true })).toMatch(/Already synced/);
        expect(creditNoteForSuccess({ creditsCharged: 0 }, { byok: true })).toMatch(/own AI key/);
        expect(creditNoteForSuccess({})).toBe('');
    });
});

describe('summarizeCounts', () => {
    test('formats C4 counts', () => {
        expect(summarizeCounts({ events: 3, tasks: 4 })).toBe('3 events · 4 tasks added');
        expect(summarizeCounts({ events: 1, completedTasks: 2, expenses: 1, health: 2 }))
            .toBe('1 event added · 2 tasks completed · 1 expense logged · 2 health entries logged');
        expect(summarizeCounts({ journalPages: 1 })).toBe('1 journal page saved to Notion');
        expect(summarizeCounts({})).toBe('');
        expect(summarizeCounts(undefined)).toBe('');
    });
});

describe('sync modes and plan limits (B-05, UX 3)', () => {
    test('"night" is normalised to "evening"', () => {
        expect(normalizeSyncMode('night')).toBe('evening');
        expect(normalizeSyncMode('journal')).toBe('journal');
    });
    test('upload allows the tier maximum', () => {
        expect(maxUploadForTier('free')).toBe(1);
        expect(maxUploadForTier('standard')).toBe(3);
        expect(maxUploadForTier('pro')).toBe(5);
        expect(maxUploadForTier(undefined)).toBe(1);
    });
    test('per-mode limits mirror the backend', () => {
        expect(pageLimitFor('standard', 'journal')).toBe(3);
        expect(pageLimitFor('standard', 'morning')).toBe(1);
        expect(pageLimitFor('standard', 'night')).toBe(1);
        expect(pageLimitFor('free', 'journal')).toBe(1);
        expect(pageLimitFor('pro', 'evening')).toBe(5);
    });
    test('Google token / Notion requirements per mode and notes destination', () => {
        expect(needsGoogleToken('morning', 'notion')).toBe(true);
        expect(needsGoogleToken('night', 'notion')).toBe(true);
        expect(needsGoogleToken('journal', 'drive')).toBe(true);
        expect(needsGoogleToken('voice_note', 'drive')).toBe(true);
        expect(needsGoogleToken('journal', 'notion')).toBe(false);
        expect(needsGoogleToken('voice_note', 'notion')).toBe(false);
        expect(needsNotion('journal', 'notion')).toBe(true);
        expect(needsNotion('voice_note', 'notion')).toBe(true);
        expect(needsNotion('journal', 'drive')).toBe(false);
        expect(needsNotion('morning', 'notion')).toBe(false);
    });

    test('notes destination: explicit choice wins, else Notion users keep Notion, else Drive', () => {
        expect(resolveNotesDestination({ notesDestination: 'drive', notionKey: 'k', notionDbId: 'd' })).toBe('drive');
        expect(resolveNotesDestination({ notesDestination: 'notion' })).toBe('notion');
        expect(resolveNotesDestination({ notionKey: 'k', notionDbId: 'd' })).toBe('notion');
        expect(resolveNotesDestination({ notionKey: 'k' })).toBe('drive');
        expect(resolveNotesDestination(null)).toBe('drive');
        expect(resolveNotesDestination({ notesDestination: 'dropbox' })).toBe('drive');
    });

    test('summary names where notes were saved', () => {
        expect(summarizeCounts({ journalPages: 2 }, { savedTo: 'drive' })).toBe('2 journal pages saved to Google Drive');
        expect(summarizeCounts({ journalPages: 1 }, { savedTo: 'notion' })).toBe('1 journal page saved to Notion');
        expect(summarizeCounts({ completedTasks: 1, brainDump: 1 }, { savedTo: 'drive' })).toBe('1 task completed · brain dump saved to Google Drive');
        expect(summarizeCounts({ voiceNotes: 1 }, { savedTo: 'drive' })).toBe('voice note saved to Google Drive');
    });

    test('friendly last-sync dates', () => {
        expect(friendlySyncDate('2026-10-21', '2026-10-21')).toBe('today');
        expect(friendlySyncDate('2026-10-20', '2026-10-21')).toBe('yesterday');
        expect(friendlySyncDate('2026-03-01', '2026-03-02')).toBe('yesterday');
        expect(friendlySyncDate('2026-10-02', '2026-10-21')).toBe('on 2 Oct');
        expect(friendlySyncDate('2025-12-30', '2026-01-02')).toBe('on 30 Dec 2025');
        expect(friendlySyncDate('', '2026-10-21')).toBe('');
        expect(friendlySyncDate('not-a-date', '2026-10-21')).toBe('');
    });
});

describe('C1 stateless BYOK', () => {
    beforeEach(() => {
        sessionStorage.clear();
        localStorage.clear();
    });

    test('config lives in sessionStorage under byok_stateless_v2', () => {
        expect(BYOK_SESSION_KEY).toBe('byok_stateless_v2');
        writeByokSession(sessionStorage, { provider: 'openai', modelName: 'gpt-4o', apiKey: 'sk-test-123', baseUrl: '', apiVersion: undefined });
        expect(JSON.parse(sessionStorage.getItem('byok_stateless_v2'))).toEqual({ provider: 'openai', modelName: 'gpt-4o', apiKey: 'sk-test-123' });
        expect(localStorage.length).toBe(0);
        expect(document.cookie).not.toMatch(/sk-test/);
        expect(readByokSession(sessionStorage).apiKey).toBe('sk-test-123');
    });

    test('readByokSession rejects malformed data', () => {
        sessionStorage.setItem(BYOK_SESSION_KEY, '{not json');
        expect(readByokSession(sessionStorage)).toBeNull();
        sessionStorage.setItem(BYOK_SESSION_KEY, JSON.stringify({ provider: 'openai' }));
        expect(readByokSession(sessionStorage)).toBeNull();
        expect(readByokSession(null)).toBeNull();
    });

    test('clearByokSession removes current and legacy keys from both storages', () => {
        writeByokSession(sessionStorage, { provider: 'openai', modelName: 'gpt-4o', apiKey: 'k' });
        sessionStorage.setItem('byok_cookie_session_active', '{}');
        localStorage.setItem('byok_stateless_key', 'old');
        clearByokSession(sessionStorage, localStorage);
        expect(sessionStorage.length).toBe(0);
        expect(localStorage.length).toBe(0);
    });

    test('builds X-BYOK-* headers only when a key exists', () => {
        expect(buildByokHeaders(null)).toEqual({});
        expect(buildByokHeaders({ provider: 'azure', modelName: 'gpt-4o', apiKey: ' key ', baseUrl: 'https://x.openai.azure.com', apiVersion: '2024-02-01' })).toEqual({
            'X-BYOK-Token': 'key',
            'X-BYOK-Provider': 'azure',
            'X-BYOK-Model': 'gpt-4o',
            'X-BYOK-BaseUrl': 'https://x.openai.azure.com',
            'X-BYOK-ApiVersion': '2024-02-01',
        });
        expect(Object.keys(buildByokHeaders({ provider: 'openai', modelName: 'gpt-4o', apiKey: 'k' })))
            .toEqual(['X-BYOK-Token', 'X-BYOK-Provider', 'X-BYOK-Model']);
    });
});

describe('clientRequestId (C4)', () => {
    test('uses crypto.randomUUID when available', () => {
        expect(generateClientRequestId({ randomUUID: () => 'abc' })).toBe('abc');
    });
    test('falls back to a valid UUID v4', () => {
        const id = generateClientRequestId({ getRandomValues: (arr) => { arr.fill(7); return arr; } });
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
});

describe('Google token freshness (B-02)', () => {
    test('requires a token that is not about to expire', () => {
        const now = 1_000_000;
        expect(isTokenFresh(0, now)).toBe(false);
        expect(isTokenFresh(undefined, now)).toBe(false);
        expect(isTokenFresh(now + 60 * 1000, now)).toBe(false);       // 1 min left → refresh
        expect(isTokenFresh(now + 30 * 60 * 1000, now)).toBe(true);
    });
});

describe('Notion inputs (UX 10)', () => {
    const id = '395c1d2e3f4a5b6c7d8e9f0a1b2c38ab';
    test('accepts a bare 32-hex id or a dashed UUID', () => {
        expect(extractNotionId(id)).toBe(id);
        expect(extractNotionId('395c1d2e-3f4a-5b6c-7d8e-9f0a1b2c38ab')).toBe(id);
        expect(extractNotionId(id.toUpperCase())).toBe(id);
    });
    test('extracts the id from pasted Notion URLs and ignores the ?v= view id', () => {
        expect(extractNotionId(`https://www.notion.so/${id}?v=aaaaaaaabbbbbbbbccccccccdddddddd`)).toBe(id);
        expect(extractNotionId(`https://app.notion.com/p/${id}?v=1234`)).toBe(id);
        expect(extractNotionId(`https://www.notion.so/myworkspace/Cafe-Brain-Dump-Journal-${id}`)).toBe(id);
    });
    test('rejects things without an id', () => {
        expect(extractNotionId('')).toBeNull();
        expect(extractNotionId('https://www.notion.so/my-page')).toBeNull();
        expect(extractNotionId('fake_db_123')).toBeNull();
    });
    test('validates the integration token shape', () => {
        expect(validateNotionKey('')).toMatch(/Paste/);
        expect(validateNotionKey('abc')).toMatch(/start with/);
        expect(validateNotionKey('ntn_short')).toMatch(/too short/);
        expect(validateNotionKey('ntn_' + 'a'.repeat(40))).toBeNull();
        expect(validateNotionKey('secret_' + 'a'.repeat(40))).toBeNull();
    });
});

describe('file helpers (B-28)', () => {
    test('detects HEIC/HEIF by MIME type or extension (empty MIME on some devices)', () => {
        expect(isHeicFile({ type: 'image/heic', name: 'a' })).toBe(true);
        expect(isHeicFile({ type: '', name: 'IMG_1.HEIF' })).toBe(true);
        expect(isHeicFile({ type: '', name: 'IMG_1.heic' })).toBe(true);
        expect(isHeicFile({ type: 'image/jpeg', name: 'a.jpg' })).toBe(false);
        expect(isAcceptedImage({ type: '', name: 'IMG_1.heif' })).toBe(true);
        expect(isAcceptedImage({ type: 'application/pdf', name: 'a.pdf' })).toBe(false);
    });
});

describe('heatmap in the user time zone (B-22)', () => {
    test('buckets a late-evening New York sync on the New York date, not IST', () => {
        // 2026-02-10 23:30 in New York (EST) == 2026-02-11 04:30 UTC == 2026-02-11 10:00 IST
        const sync = new Date('2026-02-11T04:30:00Z');
        const today = new Date('2026-02-11T12:00:00Z');
        const ny = buildHeatmapDays([sync], 'America/New_York', today, 3);
        expect(ny.map(d => d.date)).toEqual(['2026-02-09', '2026-02-10', '2026-02-11']);
        expect(ny.find(d => d.date === '2026-02-10').count).toBe(1);
        const ist = buildHeatmapDays([sync], 'Asia/Kolkata', today, 3);
        expect(ist.find(d => d.date === '2026-02-11').count).toBe(1);
    });
    test('returns N consecutive days ending today', () => {
        const days = buildHeatmapDays([], 'UTC', new Date('2026-01-02T00:00:00Z'), 30);
        expect(days).toHaveLength(30);
        expect(days[0].date).toBe('2025-12-04');
        expect(days[29].date).toBe('2026-01-02');
    });
    test('invalid time zones fall back to UTC instead of throwing', () => {
        expect(() => buildHeatmapDays([new Date()], 'Not/AZone')).not.toThrow();
    });
});

describe('activateDialog (U-04)', () => {
    test('Escape requests close, Tab is trapped, focus is restored', () => {
        jest.useFakeTimers();
        document.body.innerHTML = `
            <button id="opener">open</button>
            <div id="dlg"><button id="a">a</button><button id="b">b</button></div>`;
        const opener = document.getElementById('opener');
        opener.focus();
        const onClose = jest.fn();
        const dlg = document.getElementById('dlg');
        const deactivate = activateDialog(dlg, onClose);
        jest.runAllTimers();
        expect(document.activeElement.id).toBe('a');

        document.getElementById('b').focus();
        const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
        dlg.dispatchEvent(tab);
        expect(tab.defaultPrevented).toBe(true);
        expect(document.activeElement.id).toBe('a');

        dlg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(onClose).toHaveBeenCalledTimes(1);

        deactivate();
        expect(document.activeElement).toBe(opener);
        jest.useRealTimers();
    });
});

describe('contract additions', () => {
    test('409 SYNC_IN_PROGRESS is "still processing", not a failure', () => {
        const info = describeApiError({ status: 409, data: { errorCode: 'SYNC_IN_PROGRESS', error: 'busy' } });
        expect(info.kind).toBe('processing');
        expect(info.message).toBe(PROCESSING_MESSAGE);
        expect(info.showUpgrade).toBe(false);
    });
    test('503 / payment gateway / reauth errors get plain messages', () => {
        expect(describeApiError({ status: 503, data: {} }).errorCode).toBe('SERVICE_UNAVAILABLE');
        expect(describeApiError({ status: 503, data: { errorCode: 'SERVICE_UNAVAILABLE', error: 'Error: x' } }).message).toMatch(/temporarily unavailable/);
        expect(describeApiError({ status: 502, data: { errorCode: 'PAYMENT_GATEWAY_ERROR', error: 'upstream 500' } }).message).toMatch(/not been charged/);
        const reauth = describeApiError({ status: 401, data: { errorCode: 'REAUTH_REQUIRED', error: 'x' } });
        expect(reauth.message).toMatch(/confirm it/);
        expect(reauth.retryable).toBe(false);
    });
    test('Q-01: getApiUrls no longer returns a duplicate FALLBACK_API_URL', () => {
        expect(getApiUrls('planner.analogdigital.tech', 'updateProfile')).toEqual({ PRIMARY_API_URL: '/updateProfile' });
    });
});

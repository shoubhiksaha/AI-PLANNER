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
    test('uses localhost URL with projectId for local development', () => {
        const { PRIMARY_API_URL } = getApiUrls('localhost');
        expect(PRIMARY_API_URL).toContain('127.0.0.1:5001');
        expect(PRIMARY_API_URL).toContain('syncPlanner');
    });

    test('uses localhost URL for 127.0.0.1', () => {
        const { PRIMARY_API_URL } = getApiUrls('127.0.0.1');
        expect(PRIMARY_API_URL).toContain('127.0.0.1:5001');
    });

    test('uses relative URL for production or staging hostnames', () => {
        const { PRIMARY_API_URL } = getApiUrls('ai-planner-project-467800.web.app');
        expect(PRIMARY_API_URL).toBe('/syncPlanner');

        const staging = getApiUrls('staging-planner.analogdigital.tech');
        expect(staging.PRIMARY_API_URL).toBe('/syncPlanner');
    });

    test('uses relative URL for any custom domain', () => {
        const { PRIMARY_API_URL } = getApiUrls('planner.analogdigital.tech');
        expect(PRIMARY_API_URL).toBe('/syncPlanner');
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
            <button id="theme-btn"></button>
            <div class="theme-item">Light</div>
            <div class="theme-item">Dark</div>
            <div class="theme-item">OLED</div>
            <div class="theme-item">Auto</div>
        `;
        html = document.documentElement;
        btn = document.getElementById('theme-btn');
        items = document.querySelectorAll('.theme-item');
    });

    test('applies light mode (removes all dark classes)', () => {
        html.classList.add('dark-mode'); // start in dark
        applyTheme('light', html, btn, items);
        expect(html.classList.contains('dark-mode')).toBe(false);
        expect(html.classList.contains('oled-mode')).toBe(false);
        expect(btn.textContent).toBe('☀️');
    });

    test('applies dark mode', () => {
        applyTheme('dark', html, btn, items);
        expect(html.classList.contains('dark-mode')).toBe(true);
        expect(html.classList.contains('oled-mode')).toBe(false);
        expect(btn.textContent).toBe('🌙');
    });

    test('applies OLED mode', () => {
        applyTheme('oled', html, btn, items);
        expect(html.classList.contains('oled-mode')).toBe(true);
        expect(html.classList.contains('dark-mode')).toBe(false);
        expect(btn.textContent).toBe('🖤');
    });

    test('auto mode resolves to dark when system prefers dark', () => {
        applyTheme('auto', html, btn, items, true);
        expect(html.classList.contains('dark-mode')).toBe(true);
        expect(btn.textContent).toBe('⚙️');
    });

    test('auto mode resolves to light when system prefers light', () => {
        applyTheme('auto', html, btn, items, false);
        expect(html.classList.contains('dark-mode')).toBe(false);
        expect(html.classList.contains('oled-mode')).toBe(false);
        expect(btn.textContent).toBe('⚙️');
    });

    test('highlights the selected theme item', () => {
        applyTheme('dark', html, btn, items);
        const darkItem = [...items].find(el => el.textContent.toLowerCase().includes('dark'));
        expect(darkItem.classList.contains('selected')).toBe(true);
    });

    test('works gracefully when themeBtn is null', () => {
        expect(() => applyTheme('dark', html, null, items)).not.toThrow();
        expect(html.classList.contains('dark-mode')).toBe(true);
    });
});

describe('triggerSync URL fallback logic', () => {
    let originalFetch;

    beforeEach(() => {
        originalFetch = global.fetch;
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    test('primary URL failure throws cleanly without leaking tokens cross-domain', async () => {
        const callLog = [];

        global.fetch = jest.fn(async (url) => {
            callLog.push(url);
            throw new Error('Network timeout');
        });

        const { PRIMARY_API_URL } = getApiUrls('staging-planner.analogdigital.tech');

        await expect(async () => {
            const res = await fetch(PRIMARY_API_URL, { method: 'POST' });
            await parseJsonResponse(res);
        }).rejects.toThrow('Network timeout');

        expect(callLog).toHaveLength(1);
        expect(callLog[0]).toBe('/syncPlanner');
    });

    test('primary URL succeeds without fallback', async () => {
        const callLog = [];

        global.fetch = jest.fn(async (url) => {
            callLog.push(url);
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ text: "Done" }),
                headers: { get: () => 'application/json' }
            };
        });

        const { PRIMARY_API_URL } = getApiUrls('ai-planner-project-467800.web.app');
        const res = await fetch(PRIMARY_API_URL, { method: 'POST' });
        const data = await parseJsonResponse(res);

        expect(callLog).toHaveLength(1);
        expect(callLog[0]).toBe('/syncPlanner');
        expect(data).toEqual({ text: "Done" });
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

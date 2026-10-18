/**
 * Round-2 contract helpers: C8 HEIC, C9 App Check fetch wrapper, C10 emulator
 * gate, C11 interrupted-sync history rows.
 *
 * @jest-environment jsdom
 */
const fs = require('fs');
const path = require('path');
const {
    isEmulatorMode,
    emulatorFirebaseConfig,
    EMULATOR_PROJECT_ID,
    shouldUseAppCheckDebugToken,
    appCheckSiteKeyFrom,
    createFunctionsFetch,
    APP_CHECK_HEADER,
    isHeicFile,
    heicMimeFor,
    toHeicDataUrl,
    isHeicDataUrl,
    imagesPayloadChars,
    heicTooLargeMessage,
    MAX_IMAGE_BYTES,
    describeHistoryEntry,
    INTERRUPTED_MESSAGE,
} = require('../app-helpers');

const appSource = fs.readFileSync(path.resolve(__dirname, '../app.js'), 'utf8');

describe('C10 emulator gate', () => {
    test('active on localhost / 127.0.0.1 with ?emulator=true', () => {
        expect(isEmulatorMode({ hostname: 'localhost', search: '?emulator=true' }, {})).toBe(true);
        expect(isEmulatorMode({ hostname: '127.0.0.1', search: '?foo=1&emulator=true' }, {})).toBe(true);
    });

    test('active on localhost when environment is "emulator"', () => {
        expect(isEmulatorMode({ hostname: 'localhost', search: '' }, { environment: 'emulator' })).toBe(true);
    });

    test('inactive on localhost without the flag', () => {
        expect(isEmulatorMode({ hostname: 'localhost', search: '' }, { environment: 'staging' })).toBe(false);
        expect(isEmulatorMode({ hostname: 'localhost', search: '?emulator=false' }, {})).toBe(false);
        expect(isEmulatorMode({ hostname: 'localhost', search: '?x=emulator=true' }, {})).toBe(false);
    });

    test.each([
        'planner.analogdigital.tech',
        'staging-planner.analogdigital.tech',
        'ai-planner-staging.web.app',
        'localhost.evil.com',
        'evil-localhost',
        '127.0.0.1.nip.io',
        '0.0.0.0',
        '',
    ])('never active on %p, even when asked', (hostname) => {
        expect(isEmulatorMode({ hostname, search: '?emulator=true' }, { environment: 'emulator' })).toBe(false);
    });

    test('tolerates missing inputs', () => {
        expect(isEmulatorMode(undefined, undefined)).toBe(false);
        expect(isEmulatorMode({ hostname: 'localhost' }, null)).toBe(false);
    });

    test('emulator config forces a demo- project id', () => {
        const env = { projectId: 'ai-planner-project-467800', apiKey: 'k' };
        expect(emulatorFirebaseConfig(env)).toEqual({ projectId: EMULATOR_PROJECT_ID, apiKey: 'k', firestoreDatabaseId: '(default)', functionsRegion: 'us-central1' });
        expect(env.projectId).toBe('ai-planner-project-467800'); // input not mutated
        const demo = { projectId: 'demo-other' };
        expect(emulatorFirebaseConfig(demo)).toBe(demo);
        expect(EMULATOR_PROJECT_ID).toMatch(/^demo-/);
    });

    test('app.js only connects emulators / defines e2eLogin behind the gate', () => {
        expect(appSource).toMatch(/const EMULATOR_MODE = helpers\.isEmulatorMode\(window\.location, runtimeConfig\);/);
        const lines = appSource.split('\n');
        lines.forEach((line) => {
            if (/connectAuthEmulator\(|connectFirestoreEmulator\(/.test(line)) {
                expect(line).toMatch(/if \(EMULATOR_MODE\)/);
            }
        });
        expect(appSource).toMatch(/if \(EMULATOR_MODE\) \{\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*window\.e2eLogin = /);
        expect(appSource).not.toMatch(/search\.includes\(["']emulator=true/);
    });
});

describe('C9 App Check', () => {
    test('debug token only on a local host', () => {
        expect(shouldUseAppCheckDebugToken('localhost')).toBe(true);
        expect(shouldUseAppCheckDebugToken('127.0.0.1')).toBe(true);
        expect(shouldUseAppCheckDebugToken('planner.analogdigital.tech')).toBe(false);
    });

    test('site key: empty / missing means off', () => {
        expect(appCheckSiteKeyFrom({ appCheckSiteKey: '' })).toBeNull();
        expect(appCheckSiteKeyFrom({ appCheckSiteKey: '   ' })).toBeNull();
        expect(appCheckSiteKeyFrom({})).toBeNull();
        expect(appCheckSiteKeyFrom(null)).toBeNull();
        expect(appCheckSiteKeyFrom({ appCheckSiteKey: ' 6Lc-key ' })).toBe('6Lc-key');
    });

    test('env-config.js ships an empty appCheckSiteKey', () => {
        const env = fs.readFileSync(path.resolve(__dirname, '../env-config.js'), 'utf8');
        expect(env).toMatch(/appCheckSiteKey:\s*""/);
    });

    test('adds X-Firebase-AppCheck when a token is available', async () => {
        const fetchImpl = jest.fn().mockResolvedValue('ok');
        const apiFetch = createFunctionsFetch({ fetchImpl, getAppCheckToken: async () => 'tok-123' });
        const res = await apiFetch('/updateProfile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        expect(res).toBe('ok');
        expect(fetchImpl).toHaveBeenCalledWith('/updateProfile', {
            method: 'POST',
            body: '{}',
            headers: { 'Content-Type': 'application/json', [APP_CHECK_HEADER]: 'tok-123' },
        });
        expect(APP_CHECK_HEADER).toBe('X-Firebase-AppCheck');
    });

    test('keeps other headers (BYOK) and supports Headers instances', async () => {
        const fetchImpl = jest.fn().mockResolvedValue('ok');
        const apiFetch = createFunctionsFetch({ fetchImpl, getAppCheckToken: () => 't' });
        await apiFetch('https://x/syncPlanner', { headers: new Headers({ 'X-BYOK-Token': 'k' }) });
        const sent = fetchImpl.mock.calls[0][1].headers;
        expect(sent['x-byok-token']).toBe('k');
        expect(sent[APP_CHECK_HEADER]).toBe('t');
    });

    test.each([
        ['no token provider', undefined],
        ['provider returns null', async () => null],
        ['provider returns empty string', async () => ''],
        ['provider throws', async () => { throw new Error('recaptcha blocked'); }],
        ['provider throws synchronously', () => { throw new Error('sync'); }],
    ])('sends the request without the header when %s', async (_label, getAppCheckToken) => {
        const fetchImpl = jest.fn().mockResolvedValue('ok');
        const apiFetch = createFunctionsFetch({ fetchImpl, getAppCheckToken });
        await apiFetch('/logClientError', { method: 'POST', keepalive: true });
        const init = fetchImpl.mock.calls[0][1];
        expect(init.headers).toEqual({});
        expect(init.keepalive).toBe(true);
    });

    test('a hanging token lookup does not block the call', async () => {
        jest.useFakeTimers();
        const fetchImpl = jest.fn().mockResolvedValue('ok');
        const apiFetch = createFunctionsFetch({ fetchImpl, getAppCheckToken: () => new Promise(() => {}), tokenTimeoutMs: 1000 });
        const p = apiFetch('/setupBYOK', {});
        await jest.advanceTimersByTimeAsync(1000);
        await p;
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(fetchImpl.mock.calls[0][1].headers).toEqual({});
        jest.useRealTimers();
    });

    test('every network call in app.js goes through apiFetch', () => {
        const raw = appSource.match(/(?<![.\w])fetch\(/g) || [];
        expect(raw).toHaveLength(0);
        expect((appSource.match(/apiFetch\(/g) || []).length).toBeGreaterThanOrEqual(10);
        expect(appSource).toMatch(/firebase-app-check\.js/);
        expect(appSource).toMatch(/firebasejs\/11\.1\.0\/firebase-app-check\.js/);
    });

    test('hosting CSP allows reCAPTCHA Enterprise and App Check', () => {
        const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../firebase.json'), 'utf8'));
        const hosting = Array.isArray(cfg.hosting) ? cfg.hosting : [cfg.hosting];
        const csp = hosting
            .flatMap(site => site.headers || [])
            .flatMap(h => h.headers)
            .find(h => h.key === 'Content-Security-Policy').value;
        const directive = (name) => (csp.split(';').map(s => s.trim()).find(s => s.startsWith(`${name} `)) || '').split(/\s+/);
        expect(directive('script-src')).toEqual(expect.arrayContaining(['https://www.google.com/recaptcha/', 'https://www.gstatic.com/recaptcha/']));
        expect(directive('frame-src')).toEqual(expect.arrayContaining(['https://www.google.com/recaptcha/', 'https://recaptcha.google.com/recaptcha/']));
        expect(directive('connect-src')).toEqual(expect.arrayContaining(['https://content-firebaseappcheck.googleapis.com', 'https://www.google.com/recaptcha/']));
        // Emulator hosts never belong in the production CSP.
        expect(csp).not.toMatch(/127\.0\.0\.1|localhost/);
    });
});

describe('C8 HEIC', () => {
    test('detects HEIC/HEIF by MIME or extension', () => {
        expect(isHeicFile({ type: 'image/heif', name: 'x' })).toBe(true);
        expect(isHeicFile({ type: '', name: 'IMG_2.HEIC' })).toBe(true);
        expect(isHeicFile({ type: 'application/octet-stream', name: 'scan.heif' })).toBe(true);
        expect(isHeicFile({ type: 'image/png', name: 'a.png' })).toBe(false);
        expect(isHeicFile(null)).toBe(false);
    });

    test('picks image/heif only for HEIF files', () => {
        expect(heicMimeFor({ type: 'image/heic', name: 'a.heic' })).toBe('image/heic');
        expect(heicMimeFor({ type: '', name: 'a.HEIC' })).toBe('image/heic');
        expect(heicMimeFor({ type: 'image/heif', name: 'a' })).toBe('image/heif');
        expect(heicMimeFor({ type: '', name: 'a.heif' })).toBe('image/heif');
        expect(heicMimeFor({ type: 'image/heic', name: 'a.heif' })).toBe('image/heic');
    });

    test('re-labels the raw data URL without touching the bytes', () => {
        expect(toHeicDataUrl('data:application/octet-stream;base64,AAAA', 'image/heic')).toBe('data:image/heic;base64,AAAA');
        expect(toHeicDataUrl('data:;base64,AAAA', 'image/heif')).toBe('data:image/heif;base64,AAAA');
        expect(toHeicDataUrl('data:image/heic;base64,AAAA')).toBe('data:image/heic;base64,AAAA');
        expect(toHeicDataUrl('data:image/heic;base64,AAAA', 'text/html')).toBe('data:image/heic;base64,AAAA');
        expect(toHeicDataUrl('data:text/plain,hello', 'image/heic')).toBeNull();
        expect(toHeicDataUrl('AAAA', 'image/heic')).toBeNull();
        expect(toHeicDataUrl(null)).toBeNull();
    });

    test('recognises undecodable HEIC entries for the placeholder thumbnail', () => {
        expect(isHeicDataUrl('data:image/heic;base64,AAAA')).toBe(true);
        expect(isHeicDataUrl('data:image/HEIF;base64,AAAA')).toBe(true);
        expect(isHeicDataUrl('data:image/jpeg;base64,AAAA')).toBe(false);
        expect(isHeicDataUrl(undefined)).toBe(false);
    });

    test('size limit and over-size message', () => {
        expect(MAX_IMAGE_BYTES).toBe(20 * 1024 * 1024);
        expect(heicTooLargeMessage('IMG_1.HEIC')).toMatch(/^IMG_1\.HEIC is a HEIC photo larger than 20 MB/);
        expect(imagesPayloadChars(['abc', 'de', null])).toBe(5);
        expect(imagesPayloadChars(undefined)).toBe(0);
    });

    test('the old "HEIC not supported" message is gone from app.js', () => {
        expect(appSource).not.toMatch(/HEIC photo this browser can’t open/);
        expect(appSource).toMatch(/HEIC photo<\/span>/); // placeholder tile label
    });
});

describe('C11 history rows', () => {
    test('failed + interrupted → "Interrupted — credit refunded"', () => {
        expect(describeHistoryEntry({ status: 'failed', failureReason: 'interrupted', message: 'x' }))
            .toEqual({ state: 'interrupted', message: 'Interrupted — credit refunded' });
        expect(INTERRUPTED_MESSAGE).toBe('Interrupted — credit refunded');
    });

    test('other states keep their message', () => {
        expect(describeHistoryEntry({ status: 'success', message: '3 events added' })).toEqual({ state: 'success', message: '3 events added' });
        expect(describeHistoryEntry({ status: 'failed', message: 'AI busy' })).toEqual({ state: 'failed', message: 'AI busy' });
        expect(describeHistoryEntry({ status: 'failed', failureReason: 'other', message: 'm' }).state).toBe('failed');
        expect(describeHistoryEntry({ status: 'processing' })).toEqual({ state: 'pending', message: 'Processing…' });
        expect(describeHistoryEntry(null)).toEqual({ state: 'failed', message: 'Sync failed' });
    });
});

describe('Round 3: one project, two environments', () => {
    const helpers = require('../app-helpers');
    const { getApiUrls, firestoreDatabaseIdFrom, functionsRegionFrom } = helpers;
    afterEach(() => { delete window.__ENV_CONFIG__; });

    const PROD = { projectId: 'ai-planner-project-467800', firestoreDatabaseId: '(default)', functionsRegion: 'us-central1' };
    const STAGING = { projectId: 'ai-planner-project-467800', firestoreDatabaseId: 'staging', functionsRegion: 'asia-south1' };

    test('production: direct syncPlanner in us-central1, other endpoints same-origin', () => {
        window.__ENV_CONFIG__ = PROD;
        expect(getApiUrls('planner.analogdigital.tech').PRIMARY_API_URL)
            .toBe('https://us-central1-ai-planner-project-467800.cloudfunctions.net/syncPlanner');
        expect(getApiUrls('planner.analogdigital.tech', 'updateProfile').PRIMARY_API_URL).toBe('/updateProfile');
    });

    test('staging: direct syncPlanner in asia-south1, other endpoints same-origin', () => {
        window.__ENV_CONFIG__ = STAGING;
        expect(getApiUrls('ai-planner-staging.web.app').PRIMARY_API_URL)
            .toBe('https://asia-south1-ai-planner-project-467800.cloudfunctions.net/syncPlanner');
        expect(getApiUrls('staging-planner.analogdigital.tech', 'setupNotion').PRIMARY_API_URL).toBe('/setupNotion');
    });

    test('functionsBaseUrl override still wins over the region', () => {
        window.__ENV_CONFIG__ = { ...STAGING, functionsBaseUrl: 'https://fn.example.com//' };
        expect(getApiUrls('ai-planner-staging.web.app').PRIMARY_API_URL).toBe('https://fn.example.com/syncPlanner');
    });

    test('localhost emulator URL uses project and region', () => {
        window.__ENV_CONFIG__ = { projectId: 'demo-ai-planner', functionsRegion: 'us-central1' };
        expect(getApiUrls('localhost').PRIMARY_API_URL).toBe('http://127.0.0.1:5001/demo-ai-planner/us-central1/syncPlanner');
        window.__ENV_CONFIG__ = STAGING;
        expect(getApiUrls('127.0.0.1', 'updateProfile').PRIMARY_API_URL)
            .toBe('http://127.0.0.1:5001/ai-planner-project-467800/asia-south1/updateProfile');
    });

    test('missing / malformed region falls back to us-central1', () => {
        window.__ENV_CONFIG__ = { projectId: 'p' };
        expect(getApiUrls('planner.analogdigital.tech').PRIMARY_API_URL).toBe('https://us-central1-p.cloudfunctions.net/syncPlanner');
        expect(functionsRegionFrom({ functionsRegion: 'evil.com/x' })).toBe('us-central1');
        expect(functionsRegionFrom({ functionsRegion: ' asia-south1 ' })).toBe('asia-south1');
        expect(functionsRegionFrom(undefined)).toBe('us-central1');
    });

    test('database id: default, staging, malformed', () => {
        expect(firestoreDatabaseIdFrom({})).toBe('(default)');
        expect(firestoreDatabaseIdFrom({ firestoreDatabaseId: '(default)' })).toBe('(default)');
        expect(firestoreDatabaseIdFrom({ firestoreDatabaseId: 'staging' })).toBe('staging');
        expect(firestoreDatabaseIdFrom({ firestoreDatabaseId: '../x' })).toBe('(default)');
        expect(firestoreDatabaseIdFrom(null)).toBe('(default)');
    });

    test('app.js passes the configured database id to getFirestore / initializeFirestore', () => {
        expect(appSource).toMatch(/const databaseId = firestoreDatabaseIdFrom\(firebaseConfig\);/);
        expect(appSource).toMatch(/mod\.getFirestore\(app, databaseId\)/);
        expect(appSource).toMatch(/mod\.initializeFirestore\(app, \{[^}]*\}, databaseId\)/);
        // No other Firestore instance is created anywhere in app.js.
        expect((appSource.match(/getFirestore\(/g) || []).length).toBe(1);
        expect((appSource.match(/initializeFirestore\(/g) || []).length).toBe(1);
    });

    test('loadDb uses the staging database outside emulator mode and (default) in the emulator', async () => {
        const start = appSource.indexOf('let firestoreDb = null;');
        const end = appSource.indexOf('return { ...mod, db: firestoreDb };', start);
        const snippet = appSource.slice(start, appSource.indexOf('\n};', end) + 3);
        const mkModule = () => ({
            getFirestore: jest.fn(() => 'db'),
            initializeFirestore: jest.fn(() => 'emu-db'),
            connectFirestoreEmulator: jest.fn(),
        });
        const load = (mod, EMULATOR_MODE, firebaseConfig) => new Function(
            'loadFirestore', 'app', 'EMULATOR_MODE', 'firebaseConfig', 'firestoreDatabaseIdFrom',
            `${snippet}\nreturn loadDb();`
        )(async () => mod, 'APP', EMULATOR_MODE, firebaseConfig, firestoreDatabaseIdFrom);

        const prodMod = mkModule();
        await load(prodMod, false, STAGING);
        expect(prodMod.getFirestore).toHaveBeenCalledWith('APP', 'staging');
        expect(prodMod.connectFirestoreEmulator).not.toHaveBeenCalled();

        const emuMod = mkModule();
        await load(emuMod, true, helpers.emulatorFirebaseConfig(STAGING));
        expect(emuMod.initializeFirestore).toHaveBeenCalledWith('APP', expect.any(Object), '(default)');
        expect(emuMod.connectFirestoreEmulator).toHaveBeenCalledWith('emu-db', '127.0.0.1', 8080);
    });

    test('emulator config keeps an explicitly configured demo database/region', () => {
        const demo = { projectId: 'demo-ai-planner', firestoreDatabaseId: 'staging', functionsRegion: 'asia-south1' };
        expect(helpers.emulatorFirebaseConfig(demo)).toBe(demo);
        expect(helpers.emulatorFirebaseConfig(STAGING)).toMatchObject({
            projectId: 'demo-ai-planner', firestoreDatabaseId: '(default)', functionsRegion: 'us-central1',
        });
    });

    test('default env-config.js points at staging in the single project', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../env-config.js'), 'utf8');
        const win = {};
        new Function('window', src)(win);
        expect(win.__ENV_CONFIG__).toMatchObject({
            projectId: 'ai-planner-project-467800',
            firestoreDatabaseId: 'staging',
            functionsRegion: 'asia-south1',
            environment: 'staging',
            hostingUrl: 'https://ai-planner-staging.web.app',
            appId: '1:195957114195:web:06bf15f172f55d2ff3cda6',
            messagingSenderId: '195957114195',
            appCheckSiteKey: '',
        });
    });

    test('CSP connect-src has both function regions of the single project and no staging project', () => {
        const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../firebase.json'), 'utf8'));
        const hosting = Array.isArray(cfg.hosting) ? cfg.hosting : [cfg.hosting];
        hosting.forEach((h) => {
            const csp = (h.headers || []).flatMap(x => x.headers).find(x => x.key === 'Content-Security-Policy');
            if (!csp) return;
            const connect = csp.value.split(';').map(x => x.trim()).find(x => x.startsWith('connect-src ')).split(/\s+/);
            expect(connect).toEqual(expect.arrayContaining([
                'https://us-central1-ai-planner-project-467800.cloudfunctions.net',
                'https://asia-south1-ai-planner-project-467800.cloudfunctions.net',
            ]));
            expect(csp.value).not.toMatch(/ai-planner-staging\.cloudfunctions\.net/);
        });
    });
});

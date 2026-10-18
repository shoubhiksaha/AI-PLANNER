#!/usr/bin/env node
/**
 * AI Planner — prepare the local emulator environment for end-to-end tests.
 *
 *   node scripts/e2e/prepare-emulator-env.js          # create
 *   node scripts/e2e/prepare-emulator-env.js --clean  # remove everything it created
 *
 * Creates (all gitignored, all removed by --clean):
 *   firebase.e2e.json              firebase.json + emulator ports + a CSP that also allows the emulators
 *   e2e/.hosting/                  copy of public/ with an emulator env-config.js
 *   functions/.env.demo-ai-planner params for the `demo-ai-planner` project (E2E_FAKE_EXTERNALS=true)
 *   functions/.secret.local        fake secret values for the Functions emulator
 *
 * The `demo-` project prefix means the emulators never touch real Google resources, and the
 * backend fakes only switch on when FUNCTIONS_EMULATOR=true and E2E_FAKE_EXTERNALS=true.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const PROJECT_ID = 'demo-ai-planner';
const PORTS = { hosting: 5050, functions: 5001, firestore: 8080, auth: 9099 };

const paths = {
    config: path.join(ROOT, 'firebase.e2e.json'),
    hosting: path.join(ROOT, 'e2e', '.hosting'),
    params: path.join(ROOT, 'functions', `.env.${PROJECT_ID}`),
    secrets: path.join(ROOT, 'functions', '.secret.local'),
};

function clean() {
    fs.rmSync(paths.config, { force: true });
    fs.rmSync(paths.hosting, { recursive: true, force: true });
    fs.rmSync(paths.params, { force: true });
    fs.rmSync(paths.secrets, { force: true });
    console.log('🧹 Removed emulator e2e files.');
}

function emulatorCsp(csp) {
    const emulatorHosts = [
        `http://127.0.0.1:${PORTS.auth}`, `http://localhost:${PORTS.auth}`,
        `http://127.0.0.1:${PORTS.firestore}`, `ws://127.0.0.1:${PORTS.firestore}`,
        `http://127.0.0.1:${PORTS.functions}`,
    ].join(' ');
    return csp
        .split(';')
        .map(d => d.trim())
        .filter(d => d && d !== 'upgrade-insecure-requests')
        .map(d => {
            if (d.startsWith('connect-src')) return `${d} ${emulatorHosts}`;
            if (d.startsWith('frame-src')) return `${d} http://127.0.0.1:${PORTS.auth} http://localhost:${PORTS.auth}`;
            return d;
        })
        .join('; ');
}

function prepare() {
    clean();
    const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));

    // Hosting: serve a copy of public/ so the real env-config.js is never modified.
    fs.cpSync(path.join(ROOT, 'public'), paths.hosting, {
        recursive: true,
        filter: src => !src.includes(`${path.sep}__tests__`) && !src.includes(`${path.sep}coverage`),
    });
    fs.writeFileSync(path.join(paths.hosting, 'env-config.js'), `// Generated for emulator e2e tests.
window.__ENV_CONFIG__ = {
    apiKey: "demo-api-key",
    authDomain: "${PROJECT_ID}.firebaseapp.com",
    projectId: "${PROJECT_ID}",
    storageBucket: "${PROJECT_ID}.appspot.com",
    messagingSenderId: "000000000000",
    appId: "1:000000000000:web:0000000000000000",
    environment: "emulator",
    hostingUrl: "http://localhost:${PORTS.hosting}",
    firestoreDatabaseId: "(default)",
    functionsRegion: "us-central1",
    appCheckSiteKey: ""
};
`);

    const config = JSON.parse(JSON.stringify(base));
    config.hosting.public = 'e2e/.hosting';
    delete config.hosting.site; // the demo- project has a single default site
    delete config.hosting.predeploy;
    delete config.functions[0].predeploy;
    for (const db of [].concat(config.firestore)) delete db.predeploy;
    for (const rule of config.hosting.headers || []) {
        for (const h of rule.headers || []) {
            if (h.key.toLowerCase() === 'content-security-policy') h.value = emulatorCsp(h.value);
        }
    }
    config.emulators = {
        singleProjectMode: true,
        ui: { enabled: false },
        auth: { port: PORTS.auth, host: '127.0.0.1' },
        firestore: { port: PORTS.firestore, host: '127.0.0.1' },
        functions: { port: PORTS.functions, host: '127.0.0.1' },
        hosting: { port: PORTS.hosting, host: '127.0.0.1' },
    };
    fs.writeFileSync(paths.config, JSON.stringify(config, null, 2) + '\n');

    fs.writeFileSync(paths.params, [
        '# Generated for emulator e2e tests — removed after the run.',
        'E2E_FAKE_EXTERNALS=true',
        'APP_ENVIRONMENT=emulator',
        'FIRESTORE_DATABASE_ID=(default)',
        'FUNCTIONS_REGION=us-central1',
        'KMS_KEY_NAME=projects/demo-ai-planner/locations/global/keyRings/e2e/cryptoKeys/e2e',
        'CASHFREE_ENVIRONMENT=disabled',
        'CASHFREE_NOTIFY_URL=http://localhost:5050/cashfreeWebhook',
        'PAYMENTS_ENABLED=false',
        'ALLOW_CUSTOM_BYOK_URLS=false',
        'REQUIRE_APP_CHECK=false',
        `APP_HOSTING_URL=http://localhost:${PORTS.hosting}`,
        '',
    ].join('\n'));

    const fake = () => crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(paths.secrets, [
        `GEMINI_API_KEY=e2e-fake-gemini-${fake().slice(0, 16)}`,
        `NOTION_ENCRYPTION_KEY_V2=${fake()}`,
        `CREDITS_GRANT_TOKEN=${fake()}`,
        'CASHFREE_APP_ID=e2e-fake',
        'CASHFREE_SECRET_KEY=e2e-fake',
        '',
    ].join('\n'), { mode: 0o600 });

    console.log(`✅ Emulator e2e environment ready (project ${PROJECT_ID}, hosting http://localhost:${PORTS.hosting}).`);
}

if (process.argv.includes('--clean')) clean();
else prepare();

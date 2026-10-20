// node --test scripts/ci/firebase-config.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildConfig, verify } = require('./firebase-config');

const base = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'firebase.json'), 'utf8'));

test('firebase.json itself is a valid production config', () => {
    assert.deepStrictEqual(verify(base, 'production'), []);
});

test('staging config targets the staging site, region, codebase and database only', () => {
    const staging = buildConfig(base, 'staging');
    assert.deepStrictEqual(verify(staging, 'staging'), []);
    assert.strictEqual(staging.hosting.site, 'ai-planner-staging');
    assert.strictEqual(staging.functions[0].codebase, 'staging');
    assert.deepStrictEqual(staging.firestore.map(f => f.database), ['staging']);
    for (const r of staging.hosting.rewrites.filter(r => r.function)) {
        assert.strictEqual(r.function.region, 'asia-south1', r.source);
    }
});

test('staging keeps the exact production headers (CSP, security headers)', () => {
    const staging = buildConfig(base, 'staging');
    assert.deepStrictEqual(staging.hosting.headers, base.hosting.headers);
    assert.deepStrictEqual(staging.hosting.ignore, base.hosting.ignore);
    assert.deepStrictEqual(staging.functions[0].ignore, base.functions[0].ignore);
});

test('the generator never touches production resources', () => {
    const staging = buildConfig(base, 'staging');
    const text = JSON.stringify(staging);
    assert.ok(!/"site":"ai-planner-project-467800"/.test(text));
    assert.ok(!/"region":"us-central1"/.test(text));
    assert.ok(!/"database":"\(default\)"/.test(text));
});

test('unknown environment is rejected', () => {
    assert.throws(() => buildConfig(base, 'prod'), /Unknown environment/);
});

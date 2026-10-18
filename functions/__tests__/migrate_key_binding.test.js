/**
 * S-16: scripts/migrate_key_binding.js re-encrypts stored keys bound to their
 * owner. Firestore is the in-memory fake; KMS is a local AES-GCM stand-in.
 */
const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');
const { createFakeFirestore } = require('./helpers/fakeFirestore');
const utils = require('../utils');
const {
    CONFIRMATION,
    parseArgs,
    validateArgs,
    checkProjectGuard,
    maskEmail,
    migrateKeyBinding,
} = require('../scripts/migrate_key_binding');

const cryptoKey = utils.deriveKey('migration-test-secret');

/** Local envelope encryption with the same shape and AAD semantics as services/kms. */
function fakeKms() {
    const kek = crypto.randomBytes(32);
    const wrap = (dek) => {
        const iv = crypto.randomBytes(12);
        const c = crypto.createCipheriv('aes-256-gcm', kek, iv);
        return Buffer.concat([iv, c.update(dek), c.final(), c.getAuthTag()]).toString('base64');
    };
    const unwrap = (b64) => {
        const raw = Buffer.from(b64, 'base64');
        const d = crypto.createDecipheriv('aes-256-gcm', kek, raw.subarray(0, 12));
        d.setAuthTag(raw.subarray(raw.length - 16));
        return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]);
    };
    return {
        generateAndWrapDEK: jest.fn(async (plaintext, { aad = null } = {}) => {
            const dek = crypto.randomBytes(32);
            const iv = crypto.randomBytes(12);
            const c = crypto.createCipheriv('aes-256-gcm', dek, iv);
            if (aad) c.setAAD(aad);
            const encryptedKey = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]).toString('base64');
            return { encryptedKey, wrappedDek: wrap(dek), iv: iv.toString('base64'), authTag: c.getAuthTag().toString('base64'), ...(aad ? { version: 3 } : {}) };
        }),
        unwrapAndDecrypt: jest.fn(async (encryptedKey, wrappedDek, iv, authTag, { aad = null } = {}) => {
            const d = crypto.createDecipheriv('aes-256-gcm', unwrap(wrappedDek), Buffer.from(iv, 'base64'));
            if (aad) d.setAAD(aad);
            d.setAuthTag(Buffer.from(authTag, 'base64'));
            return Buffer.concat([d.update(Buffer.from(encryptedKey, 'base64')), d.final()]).toString('utf8');
        }),
    };
}

async function seedUsers(db, kms) {
    const legacyByok = await kms.generateAndWrapDEK('sk-legacy-1234567890abcd');
    const boundByok = await kms.generateAndWrapDEK('sk-bound-1234567890abcd', { aad: utils.keyBindingAad('d@example.com', 'byok') });
    db._seed('users/a@example.com', { notionKey: utils.encrypt('ntn_v2_token_a_1234567890', cryptoKey), tierCredits: 5 });
    db._seed('users/b@example.com', { notionKey: 'ntn_plaintext_token_b_12345' });
    db._seed('users/c@example.com', { notionKey: utils.encryptBound('ntn_v3_c_1234567890', cryptoKey, utils.keyBindingAad('c@example.com', 'notionKey')) });
    db._seed('users/d@example.com', { byokKmsData: { ...boundByok, provider: 'openai', modelName: 'gpt-4o' } });
    db._seed('users/e@example.com', { byokKmsData: { ...legacyByok, provider: 'anthropic', modelName: 'claude-x' } });
    db._seed('users/f@example.com', { notionKey: `${'0'.repeat(32)}:${'1'.repeat(32)}` });
    db._seed('users/g@example.com', { displayName: 'No keys' });
}

describe('migrate_key_binding script', () => {
    let db, kms, log;
    beforeEach(async () => {
        db = createFakeFirestore();
        kms = fakeKms();
        log = jest.fn();
        await seedUsers(db, kms);
        kms.generateAndWrapDEK.mockClear();
        kms.unwrapAndDecrypt.mockClear();
    });

    test('dry-run reports what would change and writes nothing', async () => {
        const before = JSON.stringify([...db._store.entries()]);
        const stats = await migrateKeyBinding({ db, cryptoKey, kms, log, pageSize: 3 });

        expect(stats).toEqual(expect.objectContaining({
            mode: 'dry-run',
            usersScanned: 7,
            usersToUpdate: 3,
            usersUpdated: 0,
            notionKeysRebound: 2,
            notionAlreadyBound: 1,
            notionUndecryptable: 1,
            byokRebound: 1,
            byokAlreadyBound: 1,
            byokFailed: 0,
        }));
        expect(JSON.stringify([...db._store.entries()])).toBe(before);
        expect(db._stats.writes).toBe(0);
        // Dry-run verifies decryptability but never wraps new keys.
        expect(kms.unwrapAndDecrypt).toHaveBeenCalledTimes(1);
        expect(kms.generateAndWrapDEK).not.toHaveBeenCalled();
        // Output never contains full addresses or secrets.
        const output = log.mock.calls.flat().join('\n');
        expect(output).not.toMatch(/a@example\.com|ntn_|sk-/);
        expect(output).toContain('a***@example.com');
    });

    test('apply re-encrypts every legacy key bound to its owner and leaves v3 data alone', async () => {
        const untouchedC = db._read('users/c@example.com');
        const untouchedD = db._read('users/d@example.com');
        const stats = await migrateKeyBinding({ db, apply: true, cryptoKey, kms, log, pageSize: 2 });

        expect(stats).toEqual(expect.objectContaining({ mode: 'apply', usersToUpdate: 3, usersUpdated: 3, notionKeysRebound: 2, byokRebound: 1, skippedConcurrentChange: 0 }));

        const a = db._read('users/a@example.com');
        expect(a.notionKey).toMatch(/^v3:/);
        expect(a.tierCredits).toBe(5);
        expect(utils.decryptBoundGcm(a.notionKey, cryptoKey, utils.keyBindingAad('a@example.com', 'notionKey'))).toBe('ntn_v2_token_a_1234567890');
        // Bound to a: copying it to b's document does not decrypt.
        expect(() => utils.decryptBoundGcm(a.notionKey, cryptoKey, utils.keyBindingAad('b@example.com', 'notionKey'))).toThrow();

        const b = db._read('users/b@example.com');
        expect(utils.decryptBoundGcm(b.notionKey, cryptoKey, utils.keyBindingAad('b@example.com', 'notionKey'))).toBe('ntn_plaintext_token_b_12345');

        const e = db._read('users/e@example.com').byokKmsData;
        expect(e).toEqual(expect.objectContaining({ version: 3, provider: 'anthropic', modelName: 'claude-x' }));
        await expect(kms.unwrapAndDecrypt(e.encryptedKey, e.wrappedDek, e.iv, e.authTag, { aad: utils.keyBindingAad('e@example.com', 'byok') }))
            .resolves.toBe('sk-legacy-1234567890abcd');
        await expect(kms.unwrapAndDecrypt(e.encryptedKey, e.wrappedDek, e.iv, e.authTag, { aad: utils.keyBindingAad('d@example.com', 'byok') }))
            .rejects.toThrow();

        expect(db._read('users/c@example.com')).toEqual(untouchedC);
        expect(db._read('users/d@example.com')).toEqual(untouchedD);
        expect(db._read('users/f@example.com').notionKey).toBe(`${'0'.repeat(32)}:${'1'.repeat(32)}`);
    });

    test('apply is idempotent: a second run changes nothing', async () => {
        await migrateKeyBinding({ db, apply: true, cryptoKey, kms, log });
        const writes = db._stats.writes;
        const second = await migrateKeyBinding({ db, apply: true, cryptoKey, kms, log });
        expect(second).toEqual(expect.objectContaining({ usersToUpdate: 0, usersUpdated: 0, notionAlreadyBound: 3, byokAlreadyBound: 2 }));
        expect(db._stats.writes).toBe(writes);
    });

    test('a key re-saved by the user during the run is not overwritten', async () => {
        const realTx = db.runTransaction;
        db.runTransaction = async (fn) => {
            db._seed('users/a@example.com', { notionKey: 'v3:freshly:saved:key' });
            db.runTransaction = realTx;
            return realTx(fn);
        };
        const stats = await migrateKeyBinding({ db, apply: true, cryptoKey, kms, log });
        expect(stats.skippedConcurrentChange).toBe(1);
        expect(db._read('users/a@example.com').notionKey).toBe('v3:freshly:saved:key');
    });

    test('a BYOK payload that cannot be unwrapped is counted and skipped', async () => {
        db._seed('users/h@example.com', { byokKmsData: { encryptedKey: 'x', wrappedDek: 'eA==', iv: 'eA==', authTag: 'eA==' } });
        const stats = await migrateKeyBinding({ db, apply: true, cryptoKey, kms, log });
        expect(stats.byokFailed).toBe(1);
        expect(db._read('users/h@example.com').byokKmsData.version).toBeUndefined();
    });
});

describe('migrate_key_binding arguments and project guard', () => {
    test('parses flags', () => {
        expect(parseArgs(['--project=p1', '--database=staging', '--apply', `--confirm=${CONFIRMATION}`]))
            .toEqual({ apply: true, confirm: 'BIND-KEYS-V3', project: 'p1', database: 'staging' });
        expect(parseArgs([])).toEqual({ apply: false, confirm: '', project: '', database: '' });
    });

    test('refuses without --project or --database, and --apply without the confirmation phrase', () => {
        expect(validateArgs({ apply: false, confirm: '', project: '', database: 'staging' })).toMatch(/--project/);
        expect(validateArgs({ apply: false, confirm: '', project: 'p1', database: '' })).toMatch(/--database/);
        expect(validateArgs({ apply: true, confirm: 'nope', project: 'p1', database: 'staging' })).toMatch(/--confirm=BIND-KEYS-V3/);
        expect(validateArgs({ apply: true, confirm: CONFIRMATION, project: 'p1', database: '(default)' })).toBeNull();
        expect(validateArgs({ apply: false, confirm: '', project: 'p1', database: 'staging' })).toBeNull();
    });

    test('project guard rejects a mismatch with the resolved or environment project', () => {
        expect(checkProjectGuard('p1', 'p1', '')).toBeNull();
        expect(checkProjectGuard('p1', 'p1', 'p1')).toBeNull();
        expect(checkProjectGuard('p1', 'p2', '')).toMatch(/Project mismatch/);
        expect(checkProjectGuard('p1', 'p1', 'ai-planner-project-467800')).toMatch(/Project mismatch/);
    });

    test('masks emails', () => {
        expect(maskEmail('alice@example.com')).toBe('a***@example.com');
        expect(maskEmail('nope')).toBe('***');
    });

    test('the CLI exits 2 before touching Firestore when the apply confirmation is missing', () => {
        const script = path.join(__dirname, '..', 'scripts', 'migrate_key_binding.js');
        const run = spawnSync(process.execPath, [script, '--project=ai-planner-project-467800', '--database=staging', '--apply'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
        expect(run.status).toBe(2);
        expect(run.stderr).toContain('--confirm=BIND-KEYS-V3');
        const noProject = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { PATH: process.env.PATH } });
        expect(noProject.status).toBe(2);
        const noDatabase = spawnSync(process.execPath, [script, '--project=ai-planner-project-467800'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
        expect(noDatabase.status).toBe(2);
        expect(noDatabase.stderr).toContain('--database');
        const noSecrets = spawnSync(process.execPath, [script, '--project=ai-planner-project-467800', '--database=staging'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
        expect(noSecrets.status).toBe(2);
        expect(noSecrets.stderr).toContain('NOTION_ENCRYPTION_KEY_V2');
    });
});

#!/usr/bin/env node

/**
 * Re-encrypt every stored key so it is bound to its owner (finding S-16):
 *  - users/{email}.notionKey (v2 GCM, legacy CBC or plaintext) → `v3:` AES-256-GCM
 *    with AAD `aiplanner:v3:<email>:notionKey`;
 *  - users/{email}.byokKmsData without `version: 3` → re-wrapped with AAD
 *    `aiplanner:v3:<email>:byok` and `version: 3`.
 * Requests also migrate lazily; this script finishes the job for idle users.
 *
 * Safe by default: dry-run unless --apply, and --apply needs the confirmation
 * phrase. The target project must be named and must match the project the
 * Admin SDK resolves (same guard as grant_credits.js). Secret values are never
 * printed. Needs NOTION_ENCRYPTION_KEY_V2 and KMS_KEY_NAME in the environment.
 *
 * The Firestore database must be named: --database=(default) is production,
 * --database=staging is staging (both in project ai-planner-project-467800).
 *
 * Dry-run (default; decrypts to verify, writes nothing):
 *   NOTION_ENCRYPTION_KEY_V2=... KMS_KEY_NAME=projects/.../cryptoKeys/... \
 *     node scripts/migrate_key_binding.js --project=ai-planner-project-467800 --database=staging
 *
 * Apply:
 *   ... node scripts/migrate_key_binding.js --project=ai-planner-project-467800 --database=staging --apply --confirm=BIND-KEYS-V3
 */

const {
    deriveKey,
    decryptStoredNotionKey,
    encryptBound,
    keyBindingAad,
    KEY_BINDING_VERSION,
} = require('../utils');

const CONFIRMATION = 'BIND-KEYS-V3';
const PAGE_SIZE = 200;

function argValue(args, name) {
    const prefix = `--${name}=`;
    const found = args.find((arg) => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : '';
}

function parseArgs(args) {
    return {
        apply: args.includes('--apply'),
        confirm: argValue(args, 'confirm'),
        project: argValue(args, 'project'),
        database: argValue(args, 'database').trim(),
    };
}

/** Returns an error message when the arguments must be refused, else null. */
function validateArgs({ apply, confirm, project, database }) {
    if (!project) return 'Refusing to run without --project=<firebase-project-id>.';
    if (!database) return 'Refusing to run without --database=<id> ("(default)" for production, "staging" for staging).';
    if (apply && confirm !== CONFIRMATION) return `Refusing to apply changes. Re-run with --confirm=${CONFIRMATION}`;
    return null;
}

/** Returns an error message when the resolved project differs from --project, else null. */
function checkProjectGuard(requestedProject, appProject, envProject) {
    if (appProject !== requestedProject || (envProject && envProject !== requestedProject)) {
        return `Project mismatch: --project=${requestedProject} but the environment resolves to ${envProject || appProject || 'nothing'}. Aborting.`;
    }
    return null;
}

/** a***@example.com — enough to follow progress without printing full addresses. */
function maskEmail(email) {
    const [local, domain] = String(email).split('@');
    return domain ? `${local.slice(0, 1)}***@${domain}` : '***';
}

function isBoundByok(kmsData) {
    return Number(kmsData?.version) === KEY_BINDING_VERSION;
}

/**
 * Compute the v3 replacements for one user document.
 * @returns {Promise<{ updates: object, notes: string[] }>}
 */
async function planUserMigration(email, data, { cryptoKey, kms, apply, stats }) {
    const updates = {};
    const notes = [];

    if (typeof data.notionKey === 'string' && data.notionKey) {
        if (data.notionKey.startsWith('v3:')) {
            stats.notionAlreadyBound += 1;
        } else {
            const { value } = decryptStoredNotionKey(data.notionKey, cryptoKey) || {};
            if (value) {
                updates.notionKey = encryptBound(value, cryptoKey, keyBindingAad(email, 'notionKey'));
                notes.push('notionKey');
            } else {
                stats.notionUndecryptable += 1;
                notes.push('notionKey UNDECRYPTABLE (skipped)');
            }
        }
    }

    const kmsData = data.byokKmsData;
    if (kmsData && typeof kmsData === 'object') {
        if (isBoundByok(kmsData)) {
            stats.byokAlreadyBound += 1;
        } else {
            try {
                const plaintext = await kms.unwrapAndDecrypt(kmsData.encryptedKey, kmsData.wrappedDek, kmsData.iv, kmsData.authTag);
                if (apply) {
                    const payload = await kms.generateAndWrapDEK(plaintext, { aad: keyBindingAad(email, 'byok') });
                    if (!payload?.encryptedKey || !payload?.wrappedDek || !payload?.iv || !payload?.authTag) {
                        throw new Error('KMS returned an incomplete payload');
                    }
                    updates.byokKmsData = { ...kmsData, ...payload, version: KEY_BINDING_VERSION };
                } else {
                    updates.byokKmsData = '(re-wrap on apply)';
                }
                notes.push('byokKmsData');
            } catch (err) {
                stats.byokFailed += 1;
                notes.push(`byokKmsData FAILED (${err?.message || 'error'})`);
            }
        }
    }
    return { updates, notes };
}

/**
 * Walk every user document and bind its stored keys to the owner.
 * In apply mode each user is written in a transaction that re-reads the
 * document and skips it when a key changed meanwhile (e.g. the user re-saved it).
 */
async function migrateKeyBinding({ db, apply = false, cryptoKey, kms, log = console.log, pageSize = PAGE_SIZE, orderField = '__name__' }) {
    const stats = {
        mode: apply ? 'apply' : 'dry-run',
        usersScanned: 0,
        usersToUpdate: 0,
        usersUpdated: 0,
        notionKeysRebound: 0,
        notionAlreadyBound: 0,
        notionUndecryptable: 0,
        byokRebound: 0,
        byokAlreadyBound: 0,
        byokFailed: 0,
        skippedConcurrentChange: 0,
    };

    let last = null;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        let query = db.collection('users').orderBy(orderField).limit(pageSize);
        if (last) query = query.startAfter(last);
        const page = await query.get();
        if (page.empty) break;

        for (const doc of page.docs) {
            stats.usersScanned += 1;
            const email = doc.id;
            const data = doc.data() || {};
            const { updates, notes } = await planUserMigration(email, data, { cryptoKey, kms, apply, stats });
            if (Object.keys(updates).length === 0) {
                if (notes.length) log(`SKIP ${maskEmail(email)}: ${notes.join(', ')}`);
                continue;
            }
            stats.usersToUpdate += 1;
            log(`${apply ? 'APPLY' : 'DRY-RUN'} ${maskEmail(email)}: ${notes.join(', ')}`);
            if (!apply) {
                if (updates.notionKey) stats.notionKeysRebound += 1;
                if (updates.byokKmsData) stats.byokRebound += 1;
                continue;
            }

            const written = await db.runTransaction(async (t) => {
                const fresh = await t.get(doc.ref);
                const current = fresh.exists ? (fresh.data() || {}) : null;
                if (!current) return false;
                if (updates.notionKey && current.notionKey !== data.notionKey) return false;
                if (updates.byokKmsData && (
                    current.byokKmsData?.encryptedKey !== data.byokKmsData?.encryptedKey
                    || current.byokKmsData?.wrappedDek !== data.byokKmsData?.wrappedDek
                )) return false;
                t.update(doc.ref, updates);
                return true;
            });
            if (written) {
                stats.usersUpdated += 1;
                if (updates.notionKey) stats.notionKeysRebound += 1;
                if (updates.byokKmsData) stats.byokRebound += 1;
            } else {
                stats.skippedConcurrentChange += 1;
                log(`SKIP ${maskEmail(email)}: changed during migration`);
            }
        }

        last = page.docs[page.docs.length - 1];
        if (page.docs.length < pageSize) break;
    }
    return stats;
}

async function main(argv = process.argv.slice(2), env = process.env) {
    const opts = parseArgs(argv);
    const argError = validateArgs(opts);
    if (argError) {
        console.error(argError);
        return 2;
    }
    if (!env.NOTION_ENCRYPTION_KEY_V2 || !env.KMS_KEY_NAME) {
        console.error('NOTION_ENCRYPTION_KEY_V2 and KMS_KEY_NAME must be set in the environment.');
        return 2;
    }

    const { initializeApp, getApp } = require('firebase-admin/app');
    const { FieldPath } = require('firebase-admin/firestore');
    const { firestoreFor } = require('../services/db');
    initializeApp({ projectId: opts.project });
    const envProject = env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || env.GCP_PROJECT || '';
    const appProject = getApp().options.projectId || '';
    console.log(`Target project: ${appProject || '(unknown)'}${envProject ? ` (environment: ${envProject})` : ''}`);
    console.log(`Firestore database: ${opts.database}`);
    console.log(`Mode: ${opts.apply ? 'APPLY' : 'dry-run'}`);
    const guardError = checkProjectGuard(opts.project, appProject, envProject);
    if (guardError) {
        console.error(guardError);
        return 2;
    }

    const stats = await migrateKeyBinding({
        db: firestoreFor(opts.database),
        apply: opts.apply,
        cryptoKey: deriveKey(env.NOTION_ENCRYPTION_KEY_V2),
        kms: require('../services/kms'),
        orderField: FieldPath.documentId(),
    });
    console.log('Done.', stats);
    return stats.byokFailed > 0 || stats.notionUndecryptable > 0 ? 1 : 0;
}

if (require.main === module) {
    main().then((code) => process.exit(code)).catch((err) => {
        console.error('Key binding migration failed:', err?.message || err);
        process.exit(1);
    });
}

module.exports = {
    CONFIRMATION,
    parseArgs,
    validateArgs,
    checkProjectGuard,
    maskEmail,
    planUserMigration,
    migrateKeyBinding,
    main,
};

#!/usr/bin/env node

/**
 * Security remediation migration helper.
 *
 * This script is intentionally safe by default:
 *   - no writes unless --apply is present;
 *   - --apply also requires --confirm=SECURITY-MIGRATION-2026-06-21;
 *   - it never prints secret values.
 *
 * Recommended first run:
 *   npm run migrate:security:dry-run
 */

const admin = require('firebase-admin');
const {
    deriveKey,
    encrypt,
    decryptCurrentGcm,
    decryptLegacyCbc,
    RATE_LIMIT_WINDOW_MS
} = require('../utils');
const { normalizePrice } = require('../services/cashfree');

const CONFIRMATION = 'SECURITY-MIGRATION-2026-06-21';
const PAGE_SIZE = 300;
const WRITE_BATCH_SIZE = 400;

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const confirmArg = args.find(arg => arg.startsWith('--confirm='));
const confirmValue = confirmArg ? confirmArg.slice('--confirm='.length) : '';

if (apply && confirmValue !== CONFIRMATION) {
    console.error(`Refusing to apply changes. Re-run with --confirm=${CONFIRMATION}`);
    process.exit(2);
}

admin.initializeApp();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const FieldPath = admin.firestore.FieldPath;

let batch = db.batch();
let batchCount = 0;
const stats = {
    mode: apply ? 'apply' : 'dry-run',
    usersScanned: 0,
    cashfreeOrdersScanned: 0,
    rateLimitDocsScanned: 0,
    writesQueued: 0,
    plaintextNotionKeysMigrated: 0,
    legacyNotionKeysMigrated: 0,
    corruptedNotionKeysFlagged: 0,
    legacyPlaintextByokFlagged: 0,
    customByokUrlsFlagged: 0,
    paymentDetailsMinimized: 0,
    paymentOrdersBackfilled: 0,
    rateLimitTtlBackfilled: 0
};

function safeFields(update) {
    return Object.keys(update).sort().join(', ');
}

async function commitIfNeeded(force = false) {
    if (!apply) return;
    if (batchCount === 0) return;
    if (!force && batchCount < WRITE_BATCH_SIZE) return;
    await batch.commit();
    batch = db.batch();
    batchCount = 0;
}

async function queueUpdate(ref, update, reason) {
    stats.writesQueued += 1;
    console.log(`${apply ? 'QUEUE' : 'DRY-RUN'} ${ref.path}: ${reason} [${safeFields(update)}]`);
    if (!apply) return;
    batch.update(ref, update);
    batchCount += 1;
    await commitIfNeeded();
}

function toMillis(value) {
    if (!value) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (value instanceof Date) return value.getTime();
    if (typeof value.toMillis === 'function') return value.toMillis();
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function distinctKeys(...keys) {
    const seen = new Set();
    return keys.filter((entry) => {
        if (!entry?.key) return false;
        const fingerprint = entry.key.toString('hex');
        if (seen.has(fingerprint)) return false;
        seen.add(fingerprint);
        return true;
    });
}

function decryptNotionForMigration(text, newKey, oldKey) {
    if (!text) return { value: null, needsMigration: false, corrupted: false };
    if (!text.includes(':')) return { value: text, needsMigration: true, corrupted: false };

    const keys = distinctKeys(
        { key: newKey, current: true },
        { key: oldKey, current: false }
    );

    if (text.startsWith('v2:')) {
        for (const entry of keys) {
            try {
                const value = decryptCurrentGcm(text, entry.key);
                if (value) return { value, needsMigration: !entry.current, corrupted: false };
            } catch (_) {
                // Try the next configured key before declaring it corrupted.
            }
        }
        return { value: null, needsMigration: false, corrupted: true };
    }

    for (const entry of keys) {
        try {
            const value = decryptLegacyCbc(text, entry.key);
            if (value) return { value, needsMigration: true, corrupted: false };
        } catch (_) {
            // Try the next configured key before declaring it corrupted.
        }
    }
    return { value: null, needsMigration: false, corrupted: true };
}

async function scanCollection(collectionName, handler) {
    let lastDoc = null;
    while (true) {
        let query = db.collection(collectionName)
            .orderBy(FieldPath.documentId())
            .limit(PAGE_SIZE);
        if (lastDoc) query = query.startAfter(lastDoc);

        const snap = await query.get();
        if (snap.empty) return;

        for (const doc of snap.docs) {
            await handler(doc);
        }

        lastDoc = snap.docs[snap.docs.length - 1];
        if (snap.size < PAGE_SIZE) return;
    }
}

async function migrateUsers() {
    const notionSecretNew = process.env.NOTION_ENCRYPTION_KEY_V2 || process.env.NOTION_ENCRYPTION_KEY;
    const notionSecretOld = process.env.NOTION_ENCRYPTION_KEY;
    const notionKeyNew = notionSecretNew ? deriveKey(notionSecretNew) : null;
    const notionKeyOld = notionSecretOld ? deriveKey(notionSecretOld) : null;

    await scanCollection('users', async (doc) => {
        stats.usersScanned += 1;
        const data = doc.data() || {};
        const update = {};
        const reasons = [];

        if (typeof data.notionKey === 'string' && data.notionKey && data.notionKey !== 'YOUR_NOTION_KEY') {
            if (!notionKeyNew) {
                if (!data.notionKey.startsWith('v2:')) {
                    console.log(`REVIEW ${doc.ref.path}: Notion key needs encryption migration, but NOTION_ENCRYPTION_KEY_V2/NOTION_ENCRYPTION_KEY is not set`);
                }
            } else {
                const result = decryptNotionForMigration(data.notionKey, notionKeyNew, notionKeyOld);
                if (result?.value && result.needsMigration) {
                    update.notionKey = encrypt(result.value, notionKeyNew);
                    if (data.notionKey.includes(':')) {
                        stats.legacyNotionKeysMigrated += 1;
                        reasons.push('migrate legacy Notion encryption to AES-GCM');
                    } else {
                        stats.plaintextNotionKeysMigrated += 1;
                        reasons.push('encrypt plaintext Notion key');
                    }
                } else if (result?.corrupted) {
                    update.notionKeyNeedsReset = true;
                    update.securityReviewAt = FieldValue.serverTimestamp();
                    stats.corruptedNotionKeysFlagged += 1;
                    reasons.push('flag corrupted Notion key for user reset');
                }
            }
        }

        if (data.byokConfig?.apiKey || data.geminiKey) {
            update.legacyPlaintextByokNeedsReset = true;
            update.securityReviewAt = FieldValue.serverTimestamp();
            stats.legacyPlaintextByokFlagged += 1;
            reasons.push('flag legacy plaintext BYOK credential for reset');
        }

        if (data.byokKmsData?.baseUrl) {
            update.customByokUrlNeedsReview = true;
            update.securityReviewAt = FieldValue.serverTimestamp();
            stats.customByokUrlsFlagged += 1;
            reasons.push('flag custom BYOK URL for allowlist review');
        }

        if (Object.keys(update).length > 0) {
            await queueUpdate(doc.ref, update, reasons.join('; '));
        }
    });
}

function extractPaymentSummary(paymentDetails = {}) {
    const payment = paymentDetails.payment || paymentDetails.data?.payment || paymentDetails;
    return {
        cashfreePaymentId: payment.cf_payment_id || payment.payment_id,
        paymentStatus: payment.payment_status,
        paymentAmount: payment.payment_amount,
        paymentCurrency: payment.payment_currency,
        paymentTime: payment.payment_time
    };
}

async function migrateCashfreeOrders() {
    await scanCollection('cashfree_orders', async (doc) => {
        stats.cashfreeOrdersScanned += 1;
        const data = doc.data() || {};
        const update = {};
        const reasons = [];
        const price = normalizePrice(data.price);

        if (price !== null && data.price !== price) {
            update.price = price;
            reasons.push('normalize allowlisted price');
        }
        if (price !== null && data.amountPaise !== price * 100) {
            update.amountPaise = price * 100;
            reasons.push('backfill amountPaise');
        }
        if (!data.currency && price !== null) {
            update.currency = 'INR';
            reasons.push('backfill currency');
        }

        if (data.paymentDetails && typeof data.paymentDetails === 'object') {
            const summary = extractPaymentSummary(data.paymentDetails);
            for (const [key, value] of Object.entries(summary)) {
                if (value !== undefined && data[key] === undefined) update[key] = value;
            }
            update.paymentDetails = FieldValue.delete();
            stats.paymentDetailsMinimized += 1;
            reasons.push('replace verbose paymentDetails with minimal summary');
        }

        if (Object.keys(update).length > 0) {
            stats.paymentOrdersBackfilled += 1;
            update.updatedAt = FieldValue.serverTimestamp();
            await queueUpdate(doc.ref, update, reasons.join('; '));
        }
    });
}

async function migrateRateLimits() {
    await scanCollection('rateLimits', async (doc) => {
        stats.rateLimitDocsScanned += 1;
        const data = doc.data() || {};
        if (data.expiresAt) return;

        const windowStart = toMillis(data.windowStart) || Date.now();
        const expiresAt = new Date(windowStart + RATE_LIMIT_WINDOW_MS * 2);
        stats.rateLimitTtlBackfilled += 1;
        await queueUpdate(doc.ref, { expiresAt }, 'backfill Firestore TTL expiresAt');
    });
}

async function main() {
    console.log(`Security migration starting in ${stats.mode} mode.`);
    if (!apply) {
        console.log('No writes will be made. Use --apply with the confirmation string only after reviewing this output.');
    }

    await migrateUsers();
    await migrateCashfreeOrders();
    await migrateRateLimits();
    await commitIfNeeded(true);

    console.log('Security migration summary:');
    console.log(JSON.stringify(stats, null, 2));
}

main().catch((err) => {
    console.error('Security migration failed:', err && err.message ? err.message : err);
    process.exit(1);
});

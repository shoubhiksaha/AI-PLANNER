#!/usr/bin/env node
/**
 * AI Planner — Staging Database Reset Utility
 * Deletes all documents (including subcollections) from the Firestore database
 * "staging" in ai-planner-project-467800, for QA isolation. The production database
 * "(default)" is never touched: the database id is hard-coded below.
 *
 * Usage:
 *   node scripts/reset-staging.js --confirm=RESET-STAGING-DATA
 */

const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const PROJECT_ID = 'ai-planner-project-467800';
const STAGING_DATABASE = 'staging';
const confirmArg = process.argv.find(arg => arg.startsWith('--confirm='))?.split('=')[1];

if (confirmArg !== 'RESET-STAGING-DATA') {
    console.error('❌ Safety check failed: Must pass --confirm=RESET-STAGING-DATA');
    process.exit(1);
}

console.log(`⚠️  Resetting ${PROJECT_ID} / database "${STAGING_DATABASE}"`);

initializeApp({ projectId: process.env.FIRESTORE_EMULATOR_HOST ? (process.env.GCLOUD_PROJECT || PROJECT_ID) : PROJECT_ID });

const db = getFirestore(STAGING_DATABASE);
if (db.databaseId !== STAGING_DATABASE) {
    console.error('❌ SAFETY BLOCK: refusing to reset anything but the staging database.');
    process.exit(1);
}

// recursiveDelete removes each document and all of its subcollections (e.g. users/*/syncHistory).
async function deleteCollection(collectionPath) {
    const ref = db.collection(collectionPath);
    const before = (await ref.count().get()).data().count;
    await db.recursiveDelete(ref);
    console.log(`  • ${collectionPath}: deleted ${before} document(s) and their subcollections`);
}

async function reset() {
    const collections = await db.listCollections();
    if (collections.length === 0) {
        console.log('  (database is already empty)');
    }
    for (const col of collections) {
        await deleteCollection(col.id);
    }
    console.log('\n✅ Staging database reset complete.');
}

reset().catch(err => {
    console.error('Failed to reset staging database:', err);
    process.exit(1);
});

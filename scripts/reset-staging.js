#!/usr/bin/env node
/**
 * AI Planner — Staging Database Reset Utility
 * Clears collections in the staging project for QA test isolation.
 *
 * Usage:
 *   node scripts/reset-staging.js --confirm=RESET-STAGING-DATA
 */

const admin = require('firebase-admin');

const targetProject = 'ai-planner-staging';
const confirmArg = process.argv.find(arg => arg.startsWith('--confirm='))?.split('=')[1];

if (confirmArg !== 'RESET-STAGING-DATA') {
    console.error("❌ Safety check failed: Must pass --confirm=RESET-STAGING-DATA");
    process.exit(1);
}

console.log(`⚠️  Resetting staging database: ${targetProject}`);

admin.initializeApp({
    projectId: targetProject
});

const db = admin.firestore();

async function deleteCollection(collectionPath, batchSize = 100) {
    const collectionRef = db.collection(collectionPath);
    const query = collectionRef.limit(batchSize);

    return new Promise((resolve, reject) => {
        deleteQueryBatch(query, resolve, reject);
    });
}

async function deleteQueryBatch(query, resolve, reject) {
    const snapshot = await query.get();

    const batchSize = snapshot.size;
    if (batchSize === 0) {
        resolve();
        return;
    }

    const batch = db.batch();
    snapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
    });
    await batch.commit();

    process.nextTick(() => {
        deleteQueryBatch(query, resolve, reject);
    });
}

async function reset() {
    console.log("  • Deleting rateLimits collection...");
    await deleteCollection('rateLimits');

    console.log("  • Deleting syncErrors collection...");
    await deleteCollection('syncErrors');

    console.log("  • Deleting users collection...");
    await deleteCollection('users');

    console.log("\n✅ Staging database reset complete.");
}

reset().catch(err => {
    console.error("Failed to reset staging database:", err);
    process.exit(1);
});

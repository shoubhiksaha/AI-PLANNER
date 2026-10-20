#!/usr/bin/env node
/**
 * AI Planner — Staging Synthetic Data Seeder
 * Populates the staging Firestore database with isolated mock users and sync history.
 * The schema matches the gamification defaults written by functions/index.js.
 *
 * Usage (from the repo root, with credentials for ai-planner-project-467800):
 *   node scripts/seed-staging.js
 *
 * Staging is the Firestore database "staging" inside ai-planner-project-467800.
 * This script only ever writes to that database, never to "(default)" (production).
 */

const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const PROJECT_ID = 'ai-planner-project-467800';
const STAGING_DATABASE = 'staging';
const requestedDb = process.argv.find(arg => arg.startsWith('--database='))?.split('=')[1];

if (requestedDb && requestedDb !== STAGING_DATABASE) {
    console.error(`❌ SAFETY BLOCK: this script only seeds the "${STAGING_DATABASE}" database (got --database=${requestedDb}).`);
    process.exit(1);
}

console.log(`🌱 Seeding synthetic test data into ${PROJECT_ID} / database "${STAGING_DATABASE}"`);

initializeApp({ projectId: process.env.FIRESTORE_EMULATOR_HOST ? (process.env.GCLOUD_PROJECT || PROJECT_ID) : PROJECT_ID });

const db = getFirestore(STAGING_DATABASE);

function todayIn(timeZone) {
    return new Date().toLocaleDateString('en-CA', { timeZone });
}

async function seed() {
    const timeZone = 'Asia/Kolkata';
    const testUsers = [
        {
            email: 'staging-tester-free@aiplanner.local',
            tier: 'free',
            tierCredits: 15,
            boosterCredits: 0,
            currentStreak: 3,
            highestStreak: 5,
        },
        {
            email: 'staging-tester-pro@aiplanner.local',
            tier: 'pro',
            tierCredits: 250,
            boosterCredits: 10,
            currentStreak: 12,
            highestStreak: 20,
        }
    ];

    for (const user of testUsers) {
        const { email, ...fields } = user;
        const userRef = db.collection('users').doc(email);
        await userRef.set({
            ...fields,
            streakFreezes: 0,
            dailySyncCount: 0,
            lastAwardedStreak: 0,
            lastSyncDate: todayIn(timeZone),
            subscriptionRenewalDate: null,
            timeZone,
            displayName: email.split('@')[0],
            createdAt: FieldValue.serverTimestamp()
        }, { merge: true });
        console.log(`  ✓ Seeded mock user: ${email} (tier: ${fields.tier}, credits: ${fields.tierCredits})`);

        await userRef.collection('syncHistory').doc('mock-sync-001').set({
            timestamp: FieldValue.serverTimestamp(),
            syncType: 'morning',
            status: 'success',
            imageCount: 1,
            eventsCreated: 3,
            tasksCreated: 4
        });
        console.log(`    ✓ Seeded sample sync history for ${email}`);
    }

    console.log('\n✅ Staging Firestore seeding complete!');
}

seed().catch(err => {
    console.error('Failed to seed staging database:', err);
    process.exit(1);
});

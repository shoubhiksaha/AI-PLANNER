#!/usr/bin/env node
/**
 * AI Planner — Staging Synthetic Data Seeder
 * Populates staging Firestore with isolated mock users, sync histories, and test streak states.
 * 
 * Usage:
 *   node scripts/seed-staging.js [--project=ai-planner-staging]
 */

const admin = require('firebase-admin');

const targetProject = process.argv.find(arg => arg.startsWith('--project='))?.split('=')[1] || 'ai-planner-staging';

if (targetProject === 'ai-planner-project-467800') {
    console.error("❌ SAFETY BLOCK: Refusing to run seed script against production (ai-planner-project-467800)!");
    process.exit(1);
}

console.log(`🌱 Seeding synthetic test data into Firestore project: ${targetProject}`);

admin.initializeApp({
    projectId: targetProject
});

const db = admin.firestore();

async function seed() {
    const testUsers = [
        {
            email: 'staging-tester-free@aiplanner.local',
            tier: 'free',
            credits: 25,
            currentStreak: 3,
            longestStreak: 5,
            lastSyncDate: new Date().toISOString().split('T')[0],
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        },
        {
            email: 'staging-tester-pro@aiplanner.local',
            tier: 'pro',
            credits: 100,
            currentStreak: 12,
            longestStreak: 20,
            lastSyncDate: new Date().toISOString().split('T')[0],
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        }
    ];

    for (const user of testUsers) {
        const userRef = db.collection('users').doc(user.email);
        await userRef.set(user, { merge: true });
        console.log(`  ✓ Seeded mock user: ${user.email} (tier: ${user.tier}, credits: ${user.credits})`);

        // Add sample sync history item
        const historyRef = userRef.collection('syncHistory').doc('mock-sync-001');
        await historyRef.set({
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            syncType: 'morning',
            status: 'success',
            eventsCreated: 3,
            tasksCreated: 4,
            streakIncremented: true
        });
        console.log(`    ✓ Seeded sample sync history for ${user.email}`);
    }

    console.log(`\n✅ Staging Firestore seeding complete!`);
}

seed().catch(err => {
    console.error("Failed to seed staging database:", err);
    process.exit(1);
});

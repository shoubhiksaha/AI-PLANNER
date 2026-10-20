#!/usr/bin/env node

/**
 * Grant booster credits to every user document in Firestore, once per grant id.
 *
 * The target project must be named explicitly and must match the project the
 * Admin SDK resolves from the environment (GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT
 * or the service-account credentials), so a stray shell can never hit production.
 *
 * The Firestore database must be named too: --database=(default) is production,
 * --database=staging is staging (both in project ai-planner-project-467800).
 *
 * Dry-run (default):
 *   node scripts/grant_credits.js --project=ai-planner-project-467800 --database=staging --amount=25 --grant-id=launch-2026-10
 *
 * Apply:
 *   node scripts/grant_credits.js --project=ai-planner-project-467800 --database=staging --amount=25 --grant-id=launch-2026-10 \
 *     --apply --confirm=GRANT-CREDITS-25
 */

const { initializeApp, getApp } = require('firebase-admin/app');
const { firestoreFor } = require('../services/db');
const { grantBoosterCreditsToAllUsers, isValidGrantId } = require('../services/creditGrant');

function argValue(args, name) {
    const prefix = `--${name}=`;
    const found = args.find((arg) => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : '';
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const amount = Number(argValue(args, 'amount') || 25);
const confirmValue = argValue(args, 'confirm');
const grantId = argValue(args, 'grant-id');
const requestedProject = argValue(args, 'project');
const databaseId = argValue(args, 'database').trim();
const expectedConfirmation = `GRANT-CREDITS-${amount}`;

if (!Number.isInteger(amount) || amount <= 0 || amount > 500) {
    console.error('Invalid --amount. Provide a positive integer up to 500.');
    process.exit(2);
}

if (!isValidGrantId(grantId)) {
    console.error('Missing or invalid --grant-id (6-64 chars: letters, digits, "_" or "-"). Re-using the same id never double-grants.');
    process.exit(2);
}

if (!requestedProject) {
    console.error('Refusing to run without --project=<firebase-project-id>.');
    process.exit(2);
}

if (!databaseId) {
    console.error('Refusing to run without --database=<id> ("(default)" for production, "staging" for staging).');
    process.exit(2);
}

if (apply && confirmValue !== expectedConfirmation) {
    console.error(`Refusing to apply changes. Re-run with --confirm=${expectedConfirmation}`);
    process.exit(2);
}

initializeApp({ projectId: requestedProject });
const envProject = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || '';
const appProject = getApp().options.projectId || '';

console.log(`Target project: ${appProject || '(unknown)'}${envProject ? ` (environment: ${envProject})` : ''}`);
console.log(`Mode: ${apply ? 'APPLY' : 'dry-run'} · amount: ${amount} · grant id: ${grantId}`);

if (appProject !== requestedProject || (envProject && envProject !== requestedProject)) {
    console.error(`Project mismatch: --project=${requestedProject} but the environment resolves to ${envProject || appProject || 'nothing'}. Aborting.`);
    process.exit(2);
}

console.log(`Firestore database: ${databaseId}`);
const db = firestoreFor(databaseId);

async function main() {
    const stats = await grantBoosterCreditsToAllUsers(db, amount, { dryRun: !apply, grantId });
    console.log('Done.', stats);
}

main().catch((err) => {
    console.error('Grant credits failed:', err.message || err);
    process.exit(1);
});

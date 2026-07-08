#!/usr/bin/env node

/**
 * Grant booster credits to every user document in Firestore.
 *
 * Dry-run (default):
 *   node scripts/grant_credits.js --amount=25
 *
 * Apply:
 *   node scripts/grant_credits.js --amount=25 --apply --confirm=GRANT-CREDITS-25
 */

const admin = require('firebase-admin');
const { grantBoosterCreditsToAllUsers } = require('../services/creditGrant');

const CONFIRMATION = 'GRANT-CREDITS-25';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const amountArg = args.find((arg) => arg.startsWith('--amount='));
const amount = Number(amountArg ? amountArg.slice('--amount='.length) : 25);
const confirmArg = args.find((arg) => arg.startsWith('--confirm='));
const confirmValue = confirmArg ? confirmArg.slice('--confirm='.length) : '';

if (!Number.isInteger(amount) || amount <= 0) {
    console.error('Invalid --amount. Provide a positive integer.');
    process.exit(2);
}

if (apply && confirmValue !== CONFIRMATION) {
    console.error(`Refusing to apply changes. Re-run with --confirm=${CONFIRMATION}`);
    process.exit(2);
}

admin.initializeApp();
const db = admin.firestore();

async function main() {
    const stats = await grantBoosterCreditsToAllUsers(db, amount, { dryRun: !apply });
    console.log('Done.', stats);
}

main().catch((err) => {
    console.error('Grant credits failed:', err);
    process.exit(1);
});

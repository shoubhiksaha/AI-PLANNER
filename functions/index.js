/**
 * Cloud Functions entry point. Each export is a thin wrapper that pins the
 * runtime options (memory, timeout, secrets); the handlers live in handlers/
 * and sync/. Export names are the deployed function names: never rename them.
 */
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2/options");
const { initializeApp, getApps } = require("firebase-admin/app");

// Initialize Firebase Admin (modular API; firebase-admin 14 has no namespaced
// admin.firestore()/admin.auth()) with the project-scoped default storage bucket.
const activeProjectId = process.env.GCLOUD_PROJECT || 'ai-planner-project-467800';
if (!getApps().length) {
    initializeApp({
        storageBucket: `${activeProjectId}.firebasestorage.app`
    });
}

const { NOTION_ENCRYPTION_KEY_V2, CREDITS_GRANT_TOKEN, FUNCTIONS_REGION } = require('./params');

// Round 3: the same code deploys to us-central1 (production) and asia-south1
// (staging) of one project; FUNCTIONS_REGION comes from functions/.env.<alias>.
// Must run before any function is defined.
setGlobalOptions({ region: FUNCTIONS_REGION });
const { GEMINI_API_KEY } = require('./services/gemini');
const { CASHFREE_APP_ID, CASHFREE_SECRET_KEY } = require('./services/cashfree');
const { calendarDayDiff } = require('./utils');
const { updateProfileHandler, refreshStaleStreakHandler } = require('./handlers/profile');
const { setupNotionHandler, setupBYOKHandler, byokSessionHandler } = require('./handlers/setup');
const { exportUserDataHandler, deleteUserAccountHandler } = require('./handlers/account');
const { logClientErrorHandler } = require('./handlers/clientErrors');
const {
    createCashfreeOrderHandler,
    cashfreeWebhookHandler,
    computePurchaseGrant,
    computeEntitlementRevocation,
} = require('./handlers/payments');
const { adminGrantCreditsHandler } = require('./handlers/admin');
const { syncPlannerHandler } = require('./sync/handler');
const { SYNC_TIMEOUT_SECONDS } = require('./sync/credits');
const {
    checkFeaturesAndCredits,
    needsTierCreditRenewal,
    buildNewUserDoc,
} = require('./sync/userPlan');
const { applyGamificationMilestones, runGamificationAfterSync } = require('./sync/gamification');
const { reconcileStuckSyncs } = require('./sync/reconcile');

// --- ENDPOINT: updateProfile ---
// Moves frontend Firestore writes behind secure admin privileges. Creates the
// user document with full Free-tier defaults (15 credits) when it is missing.
exports.updateProfile = onRequest({ cors: false, memory: "256MiB", maxInstances: 20 }, updateProfileHandler);

// --- ENDPOINT: refreshStaleStreak ---
// Persists a lapsed streak (0) when the user opens the app without syncing.
exports.refreshStaleStreak = onRequest({ cors: false, memory: "256MiB", maxInstances: 20 }, refreshStaleStreakHandler);

// --- SETUP ENDPOINT: setupNotion ---
exports.setupNotion = onRequest({
    cors: false,
    memory: "256MiB",
    maxInstances: 20,
    secrets: [NOTION_ENCRYPTION_KEY_V2]
}, setupNotionHandler);

// --- SETUP ENDPOINT: setupBYOK ---
exports.setupBYOK = onRequest({ cors: false, memory: "256MiB", maxInstances: 20 }, setupBYOKHandler);

// --- ENDPOINT: byokSession (stateless BYOK validation; sets no cookies) ---
exports.byokSession = onRequest({ cors: false, memory: "256MiB", maxInstances: 20 }, byokSessionHandler);

// --- GDPR: Export User Data ---
exports.exportUserData = onRequest({ cors: false, memory: "512MiB", maxInstances: 10 }, exportUserDataHandler);

// --- GDPR: Delete User Account ---
exports.deleteUserAccount = onRequest({ cors: false, memory: "512MiB", maxInstances: 10 }, deleteUserAccountHandler);

// --- MAIN ENDPOINT: syncPlanner ---
// concurrency 4 at 1 GiB: a request can hold ~28 MB raw body + parsed JSON +
// decoded buffers + the outbound AI payload (~120 MB peak); 4 in flight plus the
// runtime stays well under 1 GiB, where 10 risked OOM kills (which skip refunds).
exports.syncPlanner = onRequest({
    cors: false,
    memory: "1GiB",
    timeoutSeconds: SYNC_TIMEOUT_SECONDS,
    maxInstances: 20,
    concurrency: 4,
    secrets: [NOTION_ENCRYPTION_KEY_V2, GEMINI_API_KEY]
}, syncPlannerHandler);

// --- GCP Error Reporting: Frontend Ingestion Endpoint ---
exports.logClientError = onRequest({ cors: false, memory: "128MiB", maxInstances: 10 }, logClientErrorHandler);

// --- CASHFREE PAYMENT INTEGRATION ---
exports.createCashfreeOrder = onRequest({
    cors: false,
    memory: "256MiB",
    maxInstances: 10,
    secrets: [CASHFREE_APP_ID, CASHFREE_SECRET_KEY]
}, createCashfreeOrderHandler);

// Server-to-server: never behind App Check.
exports.cashfreeWebhook = onRequest({
    cors: false,
    memory: "256MiB",
    maxInstances: 10,
    secrets: [CASHFREE_APP_ID, CASHFREE_SECRET_KEY]
}, cashfreeWebhookHandler);

// --- ADMIN: one-off booster credit grant (server-to-server only) ---
exports.adminGrantCredits = onRequest({
    memory: "512MiB",
    timeoutSeconds: 540,
    maxInstances: 1,
    secrets: [CREDITS_GRANT_TOKEN]
}, adminGrantCreditsHandler);

// --- SCHEDULED: refund syncs interrupted after their credit was deducted (C11) ---
// Region from setGlobalOptions; reads only this environment's database.
exports.reconcileStuckSyncs = onSchedule({
    schedule: 'every 15 minutes',
    memory: '256MiB',
    timeoutSeconds: 300,
    maxInstances: 1,
}, async () => {
    await reconcileStuckSyncs();
});

if (process.env.NODE_ENV === 'test') {
    exports.applyGamificationMilestones = applyGamificationMilestones;
    exports.runGamificationAfterSync = runGamificationAfterSync;
    exports.needsTierCreditRenewal = needsTierCreditRenewal;
    exports.calendarDayDiff = calendarDayDiff;
    exports.checkFeaturesAndCredits = checkFeaturesAndCredits;
    exports.computePurchaseGrant = computePurchaseGrant;
    exports.computeEntitlementRevocation = computeEntitlementRevocation;
    exports.buildNewUserDoc = buildNewUserDoc;
}

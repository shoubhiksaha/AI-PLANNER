/**
 * Deploy-time parameters and secrets shared by the HTTP handlers.
 * Declared once here so every module reads the same parameter objects.
 */
const { defineSecret, defineString } = require('firebase-functions/params');

const NOTION_ENCRYPTION_KEY_V2 = defineSecret('NOTION_ENCRYPTION_KEY_V2');
const ALLOW_CUSTOM_BYOK_URLS = defineString('ALLOW_CUSTOM_BYOK_URLS', { default: 'false' });
const CREDITS_GRANT_TOKEN = defineSecret('CREDITS_GRANT_TOKEN');
// Declared so the deploy-time parameter keeps existing; read through process.env.
defineString('APP_HOSTING_URL', { default: '' });

// Round 3: one Firebase project, two environments. Set per environment in
// functions/.env.<alias> (production / staging; the emulator uses 'emulator').
const APP_ENVIRONMENT = defineString('APP_ENVIRONMENT', { default: 'production' });
const FIRESTORE_DATABASE_ID = defineString('FIRESTORE_DATABASE_ID', { default: '(default)' });
const FUNCTIONS_REGION = defineString('FUNCTIONS_REGION', { default: 'us-central1' });

const APP_ENVIRONMENTS = new Set(['production', 'staging', 'emulator']);
const DEFAULT_DATABASE_ID = '(default)';

/**
 * 'production' | 'staging' | 'emulator'. A missing, empty or unknown value is
 * treated as production, the strictest environment. (At runtime a param reads
 * process.env, where an unset value is the empty string.)
 */
function appEnvironment() {
    const value = String(APP_ENVIRONMENT.value() || '').trim().toLowerCase();
    return APP_ENVIRONMENTS.has(value) ? value : 'production';
}

/** Firestore database id of this environment ('(default)' when unset). */
function firestoreDatabaseId() {
    const value = String(FIRESTORE_DATABASE_ID.value() || '').trim();
    return value || DEFAULT_DATABASE_ID;
}

function customBYOKUrlsEnabled() {
    return String(ALLOW_CUSTOM_BYOK_URLS.value()).toLowerCase() === 'true';
}

module.exports = {
    APP_ENVIRONMENT,
    FIRESTORE_DATABASE_ID,
    FUNCTIONS_REGION,
    DEFAULT_DATABASE_ID,
    appEnvironment,
    firestoreDatabaseId,
    NOTION_ENCRYPTION_KEY_V2,
    ALLOW_CUSTOM_BYOK_URLS,
    CREDITS_GRANT_TOKEN,
    customBYOKUrlsEnabled,
};

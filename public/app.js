// AI Planner — Main Application Module
// Extracted from inline <script type="module"> for CSP compliance

import { computeDisplayStreak, normalizeSyncDateStr } from './streak-utils.js';

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-app.js";
import {
    getAuth,
    initializeAuth,
    inMemoryPersistence,
    GoogleAuthProvider,
    signInWithCredential,
    signInWithPopup,
    signInWithRedirect,
    getRedirectResult,
    reauthenticateWithPopup,
    reauthenticateWithCredential,
    connectAuthEmulator,
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
} from "https://www.gstatic.com/firebasejs/11.1.0/firebase-auth.js";

const helpers = window.AppHelpers;
if (!helpers) {
    throw new Error("AppHelpers not loaded. Ensure app-helpers.js is included before app.js.");
}

// FIREBASE CONFIG (Loaded from window.__ENV_CONFIG__)
const runtimeConfig = (typeof window !== 'undefined' && window.__ENV_CONFIG__) ? window.__ENV_CONFIG__ : null;
if (!runtimeConfig || !runtimeConfig.projectId) {
    console.error("FATAL: window.__ENV_CONFIG__ is missing or invalid. Ensure env-config.js is loaded.");
    throw new Error("Missing or invalid runtime environment configuration.");
}

// C10: emulator mode only on localhost/127.0.0.1 with ?emulator=true or environment 'emulator'.
// It forces a demo- project id so nothing can touch a real Firebase project.
const EMULATOR_MODE = helpers.isEmulatorMode(window.location, runtimeConfig);
const firebaseConfig = EMULATOR_MODE ? helpers.emulatorFirebaseConfig(runtimeConfig) : runtimeConfig;
if (EMULATOR_MODE) window.__ENV_CONFIG__ = firebaseConfig; // getApiUrls reads projectId from here

const app = initializeApp(firebaseConfig);
const isNativeWebView = !!window.ReactNativeWebView;

const auth = isNativeWebView
    ? initializeAuth(app, { persistence: inMemoryPersistence })
    : getAuth(app);
if (EMULATOR_MODE) connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });

const {
    parseJsonResponse,
    readApiError,
    showActionableError,
    getApiUrls,
    switchView: switchViewHelper,
    applyTheme: applyThemeHelper,
    describeApiError,
    creditNoteForError,
    creditNoteForSuccess,
    summarizeCounts,
    SYNC_MODES,
    normalizeSyncMode,
    maxUploadForTier,
    pageLimitFor,
    needsGoogleToken,
    needsNotion,
    resolveNotesDestination,
    friendlySyncDate,
    DESTINATION_LABELS,
    readByokSession,
    writeByokSession,
    clearByokSession,
    buildByokHeaders,
    generateClientRequestId,
    isTokenFresh,
    extractNotionId,
    validateNotionKey,
    isHeicFile,
    isAcceptedImage,
    heicMimeFor,
    toHeicDataUrl,
    isHeicDataUrl,
    imagesPayloadChars,
    heicTooLargeMessage,
    MAX_IMAGE_BYTES,
    MAX_IMAGES_PAYLOAD_CHARS,
    describeHistoryEntry,
    createFunctionsFetch,
    firestoreDatabaseIdFrom,
    appCheckSiteKeyFrom,
    shouldUseAppCheckDebugToken,
    E2E_GOOGLE_TOKEN,
    buildHeatmapDays,
    loadScriptOnce,
    activateDialog,
} = helpers;

const $ = (id) => document.getElementById(id);

/** Inline icon from the sprite in index.html (Lucide). `name` is always a constant. */
const icon = (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;

// --------------------------------------------------------------------------
// STATE
// --------------------------------------------------------------------------
let currentUser = null;
let filesAsBase64 = [];            // compressed page images (data URLs)
let googleAccessToken = null;      // in memory only, never persisted
let googleTokenExpiresAt = 0;
let profileUnsubscribe = null;
let userProfile = null;
let isSyncing = false;             // B-16 global guard
let isPaying = false;
let isRecording = false;
let lastAttempt = null;            // { id, mode, sig } — reuse clientRequestId for retries of the same pages
let lastVoicePayload = null;       // audio kept for Retry after a failed voice sync
let pendingPayment = null;         // { kind, before, timer }

const GOOGLE_TOKEN_DEFAULT_TTL_S = 55 * 60;
const CASHFREE_SDK_SRC = 'https://sdk.cashfree.com/js/v3/cashfree.js';
const MAX_RECORDING_MS = 5 * 60 * 1000;
const MIN_RECORDING_MS = 1000;
const FIRESTORE_SDK = "https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js";

const setGoogleToken = (token, expiresInSeconds) => {
    googleAccessToken = token || null;
    const ttl = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds : GOOGLE_TOKEN_DEFAULT_TTL_S;
    googleTokenExpiresAt = token ? Date.now() + ttl * 1000 : 0;
};

// Lets sw-register.js hold back its "Update available" banner while work is in flight (B-18).
const setBusy = () => {
    const busy = isSyncing || isPaying || isRecording;
    document.documentElement.dataset.busy = busy ? 'true' : 'false';
    if (!busy) window.dispatchEvent(new Event('ai-planner:idle'));
};

let firestorePromise = null;
const loadFirestore = () => {
    if (!firestorePromise) {
        firestorePromise = import(FIRESTORE_SDK).catch((err) => {
            firestorePromise = null;
            throw err;
        });
    }
    return firestorePromise;
};

/** Firestore module + the app's single db instance (wired to the emulator in C10 mode). */
let firestoreDb = null;
const loadDb = async () => {
    const mod = await loadFirestore();
    if (!firestoreDb) {
        // WebKit's streaming transport stalls against the plain-HTTP local emulator;
        // long-polling keeps the Safari/WebKit e2e runs meaningful. Production is unchanged.
        // Round 3: production (default) and staging live in one project, separate databases.
        const databaseId = firestoreDatabaseIdFrom(firebaseConfig);
        firestoreDb = EMULATOR_MODE
            ? mod.initializeFirestore(app, { experimentalForceLongPolling: true }, databaseId)
            : mod.getFirestore(app, databaseId);
        if (EMULATOR_MODE) mod.connectFirestoreEmulator(firestoreDb, '127.0.0.1', 8080);
    }
    return { ...mod, db: firestoreDb };
};

// --------------------------------------------------------------------------
// C9 — App Check (only when a site key is configured)
// --------------------------------------------------------------------------
const APP_CHECK_SDK = "https://www.gstatic.com/firebasejs/11.1.0/firebase-app-check.js";
const appCheckReady = (() => {
    const siteKey = appCheckSiteKeyFrom(firebaseConfig);
    if (!siteKey) return null;
    if (shouldUseAppCheckDebugToken(window.location.hostname)) self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    return import(APP_CHECK_SDK).then(({ initializeAppCheck, ReCaptchaEnterpriseProvider, getToken }) => ({
        appCheck: initializeAppCheck(app, {
            provider: new ReCaptchaEnterpriseProvider(siteKey),
            isTokenAutoRefreshEnabled: true,
        }),
        getToken,
    })).catch((err) => {
        console.warn('App Check unavailable:', err);
        return null;
    });
})();

const getAppCheckToken = async () => {
    if (!appCheckReady) return null;
    const ready = await appCheckReady;
    if (!ready) return null;
    const result = await ready.getToken(ready.appCheck, false);
    return result?.token || null;
};

// Every call to our functions goes through apiFetch so it carries X-Firebase-AppCheck.
const apiFetch = createFunctionsFetch({ fetchImpl: (...args) => window.fetch(...args), getAppCheckToken });

const postNativeMessage = (type, payload = {}) => {
    if (!window.ReactNativeWebView?.postMessage) return;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type, payload }));
};

// --------------------------------------------------------------------------
// C7 — Native (Expo WebView) bridge. Both functions stay defined permanently.
// --------------------------------------------------------------------------
window.mobileLogin = async (idToken, accessToken, pushToken) => {
    postNativeMessage('MOBILE_LOGIN_START');

    try {
        if (!idToken || !accessToken) {
            throw new Error("Native Google login did not provide the required tokens.");
        }

        const credential = GoogleAuthProvider.credential(idToken, accessToken);
        const result = await signInWithCredential(auth, credential);
        setGoogleToken(accessToken);

        if (pushToken && result.user) {
            try {
                const firebaseIdToken = await result.user.getIdToken();
                const pushRes = await apiFetch('/updateProfile', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ idToken: firebaseIdToken, updates: { expoPushToken: pushToken } })
                });
                if (!pushRes.ok) console.warn("Push token update failed:", pushRes.status);
            } catch (pushError) {
                console.warn("Push token update failed:", pushError);
            }
        }

        postNativeMessage('MOBILE_LOGIN_SUCCESS', { email: result.user?.email || null });
        return { ok: true };
    } catch (e) {
        console.error("Mobile login bridge failed:", e);
        window.__AI_PLANNER_NATIVE_LOGIN_ERROR_POSTED = true;
        postNativeMessage('MOBILE_LOGIN_ERROR', {
            code: e.code || null,
            message: e.message || String(e)
        });
        throw e;
    }
};

let nativeTokenWaiters = [];
window.mobileUpdateAccessToken = (accessToken) => {
    if (typeof accessToken !== 'string' || !accessToken) return false;
    setGoogleToken(accessToken);
    const waiters = nativeTokenWaiters;
    nativeTokenWaiters = [];
    waiters.forEach(resolve => resolve(accessToken));
    return true;
};

const requestNativeTokenRefresh = (timeoutMs = 15000) => new Promise((resolve) => {
    if (!window.ReactNativeWebView?.postMessage) {
        resolve(null);
        return;
    }
    let timer = null;
    const done = (token) => {
        clearTimeout(timer);
        resolve(token);
    };
    timer = setTimeout(() => {
        nativeTokenWaiters = nativeTokenWaiters.filter(fn => fn !== done);
        resolve(null);
    }, timeoutMs);
    nativeTokenWaiters.push(done);
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'GOOGLE_TOKEN_REFRESH_REQUEST' }));
});

if (EMULATOR_MODE) {
    // Non-production test auth path for E2E Playwright tests (C10). The fake
    // backend accepts E2E_GOOGLE_TOKEN as the caller's own Google token; pass
    // another value (or null) to exercise the reconnect path.
    window.e2eLogin = async (email, password, googleToken = E2E_GOOGLE_TOKEN) => {
        try {
            await signInWithEmailAndPassword(auth, email, password);
        } catch (e) {
            if (e.code === 'auth/user-not-found' || e.code === 'auth/invalid-credential') {
                await createUserWithEmailAndPassword(auth, email, password);
            } else {
                throw e;
            }
        }
        setGoogleToken(googleToken || null);
    };
}

// --- GLOBAL ERROR HANDLING (GCP Error Reporting) ---
const logToGCP = (errorEvent) => {
    try {
        Promise.resolve().then(async () => {
            let idToken = null;
            try {
                idToken = currentUser ? await currentUser.getIdToken() : null;
            } catch (_) { /* anonymous error report */ }
            const errorData = {
                message: errorEvent.message || errorEvent.reason?.message || "Unknown error",
                stack: errorEvent.error?.stack || errorEvent.reason?.stack || "",
                url: `${window.location.origin}${window.location.pathname}`,
                line: errorEvent.lineno,
                column: errorEvent.colno,
                idToken
            };

            const { PRIMARY_API_URL } = getApiUrls(window.location.hostname, 'logClientError');
            apiFetch(PRIMARY_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(errorData),
                keepalive: true
            }).catch(() => { });
        }).catch(() => { });
    } catch (e) { /* failsafe */ }
};

window.addEventListener('error', logToGCP);
window.addEventListener('unhandledrejection', logToGCP);

// NAVIGATION
const switchView = (viewId) => {
    switchViewHelper(viewId);
    if (viewId !== 'view-login') {
        postNativeMessage('MOBILE_APP_READY', { viewId });
    }
};

// Build marker (now in the drawer, UX 15)
const setBuildVersionBadge = () => {
    const buildBadge = $('build-version');
    if (!buildBadge) return;
    const appScript = Array.from(document.querySelectorAll('script[src]'))
        .find(el => /app\.js(\?|$)/.test(el.getAttribute('src') || ''));
    if (!appScript) return;
    const srcUrl = new URL(appScript.src, window.location.origin);
    const version = srcUrl.searchParams.get('v') || 'dev';
    buildBadge.textContent = `build v${version}`;
};
setBuildVersionBadge();

// --------------------------------------------------------------------------
// GENERIC UI: result cards (UX 5/6), inline notices
// --------------------------------------------------------------------------
const statusArea = $('status-area');
// Result cards use the ADT tokens; the icon and title colour carry the tone, never colour alone.
const CARD_TONES = {
    success: { box: 'notice-success', title: 'notice-title-success', icon: 'circle-check' },
    error: { box: 'notice-danger', title: 'notice-title-danger', icon: 'triangle-alert' },
    processing: { box: 'notice-warning', title: 'notice-title-warning', icon: 'hourglass' },
    info: { box: 'notice-info', title: '', icon: 'info' },
};
const prefersReducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const clearStatus = () => {
    if (!statusArea) return;
    statusArea.replaceChildren();
    statusArea.classList.add('hidden');
};

/**
 * Render a result card into #status-area. All text goes through textContent.
 * @param {{tone:'success'|'error'|'processing'|'info', title:string, lines?:string[], list?:string[], note?:string, actions?:Array<{label:string,onClick?:Function,href?:string,primary?:boolean}>}} opts
 */
const renderCard = ({ tone, title, lines = [], list = [], note = '', actions = [] }) => {
    if (!statusArea) return;
    const card = document.createElement('div');
    const style = CARD_TONES[tone] || CARD_TONES.info;
    card.className = `status-card notice ${style.box} rounded-2xl p-4 space-y-2`;
    card.dataset.tone = tone;
    const h = document.createElement('p');
    h.className = `flex items-start gap-2 font-display font-bold text-[17px] ${style.title}`;
    h.innerHTML = icon(style.icon, 'mt-0.5');
    const titleText = document.createElement('span');
    titleText.textContent = title;
    h.appendChild(titleText);
    card.appendChild(h);
    lines.filter(Boolean).forEach((line) => {
        const p = document.createElement('p');
        p.className = 'leading-snug';
        p.textContent = line;
        card.appendChild(p);
    });
    if (list.length) {
        const ul = document.createElement('ul');
        ul.className = 'list-disc list-inside text-sm space-y-0.5';
        list.forEach((item) => {
            const li = document.createElement('li');
            li.textContent = item;
            ul.appendChild(li);
        });
        card.appendChild(ul);
    }
    if (note) {
        const n = document.createElement('p');
        n.className = 'status-note text-sm font-semibold text-muted';
        n.textContent = note;
        card.appendChild(n);
    }
    if (actions.length) {
        const row = document.createElement('div');
        row.className = 'flex flex-wrap gap-2 pt-1';
        actions.forEach((action) => {
            const el = document.createElement(action.href ? 'a' : 'button');
            el.className = `btn ${action.primary ? 'btn-primary' : 'btn-secondary'}`;
            el.textContent = action.label;
            if (action.href) el.insertAdjacentHTML('beforeend', icon('external-link', 'icon-sm'));
            if (action.href) {
                el.href = action.href;
                el.target = '_blank';
                el.rel = 'noopener';
            } else {
                el.type = 'button';
                el.addEventListener('click', action.onClick);
            }
            if (action.id) el.id = action.id;
            row.appendChild(el);
        });
        card.appendChild(row);
    }
    statusArea.replaceChildren(card);
    statusArea.classList.remove('hidden');
    statusArea.setAttribute('aria-live', tone === 'error' ? 'assertive' : 'polite');
    statusArea.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    // The result is the peak moment: bring it into view on small screens (UX audit #1).
    if (!statusArea.closest('.view-hidden')) {
        requestAnimationFrame(() => {
            statusArea.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
        });
    }
};

const showFieldError = (id, message) => {
    const el = $(id);
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('hidden', !message);
};

// --------------------------------------------------------------------------
// GOOGLE AUTH (B-02, B-21)
// --------------------------------------------------------------------------
const GOOGLE_SCOPES = [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/tasks',
    'https://www.googleapis.com/auth/drive.file', // Expense spreadsheet during Evening review
];

const buildGoogleProvider = ({ loginHint, selectAccount } = {}) => {
    const provider = new GoogleAuthProvider();
    GOOGLE_SCOPES.forEach(scope => provider.addScope(scope));
    const params = {};
    if (selectAccount) params.prompt = 'select_account';
    if (loginHint) params.login_hint = loginHint;
    provider.setCustomParameters(params);
    return provider;
};

const captureGoogleCredential = (result) => {
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (EMULATOR_MODE && !credential?.accessToken) {
        // The Auth emulator's Google popup returns only a fake ID token; the
        // fake backend accepts E2E_GOOGLE_TOKEN for Calendar/Tasks calls.
        setGoogleToken(E2E_GOOGLE_TOKEN);
        return E2E_GOOGLE_TOKEN;
    }
    if (!credential?.accessToken) throw new Error("Google didn't return access for Calendar and Tasks. Please try again.");
    const expiresIn = Number(result?._tokenResponse?.oauthExpireIn);
    setGoogleToken(credential.accessToken, expiresIn);
    return credential.accessToken;
};

const canFallbackToRedirect = (errorCode) => (
    errorCode === 'auth/popup-blocked' ||
    errorCode === 'auth/operation-not-supported-in-this-environment'
);

const isPopupDismissed = (code) => code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request' || code === 'auth/user-cancelled';

const friendlyAuthError = (e) => {
    const code = e?.code || '';
    if (code === 'auth/network-request-failed') return 'No internet connection. Check your connection and try again.';
    if (code === 'auth/too-many-requests') return 'Too many attempts. Wait a minute, then try again.';
    if (code === 'auth/user-disabled') return 'This account has been disabled. Contact support for help.';
    if (code === 'auth/unauthorized-domain') return 'Sign-in isn’t available on this address. Open planner.analogdigital.tech instead.';
    if (code === 'auth/popup-blocked') return 'Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.';
    if (code === 'auth/user-mismatch') return 'Please choose the same Google account you signed in with.';
    if (code === 'auth/account-exists-with-different-credential') return 'This email is linked to a different sign-in method.';
    return 'Sign-in didn’t complete. Please try again.';
};

/**
 * Re-acquire Google API access. MUST be invoked synchronously from a click
 * handler (no awaits before it) so the popup isn't blocked (B-21).
 */
const reconnectGoogle = async () => {
    if (isNativeWebView) {
        const token = await requestNativeTokenRefresh(15000);
        if (!token) {
            const err = new Error('Could not refresh your Google connection. Please close and reopen the app.');
            err.code = 'native/refresh-timeout';
            throw err;
        }
        return token;
    }
    if (!auth.currentUser) {
        const err = new Error('Please sign in again.');
        err.code = 'auth/no-current-user';
        throw err;
    }
    const result = await reauthenticateWithPopup(auth.currentUser, buildGoogleProvider({ loginHint: auth.currentUser.email }));
    return captureGoogleCredential(result);
};

const showLoginError = (message) => {
    const box = $('login-error');
    const text = $('login-error-text');
    if (!box || !text) return;
    text.textContent = message;
    box.classList.toggle('hidden', !message);
};

// Handle redirect result (only used when the login popup was blocked)
getRedirectResult(auth).then((result) => {
    if (result) captureGoogleCredential(result);
}).catch((err) => {
    console.warn("Redirect result error:", err);
    if (!isPopupDismissed(err?.code)) showLoginError(friendlyAuthError(err));
});

const startLogin = async () => {
    showLoginError('');
    try {
        const result = await signInWithPopup(auth, buildGoogleProvider({ selectAccount: true }));
        captureGoogleCredential(result);
    } catch (e) {
        if (isPopupDismissed(e.code)) return; // user closed the popup — not an error (U-11)
        if (canFallbackToRedirect(e.code)) {
            try {
                await signInWithRedirect(auth, buildGoogleProvider({ selectAccount: true }));
                return;
            } catch (redirectErr) {
                showLoginError(friendlyAuthError(redirectErr));
                return;
            }
        }
        console.warn('Login failed:', e);
        showLoginError(friendlyAuthError(e));
    }
};
$('login-btn')?.addEventListener('click', startLogin);
$('login-retry-btn')?.addEventListener('click', startLogin);

// --------------------------------------------------------------------------
// SIGN-IN / PROFILE (UX 1, C6, B-26)
// --------------------------------------------------------------------------
const todayInTimeZone = (timeZone) => {
    try { return new Date().toLocaleDateString('en-CA', { timeZone }); } catch (_) { return new Date().toLocaleDateString('en-CA'); }
};
const greetingForHour = (hour) => (hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening');
const setGreeting = (name) => {
    const el = $('user-display-name');
    if (!el) return;
    const first = String(name || '').trim().split(/\s+/)[0];
    el.textContent = first ? `${greetingForHour(new Date().getHours())}, ${first}` : '';
};

/** Shows the app bar's menu, brand and plan chip only while signed in. */
const setSignedInChrome = (signedIn) => { document.body.dataset.signedIn = signedIn ? 'true' : 'false'; };

/** Where journal pages, brain dumps and voice notes go for this user ('drive' | 'notion'). */
const notesDestination = () => resolveNotesDestination(userProfile);

const hasNotionConfigured = () => !!(userProfile && userProfile.notionKey && userProfile.notionDbId);
const hasStoredByok = () => !!(userProfile && (userProfile.geminiKey || userProfile.byokConfig || userProfile.byokKmsData));
const hasSessionByok = () => !!readByokSession(window.sessionStorage);
const usingByok = () => hasStoredByok() || hasSessionByok();

auth.onAuthStateChanged(async (user) => {
    if (user) {
        currentUser = user;
        const displayName = user.displayName || (user.email || '').split('@')[0];
        setGreeting(displayName);
        const emailEl = $('drawer-user-email');
        if (emailEl) emailEl.textContent = user.email || '';
        setSignedInChrome(true);
        showLoginError('');
        await checkUserSetup(user);
    } else {
        resetAppState();
        switchView('view-login');
    }
    // Signals that the initial auth state has been applied (used by e2e tests).
    document.documentElement.dataset.authReady = 'true';
});

const ensureProfile = async (user, existing) => {
    // C6: /updateProfile creates the user doc with full defaults; we pass the
    // Google display name so new users never see a name screen.
    const updates = { setupComplete: true };
    if (!existing || !existing.displayName) {
        updates.displayName = (user.displayName || (user.email || '').split('@')[0] || 'Friend').slice(0, 100);
    }
    try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (tz && (!existing || !existing.timeZone)) updates.timeZone = tz;
    } catch (_) { /* no Intl time zone */ }
    const idToken = await user.getIdToken();
    const res = await apiFetch('/updateProfile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, updates })
    });
    if (!res.ok) {
        const apiErr = await readApiError(res);
        const err = new Error(apiErr.message);
        err.details = apiErr.details;
        throw err;
    }
};

async function checkUserSetup(user) {
    // S-03: the backend and Firestore rules refuse unverified emails. Say so on the
    // login screen instead of showing an empty dashboard with 0 credits.
    if (user.emailVerified === false) {
        await auth.signOut();
        showLoginError(helpers.ERROR_MESSAGES.EMAIL_NOT_VERIFIED);
        return;
    }
    switchView('view-dashboard');
    renderThumbnails();
    try {
        const { db, doc, getDoc, onSnapshot } = await loadDb();
        const userRef = doc(db, "users", user.email);
        // The first Firestore read can fail while its connection is still opening
        // ("client is offline"); retry once quietly before showing an error.
        const snap = await getDoc(userRef).catch(() =>
            new Promise((resolve) => setTimeout(resolve, 1500)).then(() => getDoc(userRef)));
        if (currentUser !== user) return; // signed out meanwhile

        const existing = snap.exists() ? snap.data() : null;
        if (!existing || !existing.displayName || !existing.setupComplete) {
            try {
                await ensureProfile(user, existing);
            } catch (profileErr) {
                console.error('Profile creation failed:', profileErr);
                renderCard({
                    tone: 'error',
                    title: 'We couldn’t finish setting up your account',
                    lines: ['Your credits may not show until this works.'],
                    actions: [{ label: 'Retry', primary: true, onClick: () => checkUserSetup(user) }],
                });
            }
        }

        if (profileUnsubscribe) profileUnsubscribe();
        let staleStreakRefreshAttempted = false;
        profileUnsubscribe = onSnapshot(userRef, (docSnap) => {
            if (!docSnap.exists()) return;
            userProfile = docSnap.data();
            onProfileUpdate(userProfile);
            if (!staleStreakRefreshAttempted) {
                staleStreakRefreshAttempted = true;
                refreshStaleStreakIfNeeded(user, userProfile);
            }
        }, (err) => {
            console.error('Profile listener error:', err);
            renderCard({
                tone: 'info',
                title: 'Live updates paused',
                lines: ['Your credits and plan may be out of date.'],
                actions: [{ label: 'Reconnect', primary: true, onClick: () => checkUserSetup(user) }],
            });
        });

        loadSyncHistory(user.email);
    } catch (err) {
        console.error("Profile Load Error:", err);
        logToGCP({
            message: `Profile load failed: ${err?.code || err?.name || 'error'}: ${err?.message || ''}`.slice(0, 900),
            error: { stack: String(err?.stack || '').slice(0, 4000) },
        });
        renderCard({
            tone: 'error',
            title: 'Couldn’t load your profile',
            lines: ['Check your connection, then try again.'],
            actions: [{ label: 'Retry', primary: true, onClick: () => checkUserSetup(user) }],
        });
    }
}

async function refreshStaleStreakIfNeeded(user, profileData) {
    const stored = profileData.currentStreak || 0;
    const display = computeDisplayStreak(profileData);
    if (display !== 0 || stored === 0) return;
    try {
        const idToken = await user.getIdToken();
        const { PRIMARY_API_URL } = getApiUrls(window.location.hostname, 'refreshStaleStreak');
        await apiFetch(PRIMARY_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken })
        });
    } catch (_) { /* best-effort — UI already shows computed 0 */ }
}

const TIER_LABELS = { free: 'Free', standard: 'Standard', pro: 'Pro' };
const TIER_CREDITS = { standard: 100, pro: 250 };

function onProfileUpdate(data) {
    if (data.displayName) setGreeting(data.displayName);
    updateGamificationUI(data);

    // Live plan badge (B-17)
    const planLabel = $('plan-label');
    if (planLabel) planLabel.textContent = TIER_LABELS[data.tier] || TIER_LABELS.free;

    // Notion status
    const hasNotion = hasNotionConfigured();
    const notionOnboardStatus = $('notion-onboard-status');
    if (notionOnboardStatus) {
        notionOnboardStatus.classList.toggle('hidden', !hasNotion);
        notionOnboardStatus.classList.toggle('flex', hasNotion);
    }
    const advBadge = $('adv-notion-badge');
    if (advBadge) advBadge.textContent = hasNotion ? 'Connected' : 'Not connected';
    const advConfigure = $('adv-notion-configure');
    if (advConfigure) advConfigure.textContent = hasNotion ? 'Change' : 'Set up';
    $('adv-notion-disconnect')?.classList.toggle('hidden', !hasNotion);
    renderNotesDestination();

    // Dedup toggles (default ON)
    const calToggle = $('dedup-calendar');
    const taskToggle = $('dedup-tasks');
    if (calToggle) calToggle.checked = data.dedupCalendar !== false;
    if (taskToggle) taskToggle.checked = data.dedupTasks !== false;

    renderByokStatus();
    updateDashButtons();
    checkPendingPayment(data);
}

function updateGamificationUI(data) {
    const tierCredits = data.tierCredits || 0;
    const boosterCredits = data.boosterCredits || 0;
    const currentStreak = computeDisplayStreak(data);
    const highestStreak = data.highestStreak || 0;
    const streakFreezes = data.streakFreezes || 0;
    const byok = usingByok();
    const credits = tierCredits + boosterCredits;

    const timeZone = data.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
    const normalizedLastSync = normalizeSyncDateStr(data.lastSyncDate, timeZone);

    // Credits live in one place: the plan chip in the app bar (UX audit #3).
    const creditsText = byok ? 'own AI key' : `${credits} credit${credits === 1 ? '' : 's'}`;
    const creditsBadge = $('credits-badge');
    if (creditsBadge) creditsBadge.textContent = creditsText;
    const planBadge = $('current-plan-badge');
    if (planBadge) planBadge.setAttribute('aria-label', `${TIER_LABELS[data.tier] || TIER_LABELS.free} plan, ${creditsText}. View plans and pricing`);

    // One plain line under the greeting: streak and when you last synced.
    const caption = $('hud-caption');
    if (caption) {
        const parts = [];
        if (currentStreak > 0) parts.push(`${currentStreak}-day streak`);
        const synced = friendlySyncDate(normalizedLastSync, todayInTimeZone(timeZone));
        parts.push(synced ? `Last synced ${synced}` : 'No syncs yet — add today’s page below');
        caption.textContent = parts.join(' · ');
        caption.classList.remove('hidden');
    }

    $('reports-current-streak').textContent = `${currentStreak}`;
    $('reports-highest-streak').textContent = `${highestStreak}`;
    $('reports-streak-freezes').textContent = `${streakFreezes}`;
}

// --------------------------------------------------------------------------
// SIGN-OUT / RESET (B-15, S-04)
// --------------------------------------------------------------------------
const revokeLegacyByokCookie = async () => {
    // C1: DELETE /byokSession only expires legacy cookies; best-effort with a short timeout.
    try {
        if (!auth.currentUser) return;
        const idToken = await auth.currentUser.getIdToken();
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 3000);
        await apiFetch('/byokSession', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken }),
            signal: controller.signal,
            keepalive: true,
        }).catch(() => { });
        clearTimeout(t);
    } catch (_) { /* best effort */ }
};

function resetAppState() {
    if (profileUnsubscribe) { profileUnsubscribe(); profileUnsubscribe = null; }
    currentUser = null;
    userProfile = null;
    filesAsBase64 = [];
    lastAttempt = null;
    lastVoicePayload = null;
    setGoogleToken(null);
    stopRecording({ discard: true });
    if (pendingPayment?.timer) clearTimeout(pendingPayment.timer);
    pendingPayment = null;
    clearByokSession(window.sessionStorage, window.localStorage);

    setGreeting('');
    setSignedInChrome(false);
    const emailEl = $('drawer-user-email');
    if (emailEl) emailEl.textContent = '';
    const caption = $('hud-caption');
    if (caption) { caption.textContent = ''; caption.classList.add('hidden'); }
    // "…" until the next profile loads — never a misleading 0 (UX 8).
    ['reports-current-streak', 'reports-streak-freezes'].forEach(id => { const el = $(id); if (el) el.textContent = '…'; });
    const credits = $('credits-badge'); if (credits) credits.textContent = '…';
    const highest = $('reports-highest-streak'); if (highest) highest.textContent = '0';
    const planLabel = $('plan-label'); if (planLabel) planLabel.textContent = TIER_LABELS.free;
    const history = $('history-list'); if (history) history.replaceChildren();
    const heatmap = $('heatmap-grid'); if (heatmap) heatmap.replaceChildren();
    ['notion-key-input', 'notion-db-input', 'byok-api-key', 'byok-custom-url', 'byok-custom-model', 'byok-custom-api-version', 'user-display-name-input', 'user-phone']
        .forEach(id => { const el = $(id); if (el) el.value = ''; });
    $('notion-onboard-status')?.classList.add('hidden');
    const advBadge = $('adv-notion-badge'); if (advBadge) advBadge.textContent = 'Not connected';
    clearStatus();
    closeDrawer();
    closeUpgradeFlow();
    restoreByokUi();
    renderThumbnails();
}

const signOutUser = async () => {
    await revokeLegacyByokCookie();
    clearByokSession(window.sessionStorage, window.localStorage);
    await auth.signOut();
};

// --------------------------------------------------------------------------
// NOTION (UX 1, UX 10, C2)
// --------------------------------------------------------------------------
// Where Notion setup returns to, and whether connecting should also make Notion the notes destination.
let notionSetupReturn = { view: 'view-dashboard', makeDestination: false };
const openNotionSetup = (context = '', { returnTo = 'view-dashboard', makeDestination = false } = {}) => {
    notionSetupReturn = { view: returnTo, makeDestination };
    const ctx = $('notion-setup-context');
    if (ctx) {
        ctx.textContent = context;
        ctx.classList.toggle('hidden', !context);
    }
    showFieldError('notion-key-error', '');
    showFieldError('notion-db-error', '');
    switchView('view-notion-setup');
};
const leaveNotionSetup = () => {
    switchView(notionSetupReturn.view);
    if (notionSetupReturn.view === 'view-setup') renderNotesDestination();
};

// --------------------------------------------------------------------------
// NOTES DESTINATION: Google Drive or Notion (journal pages, brain dumps, voice notes)
// --------------------------------------------------------------------------
const showSettingsStatus = (id, message) => {
    const el = $(id);
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('hidden', !message);
};

function renderNotesDestination() {
    const dest = notesDestination();
    document.querySelectorAll('input[name="notes-destination"]').forEach(radio => { radio.checked = radio.value === dest; });
    const where = DESTINATION_LABELS[dest];
    const journalDesc = $('journal-desc');
    if (journalDesc) journalDesc.textContent = `Saves journal pages to ${where}.`;
    const eveningDesc = $('evening-desc');
    if (eveningDesc) eveningDesc.textContent = `Ticks off what you did; logs spending and health to Sheets; saves your brain dump to ${where}.`;
    updateDashButtons();
}

async function saveNotesDestination(value, { quiet = false } = {}) {
    showFieldError('notes-destination-error', '');
    if (!auth.currentUser) return false;
    try {
        const idToken = await auth.currentUser.getIdToken();
        const res = await apiFetch('/updateProfile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken, updates: { notesDestination: value } }),
        });
        if (!res.ok) {
            const apiErr = await readApiError(res);
            showFieldError('notes-destination-error', describeApiError({ status: res.status, data: apiErr.data || {} }).message);
            renderNotesDestination();
            return false;
        }
        if (userProfile) userProfile = { ...userProfile, notesDestination: value };
        renderNotesDestination();
        if (!quiet) showSettingsStatus('notes-destination-status', `Saved. Journal pages will go to ${DESTINATION_LABELS[value]}.`);
        return true;
    } catch (err) {
        console.error('Failed to save notes destination:', err);
        showFieldError('notes-destination-error', 'Couldn’t save that. Check your connection and try again.');
        renderNotesDestination();
        return false;
    }
}

document.querySelectorAll('input[name="notes-destination"]').forEach(radio => {
    radio.addEventListener('change', () => {
        if (!radio.checked) return;
        showSettingsStatus('notes-destination-status', '');
        if (radio.value === 'notion' && !hasNotionConfigured()) {
            openNotionSetup('', { returnTo: 'view-setup', makeDestination: true });
            return;
        }
        saveNotesDestination(radio.value);
    });
});

const notionDbInput = $('notion-db-input');
const notionKeyInput = $('notion-key-input');
const describeNotionDbInput = () => {
    const raw = notionDbInput?.value.trim() || '';
    const help = $('notion-db-help');
    if (!raw) {
        if (help) help.textContent = 'Paste the whole link — we’ll pick out the ID.';
        return null;
    }
    const id = extractNotionId(raw);
    if (help) {
        help.textContent = id
            ? `Database ID found: ${id.slice(0, 4)}…${id.slice(-4)}`
            : 'Paste the whole link — we’ll pick out the ID.';
    }
    return id;
};
notionDbInput?.addEventListener('input', () => { showFieldError('notion-db-error', ''); describeNotionDbInput(); });
notionDbInput?.addEventListener('blur', () => {
    const raw = notionDbInput.value.trim();
    if (raw && !extractNotionId(raw)) {
        showFieldError('notion-db-error', 'We couldn’t find a database ID in that. Copy the database link from Notion (Share → Copy link).');
    }
});
notionKeyInput?.addEventListener('input', () => showFieldError('notion-key-error', ''));

$('save-notion-btn')?.addEventListener('click', async () => {
    const key = notionKeyInput.value.trim();
    const keyError = validateNotionKey(key);
    const dbId = describeNotionDbInput();
    showFieldError('notion-key-error', keyError);
    showFieldError('notion-db-error', dbId ? '' : 'Paste your Notion database link or its 32-character ID.');
    if (keyError || !dbId) {
        (keyError ? notionKeyInput : notionDbInput)?.focus();
        return;
    }
    if (!auth.currentUser) {
        showFieldError('notion-db-error', 'Please sign in again to connect Notion.');
        return;
    }

    const saveBtn = $('save-notion-btn');
    const originalText = saveBtn.textContent;
    saveBtn.textContent = "Connecting…";
    saveBtn.disabled = true;

    try {
        const idToken = await auth.currentUser.getIdToken();
        const res = await apiFetch('/setupNotion', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken, notionKey: key, notionDbId: dbId })
        });
        if (!res.ok) {
            const apiErr = await readApiError(res);
            showFieldError('notion-db-error', describeApiError({ status: res.status, data: apiErr.data || {} }).message);
            return;
        }
        notionKeyInput.value = '';
        notionDbInput.value = '';
        describeNotionDbInput();
        const { view, makeDestination } = notionSetupReturn;
        if (makeDestination || notesDestination() !== 'notion') await saveNotesDestination('notion', { quiet: true });
        switchView(view);
        if (view === 'view-setup') {
            renderNotesDestination();
            showSettingsStatus('notes-destination-status', 'Notion is connected. Journal pages will go to Notion.');
        } else {
            renderCard({
                tone: 'success',
                title: 'Notion connected',
                lines: ['Journal pages, brain dumps and voice notes will be saved to your database. You can switch back to Google Drive in Settings.'],
            });
        }
    } catch (err) {
        console.error("Failed to save Notion keys:", err);
        showFieldError('notion-db-error', 'Couldn’t reach the server. Check your connection and try again.');
    } finally {
        saveBtn.textContent = originalText;
        saveBtn.disabled = false;
    }
});

$('skip-notion-btn')?.addEventListener('click', (event) => {
    event.preventDefault();
    leaveNotionSetup();
});

$('change-notion-onboard-btn')?.addEventListener('click', () => {
    $('notion-onboard-status')?.classList.add('hidden');
    $('notion-onboard-status')?.classList.remove('flex');
    if (notionKeyInput) notionKeyInput.value = '';
    if (notionDbInput) notionDbInput.value = '';
    notionKeyInput?.focus();
});

$('adv-notion-configure')?.addEventListener('click', () => openNotionSetup('', { returnTo: 'view-setup' }));

$('adv-notion-disconnect')?.addEventListener('click', async (e) => {
    if (!auth.currentUser) return;
    if (!window.confirm('Disconnect Notion? Your saved Notion token and database ID will be deleted from AI Planner.')) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
        const idToken = await auth.currentUser.getIdToken();
        const res = await apiFetch('/setupNotion', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken, action: 'delete' })
        });
        if (!res.ok) {
            const apiErr = await readApiError(res);
            showActionableError({ title: 'Couldn’t disconnect Notion', summary: describeApiError({ status: res.status, data: apiErr.data || {} }).message, details: apiErr.details });
            return;
        }
        const advBadge = $('adv-notion-badge');
        if (advBadge) advBadge.textContent = 'Not connected';
        btn.classList.add('hidden');
        // Notes can't go to a disconnected Notion: switch them to Google Drive.
        if (notesDestination() === 'notion') {
            if (userProfile) userProfile = { ...userProfile, notionKey: null, notionDbId: null };
            await saveNotesDestination('drive', { quiet: true });
            showSettingsStatus('notes-destination-status', 'Notion disconnected. Journal pages will go to Google Drive.');
        }
    } catch (err) {
        showActionableError({ title: 'Couldn’t disconnect Notion', summary: 'Check your connection and try again.', details: err?.message });
    } finally {
        btn.disabled = false;
    }
});


// --------------------------------------------------------------------------
// BYOK (C1, C2, B-04, B-27)
// --------------------------------------------------------------------------
const BYOK_KEY_HINTS = {
    openai:      'Key format: sk-…  (from platform.openai.com/api-keys)',
    anthropic:   'Key format: sk-ant-…  (from console.anthropic.com)',
    google:      'Key format: AIza…  (from aistudio.google.com/app/apikey)',
    xai:         'Key format: xai-…  (from console.x.ai)',
    cohere:      'Key format: found in dashboard.cohere.com/api-keys',
    huggingface: 'Key format: hf_…  (from huggingface.co/settings/tokens)',
    groq:        'Key format: gsk_…  (from console.groq.com/keys)',
    deepseek:    'Key format: sk-…  (from platform.deepseek.com)',
    mistral:     'Key format: found in console.mistral.ai/api-keys',
    perplexity:  'Key format: pplx-…  (from perplexity.ai/settings/api)',
    together:    'Key format: found in api.together.ai/settings/api-keys',
    openrouter:  'Key format: sk-or-…  (from openrouter.ai/keys)',
    azure:       'Key format: your Azure OpenAI resource key (not a Bearer token)',
};
const BYOK_DEFAULT_PLACEHOLDER = 'Paste your API key here…';
const BYOK_ACTIVE_PLACEHOLDER = 'Key active in this tab — leave blank to keep it';

function updateByokKeyHint(provider) {
    const hintEl = $('byok-key-hint');
    if (!hintEl) return;
    const hint = BYOK_KEY_HINTS[provider];
    if (hint) {
        hintEl.textContent = hint;
        hintEl.classList.remove('hidden');
    } else {
        hintEl.classList.add('hidden');
    }
}

function showCustomFields(subType) {
    const fields = $('byok-custom-fields');
    const label = $('custom-type-label');
    const urlInput = $('byok-custom-url');
    const versionGroup = $('custom-api-version-group');
    fields.classList.remove('hidden');
    versionGroup.classList.add('hidden');
    if (subType === 'openai-compat' || subType === 'cloud') {
        label.textContent = 'OpenAI-compatible API (same request format as OpenAI)';
        urlInput.placeholder = 'https://api.example.com/v1/chat/completions';
    } else if (subType === 'local') {
        label.textContent = 'Local or self-hosted (for example Ollama)';
        urlInput.placeholder = 'https://your-secure-ollama.example.com/v1/chat/completions';
    } else if (subType === 'azure' || subType === 'enterprise') {
        label.textContent = 'Azure OpenAI endpoint';
        urlInput.placeholder = 'https://your-resource.openai.azure.com';
        versionGroup.classList.remove('hidden');
    }
}

$('byok-provider')?.addEventListener('change', (e) => {
    const val = e.target.value;
    if (val.startsWith('custom:')) {
        showCustomFields(val.split(':')[1]);
        $('byok-key-hint')?.classList.add('hidden');
    } else {
        $('byok-custom-fields').classList.add('hidden');
        const [providerName] = val.split(':');
        updateByokKeyHint(providerName);
    }
});

const readByokForm = () => {
    const providerVal = $('byok-provider').value;
    let provider, modelName, baseUrl, apiVersion, isCustom = false;
    if (providerVal.startsWith('custom:')) {
        isCustom = true;
        const subType = providerVal.split(':')[1];
        baseUrl = $('byok-custom-url').value.trim();
        modelName = $('byok-custom-model').value.trim();
        apiVersion = $('byok-custom-api-version')?.value.trim() || undefined;
        if (subType === 'local') provider = 'ollama';
        else if (subType === 'azure' || subType === 'enterprise') provider = 'azure';
        else provider = 'openai';
    } else {
        // Split on first colon only — model names may contain colons
        const firstColon = providerVal.indexOf(':');
        provider = providerVal.slice(0, firstColon);
        modelName = providerVal.slice(firstColon + 1);
    }
    return { provider, modelName, baseUrl: baseUrl || undefined, apiVersion, isCustom };
};

// Restore BYOK UI from this tab's session config. The key never goes back into
// the input's value (B-04) — only a placeholder hint.
function restoreByokUi() {
    const cfg = readByokSession(window.sessionStorage);
    const apiKeyInput = $('byok-api-key');
    const providerSelect = $('byok-provider');
    if (apiKeyInput) {
        apiKeyInput.value = '';
        apiKeyInput.placeholder = cfg ? BYOK_ACTIVE_PLACEHOLDER : BYOK_DEFAULT_PLACEHOLDER;
    }
    if (cfg && providerSelect) {
        const preset = `${cfg.provider}:${cfg.modelName}`;
        if (!cfg.baseUrl && Array.from(providerSelect.options).some(o => o.value === preset)) {
            providerSelect.value = preset;
            $('byok-custom-fields')?.classList.add('hidden');
            updateByokKeyHint(cfg.provider);
        } else {
            const sub = cfg.provider === 'ollama' ? 'local' : cfg.provider === 'azure' ? 'azure' : 'openai-compat';
            providerSelect.value = `custom:${sub}`;
            showCustomFields(sub);
            $('byok-custom-url').value = cfg.baseUrl || '';
            $('byok-custom-model').value = cfg.modelName || '';
            if (cfg.apiVersion) $('byok-custom-api-version').value = cfg.apiVersion;
        }
        const statelessRadio = document.querySelector('input[name="byok-mode"][value="stateless"]');
        if (statelessRadio) statelessRadio.checked = true;
    }
    renderByokStatus();
}

function renderByokStatus() {
    const status = $('byok-status');
    const cfg = readByokSession(window.sessionStorage);
    const stored = hasStoredByok();
    const lines = [];
    if (cfg) lines.push(`Using your ${cfg.provider} key (${cfg.modelName}) in this tab only.`);
    if (stored) lines.push('An encrypted key is saved on our server.');
    if (status) {
        status.textContent = lines.join(' ');
        status.classList.toggle('hidden', lines.length === 0);
    }
    $('byok-clear-session')?.classList.toggle('hidden', !cfg);
    $('byok-delete-stored')?.classList.toggle('hidden', !stored);
}

restoreByokUi();
$('byok-api-key')?.addEventListener('input', () => showFieldError('byok-error', ''));

$('save-setup-btn')?.addEventListener('click', async () => {
    showFieldError('byok-error', '');
    const byokMode = document.querySelector('input[name="byok-mode"]:checked')?.value || 'stateless';
    const typedKey = $('byok-api-key').value.trim();
    const form = readByokForm();
    const existing = readByokSession(window.sessionStorage);
    // B-04: send apiKey only when the user typed a new one (or reuse this tab's key on a model change).
    const apiKey = typedKey || (byokMode === 'stateless' && existing ? existing.apiKey : '');

    if (!apiKey) {
        showFieldError('byok-error', byokMode === 'kms'
            ? 'Paste your API key to save it encrypted.'
            : 'Paste your API key first.');
        $('byok-api-key').focus();
        return;
    }
    if (form.isCustom && (!form.baseUrl || !form.modelName)) {
        showFieldError('byok-error', 'Enter the API Base URL and Model Name for your custom provider.');
        return;
    }
    if (!auth.currentUser) {
        showFieldError('byok-error', 'Please sign in again to save AI key settings.');
        return;
    }

    const saveBtn = $('save-setup-btn');
    const originalText = saveBtn.textContent;
    saveBtn.textContent = "Checking key…";
    saveBtn.disabled = true;

    try {
        const idToken = await auth.currentUser.getIdToken();
        const body = { idToken, apiKey, provider: form.provider, modelName: form.modelName, baseUrl: form.baseUrl, apiVersion: form.apiVersion };

        if (byokMode === 'stateless') {
            // C1: validation-only endpoint, sets no cookies.
            const res = await apiFetch('/byokSession', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (!res.ok) {
                const apiErr = await readApiError(res);
                showFieldError('byok-error', describeApiError({ status: res.status, data: apiErr.data || {} }).message);
                return;
            }
            const validation = await parseJsonResponse(res).catch(() => ({}));
            if (validation.valid !== true) {
                showFieldError('byok-error', 'Your AI provider key or model was rejected. Check it and try again.');
                return;
            }
            writeByokSession(window.sessionStorage, { provider: form.provider, modelName: form.modelName, apiKey, baseUrl: form.baseUrl, apiVersion: form.apiVersion });
        } else {
            const res = await apiFetch('/setupBYOK', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (!res.ok) {
                const apiErr = await readApiError(res);
                showFieldError('byok-error', describeApiError({ status: res.status, data: apiErr.data || {} }).message);
                return;
            }
            // Saved server-side; stop sending a tab key so the stored one is used.
            clearByokSession(window.sessionStorage, window.localStorage);
        }

        restoreByokUi();
        if (userProfile) updateGamificationUI(userProfile);
        updateDashButtons();
        switchView('view-dashboard');
        renderCard({
            tone: 'success',
            title: 'AI key saved',
            lines: [byokMode === 'stateless'
                ? 'Your key stays in this tab and is sent with each sync. Closing the tab erases it.'
                : 'Your key is saved encrypted and will be used for every sync.'],
        });
    } catch (err) {
        console.error("Failed to save BYOK settings:", err);
        showFieldError('byok-error', 'Couldn’t reach the server. Check your connection and try again.');
    } finally {
        saveBtn.textContent = originalText;
        saveBtn.disabled = false;
    }
});

$('byok-clear-session')?.addEventListener('click', () => {
    clearByokSession(window.sessionStorage, window.localStorage);
    restoreByokUi();
    if (userProfile) updateGamificationUI(userProfile);
    updateDashButtons();
});

const deleteStoredByok = async () => {
    if (!auth.currentUser) return false;
    const idToken = await auth.currentUser.getIdToken();
    const res = await apiFetch('/setupBYOK', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, action: 'delete' })
    });
    if (!res.ok) {
        const apiErr = await readApiError(res);
        showActionableError({ title: 'Couldn’t remove the saved key', summary: describeApiError({ status: res.status, data: apiErr.data || {} }).message, details: apiErr.details });
        return false;
    }
    return true;
};

$('byok-delete-stored')?.addEventListener('click', async (e) => {
    if (!window.confirm('Remove your saved AI key from our server? Syncs will use AI Planner credits again.')) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
        if (await deleteStoredByok()) {
            btn.classList.add('hidden');
            renderByokStatus();
        }
    } catch (err) {
        showActionableError({ title: 'Couldn’t remove the saved key', summary: 'Check your connection and try again.', details: err?.message });
    } finally {
        btn.disabled = false;
    }
});

// --- Dedup Preference Toggles (B-26) ---
async function saveDedupPreference(toggle, field) {
    const value = toggle.checked;
    showFieldError('dedup-error', '');
    try {
        if (!auth.currentUser) throw new Error('signed out');
        const idToken = await auth.currentUser.getIdToken();
        const res = await apiFetch('/updateProfile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken, updates: { [field]: value } })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
        console.error('Failed to save dedup preference:', err);
        toggle.checked = !value; // revert
        showFieldError('dedup-error', 'Couldn’t save that setting. Please try again.');
    }
}
$('dedup-calendar')?.addEventListener('change', (e) => saveDedupPreference(e.target, 'dedupCalendar'));
$('dedup-tasks')?.addEventListener('change', (e) => saveDedupPreference(e.target, 'dedupTasks'));

// --------------------------------------------------------------------------
// MODALS / DRAWER (U-04, B-32)
// --------------------------------------------------------------------------
const guideModal = $('guide-modal');
let guideDeactivate = null;
const closeGuide = () => {
    guideModal?.classList.add('hidden');
    guideModal?.classList.remove('flex');
    if (guideDeactivate) { guideDeactivate(); guideDeactivate = null; }
};
$('open-guide-onboard')?.addEventListener('click', () => {
    guideModal.classList.remove('hidden');
    guideModal.classList.add('flex');
    guideDeactivate = activateDialog(guideModal, closeGuide, $('close-guide'));
});
$('close-guide')?.addEventListener('click', closeGuide);
guideModal?.addEventListener('click', (e) => { if (e.target === guideModal) closeGuide(); });

const drawerContainer = $('drawer-container');
const hamburgerBtn = $('hamburger-btn');
let drawerCloseTimer = null;
let drawerDeactivate = null;
function openDrawer() {
    clearTimeout(drawerCloseTimer); // B-32: a pending close must not re-hide a reopened drawer
    drawerContainer.classList.remove('hidden');
    hamburgerBtn?.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => {
        requestAnimationFrame(() => drawerContainer.classList.add('drawer-open'));
    });
    if (!drawerDeactivate) drawerDeactivate = activateDialog($('drawer-panel'), closeDrawer, $('close-drawer'));
}
function closeDrawer() {
    if (!drawerContainer || drawerContainer.classList.contains('hidden')) return;
    drawerContainer.classList.remove('drawer-open');
    hamburgerBtn?.setAttribute('aria-expanded', 'false');
    clearTimeout(drawerCloseTimer);
    drawerCloseTimer = setTimeout(() => drawerContainer.classList.add('hidden'), 300);
    if (drawerDeactivate) { drawerDeactivate(); drawerDeactivate = null; }
}

hamburgerBtn?.addEventListener('click', openDrawer);
$('close-drawer')?.addEventListener('click', closeDrawer);
$('drawer-overlay')?.addEventListener('click', closeDrawer);

document.querySelectorAll('[data-drawer]').forEach(btn => {
    btn.addEventListener('click', () => {
        closeDrawer();
        const action = btn.dataset.drawer;
        switch (action) {
            case 'upgrade':
                openUpgradeFlow();
                break;
            case 'reports':
                switchView('view-reports');
                if (currentUser) loadHeatmap(currentUser.email);
                break;
            case 'history':
                switchView('view-history');
                if (currentUser) loadSyncHistory(currentUser.email);
                break;
            case 'notion':
                openNotionSetup();
                break;
            case 'settings': {
                const input = $('user-display-name-input');
                if (input) input.value = userProfile?.displayName || currentUser?.displayName || '';
                showFieldError('name-error', '');
                ['name-status', 'notes-destination-status'].forEach(id => showSettingsStatus(id, ''));
                renderNotesDestination();
                restoreByokUi();
                switchView('view-setup');
                break;
            }
            case 'export':
                exportMyData();
                break;
            case 'delete':
                deleteMyAccount();
                break;
            case 'logout':
                signOutUser();
                break;
        }
    });
});

$('back-to-dash-btn')?.addEventListener('click', () => switchView('view-dashboard'));
$('back-to-dash-btn-reports')?.addEventListener('click', () => switchView('view-dashboard'));
$('back-to-dash-from-setup')?.addEventListener('click', () => switchView('view-dashboard'));

// --------------------------------------------------------------------------
// DASHBOARD: upload (UX 2, B-05, B-16, B-28, U-03, U-08)
// --------------------------------------------------------------------------
const dropZone = $('drop-zone');
const ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif';
const currentTier = () => userProfile?.tier || 'free';

const uploadLabel = (iconName, text, extraAttrs) => `
        <label class="upload-label min-w-[76px] min-h-[64px] flex flex-col items-center justify-center gap-1 px-3 py-2 rounded-xl bg-bg border border-line hover:border-line-strong transition-colors cursor-pointer">
            <input type="file" accept="${ACCEPT}" ${extraAttrs} class="upload-input sr-only-input">
            ${icon(iconName, 'icon-lg text-ink pointer-events-none')}
            <span class="text-sm font-semibold text-ink pointer-events-none">${text}</span>
        </label>`;

const defaultUploadUI = () => `
    <div id="upload-ui" class="w-full flex flex-col items-center gap-3 p-5 relative z-10">
        <p class="font-display font-bold text-ink text-center">Photograph today’s page</p>
        <div class="flex items-stretch justify-center gap-2 sm:gap-3">
            ${uploadLabel('camera', 'Camera', 'capture="environment" aria-label="Take a photo of your page"')}
            ${uploadLabel('image', 'Gallery', 'multiple aria-label="Choose page photos from your gallery"')}
            ${uploadLabel('folder', 'Files', 'multiple aria-label="Choose page image files"')}
        </div>
        <p class="text-sm text-muted text-center leading-snug">Any notebook works. Best with the
            <a href="planner.html" target="_blank" rel="noopener" class="link font-semibold">free printable template (PDF)</a>.</p>
        <p class="text-xs text-muted text-center leading-snug">“9:00 Team call” becomes a 9 AM Calendar event; “☐ Pay rent” becomes a Google Task.</p>
    </div>`;

dropZone.addEventListener('change', (e) => {
    if (e.target.classList.contains('upload-input')) {
        const files = Array.from(e.target.files || []);
        e.target.value = '';
        handleFiles(files);
    }
});

const renderThumbnails = () => {
    if (!dropZone) return;
    if (filesAsBase64.length === 0) {
        dropZone.innerHTML = defaultUploadUI();
        updateDashButtons();
        return;
    }
    const max = maxUploadForTier(currentTier());
    const wrap = document.createElement('div');
    wrap.className = 'w-full flex flex-wrap gap-4 justify-center items-center p-4';
    filesAsBase64.forEach((b64, idx) => {
        const item = document.createElement('div');
        item.className = 'relative h-28 w-20 shrink-0';
        let img;
        if (isHeicDataUrl(b64)) {
            // C8: undecodable HEIC — neutral placeholder; the server converts it.
            img = document.createElement('div');
            img.setAttribute('role', 'img');
            img.setAttribute('aria-label', `Planner page ${idx + 1} (HEIC photo)`);
            img.className = 'heic-placeholder h-full w-full flex flex-col items-center justify-center gap-1 border border-line rounded-lg bg-raised text-muted';
            img.innerHTML = `${icon('image', 'icon-lg')}<span class="text-xs font-semibold leading-tight text-center">HEIC photo</span>`;
        } else {
            img = document.createElement('img');
            img.src = b64;
            img.alt = `Planner page ${idx + 1}`;
            img.className = 'h-full w-full object-cover border border-line rounded-lg';
        }
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'delete-btn absolute -top-4 -right-4 w-11 h-11 flex items-center justify-center z-10';
        del.dataset.idx = String(idx);
        del.setAttribute('aria-label', `Remove page ${idx + 1}`);
        del.innerHTML = `<span aria-hidden="true" class="w-7 h-7 rounded-full bg-ink text-bg flex items-center justify-center shadow">${icon('x', 'icon-sm')}</span>`;
        del.disabled = isSyncing;
        del.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (isSyncing) return;
            filesAsBase64.splice(idx, 1);
            renderThumbnails();
        });
        item.append(img, del);
        wrap.appendChild(item);
    });
    if (filesAsBase64.length < max) {
        const adders = document.createElement('div');
        adders.className = 'flex flex-col gap-2';
        adders.innerHTML = `
            <label class="upload-label h-11 w-11 shrink-0 border-2 border-dashed border-line-strong flex items-center justify-center text-muted hover:text-ink transition-colors rounded-lg cursor-pointer" title="Take another photo">
                <input type="file" accept="${ACCEPT}" capture="environment" class="upload-input sr-only-input" aria-label="Take another photo">
                ${icon('camera', 'pointer-events-none')}
            </label>
            <label class="upload-label h-11 w-11 shrink-0 border-2 border-dashed border-line-strong flex items-center justify-center text-muted hover:text-ink transition-colors rounded-lg cursor-pointer" title="Add from gallery">
                <input type="file" accept="${ACCEPT}" multiple class="upload-input sr-only-input" aria-label="Add more pages from your gallery">
                ${icon('plus', 'pointer-events-none')}
            </label>`;
        wrap.appendChild(adders);
    }
    const counter = document.createElement('div');
    counter.className = 'absolute bottom-2 right-2 badge bg-ink text-bg pointer-events-none z-20';
    counter.textContent = `${filesAsBase64.length}/${max} page${max === 1 ? '' : 's'}`;
    dropZone.replaceChildren(wrap, counter);
    updateDashButtons();
};

const readFileAsDataUrl = (file) => new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (ev) => resolve(typeof ev.target.result === 'string' ? ev.target.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
});

/** Decode in the browser and re-encode as a ≤1200×1600 JPEG; null if the browser can't decode it. */
const compressDataUrl = (src) => new Promise((resolve) => {
    if (!src) { resolve(null); return; }
    const img = new Image();
    img.onerror = () => resolve(null);
    img.onload = () => {
        if (!img.width || !img.height) { resolve(null); return; }
        const MAX_WIDTH = 1200;
        const MAX_HEIGHT = 1600;
        let width = img.width;
        let height = img.height;
        if (width > height) {
            if (width > MAX_WIDTH) { height *= MAX_WIDTH / width; width = MAX_WIDTH; }
        } else if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height; height = MAX_HEIGHT;
        }
        try {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            canvas.getContext('2d').drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL('image/jpeg', 0.85));
        } catch (_) {
            resolve(null);
        }
    };
    img.src = src;
});

/**
 * C8: returns the data URL to send for one picked file, or null if unreadable.
 * Browsers that decode HEIC (Safari) take the normal JPEG path; elsewhere the
 * raw HEIC/HEIF is sent as-is and the server converts it.
 */
const prepareImage = async (file) => {
    const raw = await readFileAsDataUrl(file);
    if (!raw) return null;
    const jpeg = await compressDataUrl(raw);
    if (jpeg) return jpeg;
    return isHeicFile(file) ? toHeicDataUrl(raw, heicMimeFor(file)) : null;
};

const handleFiles = async (files) => {
    if (!files || files.length === 0 || isSyncing) return;
    const tier = currentTier();
    const max = maxUploadForTier(tier); // B-05: tier maximum at upload; per-mode limit is enforced at sync
    const remainingSlots = max - filesAsBase64.length;
    const problems = [];

    if (remainingSlots <= 0) {
        renderCard({
            tone: 'info',
            title: `Your plan holds ${max} page${max === 1 ? '' : 's'} per sync`,
            lines: [tier === 'pro' ? 'Sync these pages first, then add more.' : 'Upgrade to sync more pages together.'],
            actions: tier === 'pro' ? [] : [{ label: 'See plans', onClick: () => openUpgradeFlow({ outcome: 'batch' }) }],
        });
        return;
    }

    const images = files.filter(isAcceptedImage);
    if (images.length < files.length) problems.push(`${files.length - images.length} file(s) skipped — only photos (JPG, PNG, WebP, HEIC) are supported.`);
    const toProcess = images.slice(0, remainingSlots);
    if (images.length > remainingSlots) problems.push(`Only ${remainingSlots} more page${remainingSlots === 1 ? '' : 's'} fit${remainingSlots === 1 ? 's' : ''} your plan; the rest were skipped.`);

    dropZone.innerHTML = '<div class="flex flex-col items-center p-6" role="status"><div class="spinner" aria-hidden="true"></div><p class="mt-2 text-sm text-muted">Preparing your photos…</p></div>';

    try {
        for (const file of toProcess) {
            if (file.size > MAX_IMAGE_BYTES) {
                problems.push(isHeicFile(file) ? heicTooLargeMessage(file.name) : `${file.name} is larger than 20 MB.`);
                continue;
            }
            // C8: HEIC/HEIF is decoded natively where the browser can (Safari / iOS);
            // otherwise the raw photo is sent and converted on the server.
            const data = await prepareImage(file);
            if (!data) {
                problems.push(`${file.name} couldn’t be read. It may be corrupted or unsupported.`);
            } else if (imagesPayloadChars(filesAsBase64) + data.length > MAX_IMAGES_PAYLOAD_CHARS) {
                problems.push(`${file.name} didn’t fit — these photos are too large to sync together. Sync the others first, then add it.`);
            } else {
                filesAsBase64.push(data);
            }
        }
    } catch (err) {
        console.error('Image processing failed:', err);
        problems.push('Something went wrong while preparing your photos.');
    } finally {
        renderThumbnails(); // B-28: never leave the spinner behind
    }

    if (problems.length) {
        renderCard({
            tone: 'info',
            title: 'Some photos weren’t added',
            list: problems,
            actions: tier === 'pro' || images.length <= remainingSlots ? [] : [{ label: 'See plans', onClick: () => openUpgradeFlow({ outcome: 'batch' }) }],
        });
    } else {
        clearStatus();
    }
};

['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => { e.preventDefault(); e.stopPropagation(); }, false);
});
['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, () => dropZone.classList.add('drop-zone-active'), false);
});
['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, () => dropZone.classList.remove('drop-zone-active'), false);
});
dropZone.addEventListener('drop', (e) => handleFiles(Array.from(e.dataTransfer?.files || [])));

// --------------------------------------------------------------------------
// DASHBOARD: buttons (UX 3, 8, 9)
// --------------------------------------------------------------------------
const modeButtons = {
    morning: $('btn-morning'),
    evening: $('btn-night'),
    journal: $('btn-journal'),
    voice_note: $('btn-voice-note'),
};

function updateDashButtons() {
    const hasImages = filesAsBase64.length > 0;
    // Plan, credits and Notion status come from the profile; syncing before it
    // loads would skip the Notion check and show the wrong cost.
    const profileLoading = !!currentUser && !userProfile;
    const pageModesDisabled = isSyncing || isRecording || !hasImages || profileLoading;
    ['morning', 'evening', 'journal'].forEach(mode => {
        if (modeButtons[mode]) modeButtons[mode].disabled = pageModesDisabled;
    });
    if (modeButtons.voice_note) modeButtons.voice_note.disabled = isSyncing || profileLoading; // B-16

    const hint = $('sync-hint');
    if (hint) {
        if (isSyncing) hint.textContent = 'Syncing… please keep this tab open.';
        else if (profileLoading) hint.textContent = 'Loading your account…';
        else if (isRecording) hint.textContent = 'Recording a voice note…';
        else if (!hasImages) hint.textContent = 'Add a page photo first.';
        else hint.textContent = `${filesAsBase64.length} page${filesAsBase64.length === 1 ? '' : 's'} ready.`;
    }

    const costLine = $('credit-cost-line');
    if (costLine) {
        if (!userProfile) costLine.textContent = '';
        else if (usingByok()) costLine.textContent = 'Using your own AI key · no credits used';
        else {
            costLine.textContent = 'Uses 1 credit per page. A sync that saves nothing is free.';
        }
    }

    // UX 9: Pro lock shown before recording
    const isPro = currentTier() === 'pro';
    $('voice-pro-lock')?.classList.toggle('hidden', isPro || !userProfile);
    const voiceDesc = $('voice-note-desc');
    if (voiceDesc && !isRecording) {
        voiceDesc.textContent = (!isPro && userProfile)
            ? 'Pro — tap to see what’s included.'
            : `Record a thought; it’s typed up and saved to ${DESTINATION_LABELS[notesDestination()]}.`;
    }
}

modeButtons.morning?.addEventListener('click', () => startSync('morning'));
modeButtons.evening?.addEventListener('click', () => startSync('evening'));
modeButtons.journal?.addEventListener('click', () => startSync('journal'));

// --------------------------------------------------------------------------
// VOICE NOTE (B-29, UX 9)
// --------------------------------------------------------------------------
let mediaRecorder = null;
let audioChunks = [];
let audioStream = null;
let recordingStartedAt = 0;
let recordingTimer = null;
let discardRecording = false;

function setVoiceUi(recording) {
    const btn = modeButtons.voice_note;
    $('voice-note-icon').innerHTML = icon(recording ? 'circle-x' : 'mic');
    $('voice-note-label').textContent = recording ? 'Stop recording' : 'Voice note';
    $('voice-recording-pulse')?.classList.toggle('hidden', !recording);
    btn?.classList.toggle('ring-2', recording);
    btn?.classList.toggle('ring-danger', recording);
    btn?.setAttribute('aria-pressed', recording ? 'true' : 'false');
}

function stopRecording({ discard = false } = {}) {
    clearInterval(recordingTimer);
    recordingTimer = null;
    discardRecording = discard;
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        try { mediaRecorder.stop(); } catch (_) { /* already stopped */ }
    }
    if (audioStream) {
        audioStream.getTracks().forEach(track => track.stop());
        audioStream = null;
    }
    if (isRecording) {
        isRecording = false;
        setVoiceUi(false);
        setBusy();
        updateDashButtons();
    }
}

modeButtons.voice_note?.addEventListener('click', async () => {
    if (isRecording) {
        stopRecording();
        return;
    }
    if (isSyncing) return;
    if (currentTier() !== 'pro') {
        openUpgradeFlow({ outcome: 'advanced', context: 'Voice notes are part of Pro. Record a thought and it’s typed up and saved to your Drive or Notion.' });
        return;
    }
    if (notesDestination() === 'notion' && !hasNotionConfigured()) {
        openNotionSetup('You chose Notion for voice notes. Connect it once, then record.');
        return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        renderCard({ tone: 'error', title: 'Recording isn’t supported here', lines: ['Try the latest Chrome or Safari.'] });
        return;
    }
    try {
        audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(audioStream);
        audioChunks = [];
        discardRecording = false;

        mediaRecorder.addEventListener('dataavailable', event => {
            if (event.data.size > 0) audioChunks.push(event.data);
        });

        mediaRecorder.addEventListener('stop', () => {
            const duration = Date.now() - recordingStartedAt;
            const audioBlob = new Blob(audioChunks, { type: mediaRecorder?.mimeType || 'audio/mp4' });
            audioChunks = [];
            if (discardRecording) return;
            if (audioBlob.size === 0 || duration < MIN_RECORDING_MS) {
                renderCard({ tone: 'info', title: 'That recording was too short', lines: ['Hold on a little longer and try again.'], note: 'No credit used' });
                return;
            }
            const reader = new FileReader();
            reader.onloadend = () => {
                lastVoicePayload = reader.result;
                startSync('voice_note');
            };
            reader.readAsDataURL(audioBlob);
        });

        mediaRecorder.start();
        recordingStartedAt = Date.now();
        isRecording = true;
        setBusy();
        setVoiceUi(true);
        clearStatus();
        updateDashButtons();
        recordingTimer = setInterval(() => {
            const elapsed = Date.now() - recordingStartedAt;
            const s = Math.floor(elapsed / 1000);
            const desc = $('voice-note-desc');
            if (desc) desc.textContent = `Recording ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} / 5:00 — tap to stop`;
            if (elapsed >= MAX_RECORDING_MS) stopRecording();
        }, 500);
    } catch (err) {
        console.error('Microphone access denied:', err);
        if (audioStream) { audioStream.getTracks().forEach(t => t.stop()); audioStream = null; }
        renderCard({ tone: 'error', title: 'Microphone not available', lines: ['Allow microphone access for this site, then try again.'] });
    }
});

// --------------------------------------------------------------------------
// SYNC (B-02, B-03, B-16, C1, C3, C4, C5, C7, UX 5–8)
// --------------------------------------------------------------------------
const PROGRESS_STEPS = {
    morning: [[0, 'Reading your handwriting…'], [8000, 'Finding events and to-dos…'], [18000, 'Adding them to Google Calendar & Tasks…'], [35000, 'Almost there…']],
    evening: [[0, 'Reading your handwriting…'], [8000, 'Spotting finished tasks, expenses and health notes…'], [18000, 'Updating Google Tasks and your Sheets log…'], [35000, 'Almost there…']],
    journal: [[0, 'Reading your journal pages…'], [12000, 'Saving them to {where}…'], [35000, 'Almost there…']],
    voice_note: [[0, 'Uploading your voice note…'], [5000, 'Typing it up…'], [18000, 'Saving it to {where}…'], [35000, 'Almost there…']],
};
let progressTimers = [];
const setLoaderText = (text) => { const el = $('dash-loader-text'); if (el) el.textContent = text; };
const startProgress = (mode) => {
    stopProgress();
    const loader = $('dash-loader');
    loader?.classList.remove('hidden');
    loader?.classList.add('flex');
    const where = DESTINATION_LABELS[notesDestination()];
    (PROGRESS_STEPS[mode] || PROGRESS_STEPS.morning).forEach(([t, msg]) => {
        progressTimers.push(setTimeout(() => setLoaderText(msg.replace('{where}', where)), t));
    });
    progressTimers.push(setTimeout(() => setLoaderText('Taking longer than usual — keep this tab open.'), 60000));
};
const stopProgress = () => {
    progressTimers.forEach(clearTimeout);
    progressTimers = [];
    const loader = $('dash-loader');
    loader?.classList.add('hidden');
    loader?.classList.remove('flex');
};

const imagesSignature = (imgs) => imgs.map(s => `${s.length}:${s.slice(-48)}`).join('|');
const requestIdFor = (mode, imgs) => {
    const sig = imagesSignature(imgs);
    if (lastAttempt && lastAttempt.mode === mode && lastAttempt.sig === sig) return lastAttempt.id;
    lastAttempt = { id: generateClientRequestId(), mode, sig };
    return lastAttempt.id;
};

/**
 * Entry point for every user-initiated sync. Runs its checks synchronously so
 * that, when a Google popup is needed, it opens inside the click gesture.
 */
function startSync(modeInput, { tokenPromise = null } = {}) {
    const mode = normalizeSyncMode(modeInput);
    if (isSyncing) return;
    if (!auth.currentUser) {
        renderCard({ tone: 'error', title: 'Please sign in again', lines: ['Your session ended.'] });
        return;
    }
    const isVoice = mode === 'voice_note';
    const images = isVoice ? (lastVoicePayload ? [lastVoicePayload] : []) : filesAsBase64.slice();
    if (!images.length) {
        renderCard({ tone: 'info', title: isVoice ? 'Record a voice note first' : 'Add a page photo first', lines: [] });
        return;
    }

    const dest = notesDestination();
    if (needsNotion(mode, dest) && userProfile && !hasNotionConfigured()) {
        openNotionSetup(mode === 'journal'
            ? 'You chose Notion for journal pages. Connect it once — your photos stay on the dashboard. (Or switch to Google Drive in Settings.)'
            : 'You chose Notion for voice notes. Connect it once, then try again.');
        return;
    }

    // B-05: per-mode page limit enforced at click time
    const tier = currentTier();
    const limit = pageLimitFor(tier, mode);
    if (!isVoice && images.length > limit) {
        const extra = images.length - limit;
        renderCard({
            tone: 'info',
            title: `${SYNC_MODES[mode].label} takes ${limit} page${limit === 1 ? '' : 's'} on your plan`,
            lines: [`Remove ${extra} page${extra === 1 ? '' : 's'}${tier === 'standard' ? ', use Journal (up to 3 pages),' : ''} or upgrade for bigger batches.`],
            actions: [{ label: 'See plans', onClick: () => openUpgradeFlow({ outcome: 'batch' }) }],
        });
        return;
    }

    // B-02 / B-21: proactively refresh an expiring Google token inside the click gesture
    let pendingToken = tokenPromise;
    if (!pendingToken && needsGoogleToken(mode, dest) && !isTokenFresh(googleTokenExpiresAt)) {
        pendingToken = reconnectGoogle();
        pendingToken.catch(() => { /* handled in runSync */ });
    }

    const clientRequestId = requestIdFor(mode, images);
    runSync({ mode, images, clientRequestId, tokenPromise: pendingToken });
}

const postSync = async ({ idToken, googleToken, mode, images, clientRequestId }) => {
    const { PRIMARY_API_URL } = getApiUrls(window.location.hostname, 'syncPlanner');
    let timeZone = 'Asia/Kolkata';
    try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || timeZone; } catch (_) { /* default */ }
    const headers = { 'Content-Type': 'application/json', ...buildByokHeaders(readByokSession(window.sessionStorage)) };
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 310000); // function timeout is 300 s
    try {
        const res = await apiFetch(PRIMARY_API_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify({ idToken, googleToken, images, syncType: mode, timeZone, clientRequestId }),
            signal: controller.signal,
        });
        try {
            const data = await parseJsonResponse(res);
            return { res, data };
        } catch (parseErr) {
            return { res, data: null, error: parseErr };
        }
    } finally {
        clearTimeout(timeoutId);
    }
};

async function runSync({ mode, images, clientRequestId, tokenPromise }) {
    isSyncing = true;
    setBusy();
    updateDashButtons();
    renderThumbnails();
    clearStatus();
    startProgress(mode);
    const isVoice = mode === 'voice_note';

    try {
        let googleToken = null;
        if (needsGoogleToken(mode, notesDestination())) {
            if (tokenPromise) {
                setLoaderText('Waiting for Google sign-in…');
                try {
                    googleToken = await tokenPromise;
                } catch (authErr) {
                    stopProgress();
                    renderGoogleReconnectCard({ mode, images, clientRequestId, authErr });
                    return;
                }
                startProgress(mode);
            } else {
                googleToken = googleAccessToken;
            }
        }

        let idToken = await auth.currentUser.getIdToken();
        let attempt = 0;
        let outcome;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            outcome = await postSync({ idToken, googleToken, mode, images, clientRequestId });
            const status = outcome.res?.status;
            const code = outcome.data?.errorCode;
            if (status === 401 && attempt === 0) {
                if (code === 'AUTH_INVALID') {
                    attempt++;
                    idToken = await auth.currentUser.getIdToken(true);
                    continue;
                }
                if (code === 'GOOGLE_TOKEN_EXPIRED' && isNativeWebView) {
                    attempt++;
                    setLoaderText('Refreshing your Google connection…');
                    const fresh = await requestNativeTokenRefresh(15000);
                    if (fresh) {
                        googleToken = fresh;
                        continue;
                    }
                }
                if (code === 'GOOGLE_TOKEN_EXPIRED') setGoogleToken(null);
            }
            break;
        }

        stopProgress();
        const { res, data, error } = outcome;
        if (res && res.ok && data) {
            renderSyncSuccess({ mode, data, pages: images.length });
            if (isVoice) lastVoicePayload = null;
            else if (imagesSignature(filesAsBase64) === imagesSignature(images)) {
                filesAsBase64 = []; // B-16: only clear the photos after a success that used them
            }
            lastAttempt = null;
            if (currentUser) loadSyncHistory(currentUser.email);
        } else {
            const info = describeApiError({ status: res?.status, data: data || {}, error });
            renderSyncError({ info, data: data || {}, mode, images, clientRequestId });
        }
    } catch (err) {
        console.error('Sync failed:', err);
        stopProgress();
        const info = describeApiError({ error: err });
        renderSyncError({ info, data: {}, mode, images, clientRequestId });
    } finally {
        stopProgress();
        isSyncing = false;
        setBusy();
        renderThumbnails();
        updateDashButtons();
    }
}

function renderGoogleReconnectCard({ mode, images, clientRequestId, authErr }) {
    const dismissed = isPopupDismissed(authErr?.code);
    renderCard({
        tone: 'error',
        title: 'Google needs to reconnect',
        lines: [dismissed
            ? 'The Google window was closed before access was granted. Calendar and Tasks need it to sync.'
            : (authErr?.code ? friendlyAuthError(authErr) : (authErr?.message || 'Your Google connection expired.'))],
        note: 'No credit used',
        actions: [reconnectAction({ mode, images, clientRequestId })],
    });
}

const reconnectAction = ({ mode, images, clientRequestId }) => ({
    label: 'Reconnect Google',
    primary: true,
    id: 'reconnect-google-btn',
    onClick: () => {
        if (isSyncing) return;
        // Popup opens synchronously inside this click (B-21).
        const tokenPromise = reconnectGoogle();
        tokenPromise.catch(() => { /* surfaced by runSync */ });
        runSync({ mode, images, clientRequestId, tokenPromise });
    },
});

const SAFE_LINK = {
    drive: /^https:\/\/drive\.google\.com\//,
    notion: /^https:\/\/(www\.)?notion\.so\//,
};
const openLinksFor = (mode, data = {}) => {
    const links = (data && typeof data.links === 'object' && data.links) || {};
    const out = [];
    if (mode === 'morning') {
        out.push({ label: 'Open Calendar', href: 'https://calendar.google.com/calendar/r' }, { label: 'Open Tasks', href: 'https://tasks.google.com/' });
    } else if (mode === 'evening') {
        out.push({ label: 'Open Tasks', href: 'https://tasks.google.com/' });
    }
    if (typeof links.drive === 'string' && SAFE_LINK.drive.test(links.drive)) out.push({ label: 'Open in Drive', href: links.drive });
    else if (typeof links.notion === 'string' && SAFE_LINK.notion.test(links.notion)) out.push({ label: 'Open in Notion', href: links.notion });
    else if (mode === 'journal' || mode === 'voice_note') {
        out.push(data.savedTo === 'drive'
            ? { label: 'Open Drive', href: 'https://drive.google.com/drive/my-drive' }
            : { label: 'Open Notion', href: 'https://www.notion.so/' });
    }
    return out.slice(0, 3);
};

const clean = (arr) => (Array.isArray(arr) ? arr.filter(x => typeof x === 'string' && x.trim()) : []);

/** "9:00 AM Team call" from { title, start } (start is local, no offset). */
const describeEvent = (ev) => {
    const title = typeof ev?.title === 'string' ? ev.title : '';
    const m = typeof ev?.start === 'string' && ev.start.match(/T(\d{2}):(\d{2})/);
    if (!m) return title;
    const h = Number(m[1]);
    const time = `${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
    return title ? `${time} ${title}` : time;
};

function renderSyncSuccess({ mode, data, pages }) {
    const summary = summarizeCounts(data.counts, { savedTo: data.savedTo });
    // One summary line; the server's longer `text` would only repeat it (UX audit #4).
    const lines = [summary || (data.duplicate ? 'This page was already synced.' : 'Nothing new to add from this page.')];
    // Skip notes that only repeat the summary ("Brain dump saved to Google Drive.").
    const said = (summary || '').toLowerCase();
    lines.push(...clean(data.notes).filter(note => !said.includes(note.toLowerCase().replace(/[.!]+$/, ''))));
    const items = data.items && typeof data.items === 'object' ? data.items : {};
    const added = [
        ...(Array.isArray(items.events) ? items.events.map(describeEvent) : []),
        ...clean(items.tasks),
    ].filter(Boolean).slice(0, 8);
    const warnings = clean(data.warnings);
    const streak = userProfile ? computeDisplayStreak(userProfile) : 0;
    const where = data.savedTo ? DESTINATION_LABELS[data.savedTo] : '';
    const titles = {
        morning: 'Added to Calendar and Tasks',
        evening: 'Evening review saved',
        journal: where ? `Saved to ${where}` : 'Journal saved',
        voice_note: where ? `Voice note saved to ${where}` : 'Voice note saved',
    };
    lines.push(...warnings.map(w => `Please review: ${w}`));
    renderCard({
        tone: 'success',
        title: data.duplicate ? `Already synced — ${SYNC_MODES[mode].label}` : (titles[mode] || 'Synced'),
        lines,
        list: added,
        note: [
            creditNoteForSuccess(data, { byok: usingByok() }),
            streak > 0 ? `Day ${streak} streak` : '',
        ].filter(Boolean).join(' · '),
        actions: openLinksFor(mode, data),
    });
    void pages;
}

function renderSyncError({ info, data, mode, images, clientRequestId }) {
    if (info.kind === 'processing') {
        renderCard({
            tone: 'processing',
            title: 'Still processing',
            lines: [info.message, 'Your photos are kept here. Syncing them again right away could create duplicates.'],
            actions: [{
                label: 'Open History', primary: true, onClick: () => {
                    switchView('view-history');
                    if (currentUser) loadSyncHistory(currentUser.email);
                }
            }],
        });
        return;
    }

    const actions = [];
    if (info.needsGoogleReconnect) {
        actions.push(reconnectAction({ mode, images, clientRequestId }));
    } else if (info.errorCode === 'NOTION_NOT_CONFIGURED') {
        actions.push({ label: 'Connect Notion', primary: true, onClick: () => openNotionSetup('Connect Notion, then sync again — your photos stay on the dashboard.') });
        actions.push({ label: 'Use Google Drive', onClick: async () => { if (await saveNotesDestination('drive', { quiet: true })) clearStatus(); } });
    } else if (info.errorCode === 'BYOK_INVALID') {
        actions.push({ label: 'Check AI key', primary: true, onClick: () => { restoreByokUi(); switchView('view-setup'); } });
        if (hasStoredByok() || hasSessionByok()) {
            actions.push({
                label: 'Use credits instead', onClick: async () => {
                    clearByokSession(window.sessionStorage, window.localStorage);
                    if (hasStoredByok()) await deleteStoredByok();
                    restoreByokUi();
                    updateDashButtons();
                    clearStatus();
                }
            });
        }
    } else if (info.errorCode === 'AUTH_INVALID') {
        actions.push({ label: 'Sign in again', primary: true, onClick: () => signOutUser() });
    } else if (info.showUpgrade) {
        actions.push({ label: 'See plans', primary: true, onClick: () => openUpgradeFlow({ outcome: info.errorCode === 'INSUFFICIENT_CREDITS' ? 'automation' : (mode === 'voice_note' ? 'advanced' : 'batch'), context: info.message }) });
    }
    if (info.retryable) {
        actions.unshift({
            label: 'Retry', primary: actions.length === 0, id: 'sync-retry-btn', onClick: () => {
                if (isSyncing) return;
                // Retry keeps the same clientRequestId (C4) so the server can de-duplicate.
                let tokenPromise = null;
                if (needsGoogleToken(mode, notesDestination()) && !isTokenFresh(googleTokenExpiresAt)) {
                    tokenPromise = reconnectGoogle();
                    tokenPromise.catch(() => { /* surfaced by runSync */ });
                }
                runSync({ mode, images, clientRequestId, tokenPromise });
            }
        });
    }

    renderCard({
        tone: 'error',
        title: 'Sync didn’t finish',
        lines: [info.message, mode === 'voice_note' ? '' : 'Your photos are still here.'],
        note: creditNoteForError(data, images.length),
        actions,
    });

    // C3: the upgrade modal opens automatically only for these codes.
    if (info.showUpgrade) {
        openUpgradeFlow({
            outcome: info.errorCode === 'INSUFFICIENT_CREDITS' ? 'automation' : (mode === 'voice_note' ? 'advanced' : 'batch'),
            context: info.message,
        });
    }
}

// --------------------------------------------------------------------------
// GDPR: Export & Delete
// --------------------------------------------------------------------------
async function exportMyData() {
    try {
        if (!auth.currentUser) { showActionableError({ title: 'Please sign in first', summary: 'Sign in to export your data.' }); return; }
        const token = await auth.currentUser.getIdToken();
        const res = await apiFetch('/exportUserData', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
        });
        if (!res.ok) {
            const apiErr = await readApiError(res);
            showActionableError({ title: 'Export failed', summary: describeApiError({ status: res.status, data: apiErr.data || {} }).message, details: apiErr.details });
            return;
        }
        const data = await parseJsonResponse(res);
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ai-planner-data-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000); // B-32: Safari needs the URL alive after click()
    } catch (err) {
        console.error("Export error:", err);
        showActionableError({ title: 'Export failed', summary: 'Check your connection and try again.', details: err?.message });
    }
}

/**
 * Recent-login check for sensitive actions (401 REAUTH_REQUIRED). Must be the
 * first await inside a click handler so the Google popup isn't blocked.
 */
const reauthenticateUser = async () => {
    const user = auth.currentUser;
    if (!user) throw Object.assign(new Error('Please sign in again.'), { code: 'auth/no-current-user' });
    if (isNativeWebView) {
        const accessToken = await requestNativeTokenRefresh(15000);
        if (!accessToken) throw Object.assign(new Error('Could not confirm your Google account. Please try again.'), { code: 'native/refresh-timeout' });
        await reauthenticateWithCredential(user, GoogleAuthProvider.credential(null, accessToken));
    } else {
        const result = await reauthenticateWithPopup(user, buildGoogleProvider({ loginHint: user.email }));
        captureGoogleCredential(result);
    }
    return user.getIdToken(true);
};

async function performAccountDeletion(freshIdToken = null) {
    try {
        if (!auth.currentUser) { showActionableError({ title: 'Please sign in first', summary: 'Sign in to delete your account.' }); return; }
        await revokeLegacyByokCookie();
        clearByokSession(window.sessionStorage, window.localStorage);
        const token = freshIdToken || await auth.currentUser.getIdToken();
        const res = await apiFetch('/deleteUserAccount', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
        });
        if (!res.ok) {
            const apiErr = await readApiError(res);
            const info = describeApiError({ status: res.status, data: apiErr.data || {} });
            if (info.errorCode === 'REAUTH_REQUIRED' && !freshIdToken) {
                // Ask for a fresh Google confirmation from a real click, then retry.
                switchView('view-dashboard');
                renderCard({
                    tone: 'error',
                    title: 'Confirm it’s you to delete your account',
                    lines: [info.message],
                    actions: [
                        {
                            label: 'Confirm with Google & delete', primary: true, id: 'reauth-delete-btn',
                            onClick: () => {
                                const tokenPromise = reauthenticateUser(); // popup opens inside this click
                                tokenPromise.then((idToken) => {
                                    clearStatus();
                                    return performAccountDeletion(idToken);
                                }).catch((err) => {
                                    if (isPopupDismissed(err?.code)) return;
                                    showActionableError({ title: 'Couldn’t confirm your account', summary: err?.code ? friendlyAuthError(err) : (err?.message || 'Please try again.') });
                                });
                            },
                        },
                        { label: 'Cancel', onClick: clearStatus },
                    ],
                });
                return;
            }
            showActionableError({ title: 'Couldn’t delete your account', summary: info.message, details: apiErr.details });
            return;
        }

        if (window.ReactNativeWebView) {
            window.ReactNativeWebView.postMessage('SIGNOUT');
        }
        await auth.signOut();
        showLoginError('');
        showActionableError({ title: 'Account deleted', summary: 'Your account data has been permanently deleted.' });
    } catch (err) {
        console.error("Delete error:", err);
        showActionableError({ title: 'Couldn’t delete your account', summary: 'Check your connection and try again.', details: err?.message });
    }
}

async function deleteMyAccount() {
    const confirmed = window.confirm(
        "Delete your account?\n\n" +
        "This permanently deletes your profile, sync history, and saved Notion and AI keys.\n\n" +
        "This action cannot be undone."
    );
    if (!confirmed) return;
    if (!window.confirm("Are you absolutely sure? This is permanent.")) return;
    await performAccountDeletion();
}

// --------------------------------------------------------------------------
// OUTCOME-FIRST UPGRADE FLOW
// --------------------------------------------------------------------------
const pricingModal = $('pricing-modal');
let pricingDeactivate = null;
const upgradeState = { outcome: null, plan: null, billing: 'annual' };
const upgradePrices = {
    standard: { monthly: 29, sprint: 79, annual: 290 },
    pro: { monthly: 49, sprint: 129, annual: 490 }
};

const showUpgradeStep = (step) => {
    [1, 2, 3].forEach(stepNumber => {
        $(`upgrade-step-${stepNumber}`)?.classList.toggle('hidden', stepNumber !== step);
        document.querySelector(`[data-upgrade-progress="${stepNumber}"]`)?.classList.toggle('upgrade-progress-active', stepNumber <= step);
    });
    $('payment-result')?.classList.add('hidden');
};

const recommendedPlanForOutcome = (outcome) => {
    if (outcome === 'advanced' || userProfile?.tier === 'standard') return 'pro';
    return 'standard';
};

const selectUpgradePlan = (plan) => {
    upgradeState.plan = plan;
    document.querySelectorAll('[data-upgrade-plan]').forEach(choice => {
        const selected = choice.dataset.upgradePlan === plan;
        choice.classList.toggle('upgrade-choice-selected', selected);
        choice.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    const nextButton = $('upgrade-next-plan');
    if (nextButton) nextButton.disabled = false;
    const annualPrice = $('annual-option-price');
    const monthlyPrice = $('monthly-option-price');
    const sprintPrice = $('sprint-option-price');
    if (annualPrice) annualPrice.textContent = `₹${upgradePrices[plan].annual}`;
    if (monthlyPrice) monthlyPrice.textContent = `₹${upgradePrices[plan].monthly}`;
    if (sprintPrice) sprintPrice.textContent = `₹${upgradePrices[plan].sprint}`;
};

const selectUpgradeOutcome = (outcome) => {
    upgradeState.outcome = outcome;
    document.querySelectorAll('[data-upgrade-outcome]').forEach(choice => {
        const selected = choice.dataset.upgradeOutcome === outcome;
        choice.classList.toggle('upgrade-choice-selected', selected);
        choice.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    const nextButton = $('upgrade-next-outcome');
    if (nextButton) nextButton.disabled = false;

    const recommendedPlan = recommendedPlanForOutcome(outcome);
    selectUpgradePlan(recommendedPlan);
    const recommendation = $('upgrade-recommendation');
    if (recommendation) {
        recommendation.textContent = recommendedPlan === 'pro'
            ? 'Pro is preselected for advanced workflows and larger batches.'
            : 'Standard is preselected for everyday planner automation.';
    }
};

const updateCheckoutReview = () => {
    if (!upgradeState.plan) return;
    const planLabel = upgradeState.plan === 'pro' ? 'Pro' : 'Standard';
    const billingLabels = { annual: 'Annual', sprint: '90 days', monthly: '30 days' };
    const price = upgradePrices[upgradeState.plan][upgradeState.billing];
    const creditCount = TIER_CREDITS[upgradeState.plan];
    const durationCopy = upgradeState.billing === 'annual'
        ? 'for 12 months'
        : upgradeState.billing === 'sprint' ? 'for 90 days' : 'for 30 days';

    const planName = $('checkout-plan-name');
    const planDetail = $('checkout-plan-detail');
    const planPrice = $('checkout-plan-price');
    const chargeCopy = $('checkout-charge-copy');
    const renewalCopy = $('checkout-renewal-copy');
    const checkoutButton = $('checkout-selected-plan-btn');
    if (planName) planName.textContent = `${planLabel} · ${billingLabels[upgradeState.billing]}`;
    if (planDetail) planDetail.textContent = `${creditCount} credits refresh every 30 days ${durationCopy}.`;
    if (planPrice) planPrice.textContent = `₹${price}`;
    if (chargeCopy) chargeCopy.textContent = `You pay ₹${price} once through Cashfree. This is not an auto-debit.`;
    if (renewalCopy) {
        renewalCopy.textContent = upgradeState.billing === 'monthly'
            ? 'This option lasts 30 days. Buy again only if you choose to continue.'
            : 'Your included credits refresh every 30 days while this access period is active.';
    }
    if (checkoutButton) checkoutButton.textContent = `Continue securely — ₹${price}`;
};

const showPricingModal = () => {
    if (!pricingModal) return;
    pricingModal.classList.remove('hidden');
    pricingModal.classList.add('flex');
    if (!pricingDeactivate) pricingDeactivate = activateDialog(pricingModal, closeUpgradeFlow, $('close-pricing'));
};

function openUpgradeFlow({ outcome = null, context = '' } = {}) {
    upgradeState.outcome = null;
    upgradeState.plan = null;
    upgradeState.billing = 'annual';
    const annualBilling = document.querySelector('input[name="upgrade-billing"][value="annual"]');
    if (annualBilling) annualBilling.checked = true;
    document.querySelectorAll('.upgrade-choice-selected').forEach(choice => choice.classList.remove('upgrade-choice-selected'));
    const nextOutcome = $('upgrade-next-outcome');
    const nextPlan = $('upgrade-next-plan');
    const contextMessage = $('upgrade-context-message');
    if (nextOutcome) nextOutcome.disabled = true;
    if (nextPlan) nextPlan.disabled = true;
    if (contextMessage) {
        contextMessage.textContent = context || 'Pick what you need, then see the plan that fits.';
    }
    if (outcome) selectUpgradeOutcome(outcome);
    showUpgradeStep(1);
    showPricingModal();
}

function closeUpgradeFlow() {
    pricingModal?.classList.add('hidden');
    pricingModal?.classList.remove('flex');
    if (pricingDeactivate) { pricingDeactivate(); pricingDeactivate = null; }
}

$('current-plan-badge')?.addEventListener('click', () => openUpgradeFlow());
$('close-pricing')?.addEventListener('click', closeUpgradeFlow);
pricingModal?.addEventListener('click', (e) => { if (e.target === pricingModal && !isPaying) closeUpgradeFlow(); });
document.querySelectorAll('[data-upgrade-outcome]').forEach(choice => {
    choice.addEventListener('click', () => selectUpgradeOutcome(choice.dataset.upgradeOutcome));
});
$('upgrade-next-outcome')?.addEventListener('click', () => showUpgradeStep(2));
$('upgrade-back-outcome')?.addEventListener('click', () => showUpgradeStep(1));
document.querySelectorAll('[data-upgrade-plan]').forEach(choice => {
    choice.addEventListener('click', () => selectUpgradePlan(choice.dataset.upgradePlan));
});
document.querySelectorAll('input[name="upgrade-billing"]').forEach(option => {
    option.addEventListener('change', () => {
        upgradeState.billing = option.value;
        updateCheckoutReview();
    });
});
$('upgrade-next-plan')?.addEventListener('click', () => {
    updateCheckoutReview();
    showUpgradeStep(3);
});
$('upgrade-back-plan')?.addEventListener('click', () => showUpgradeStep(2));
$('step-nav-1')?.addEventListener('click', () => showUpgradeStep(1));
$('step-nav-2')?.addEventListener('click', () => {
    if (upgradeState.outcome) showUpgradeStep(2);
});
$('step-nav-3')?.addEventListener('click', () => {
    if (upgradeState.outcome && upgradeState.plan) {
        updateCheckoutReview();
        showUpgradeStep(3);
    }
});

// --- NAME (editable from the menu) ---
$('save-name-btn')?.addEventListener('click', async () => {
    const nameInput = $('user-display-name-input');
    const name = nameInput.value.trim();
    if (!name) {
        showFieldError('name-error', 'Enter a name.');
        nameInput.focus();
        return;
    }
    const btn = $('save-name-btn');
    btn.disabled = true;
    showSettingsStatus('name-status', '');
    try {
        if (!auth.currentUser) throw new Error('signed out');
        const idToken = await auth.currentUser.getIdToken();
        const res = await apiFetch('/updateProfile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken, updates: { displayName: name } })
        });
        if (!res.ok) {
            const apiErr = await readApiError(res);
            showFieldError('name-error', describeApiError({ status: res.status, data: apiErr.data || {} }).message);
            return;
        }
        setGreeting(name);
        showSettingsStatus('name-status', 'Saved.');
    } catch (e) {
        console.error('Failed to save name:', e);
        showFieldError('name-error', 'Couldn’t save your name. Check your connection and try again.');
    } finally {
        btn.disabled = false;
    }
});

// --------------------------------------------------------------------------
// REPORTS HEATMAP (B-22: user's time zone)
// --------------------------------------------------------------------------
const loadHeatmap = async (email) => {
    const heatmapGrid = $('heatmap-grid');
    if (!heatmapGrid) return;
    heatmapGrid.innerHTML = '<div class="w-full flex justify-center py-4" role="status"><div class="spinner" aria-hidden="true"></div><span class="sr-only">Loading your last 30 days</span></div>';
    const setTotal = (id, value) => { const el = $(id); if (el) el.textContent = value; };
    try {
        const { db, collection, query, where, getDocs } = await loadDb();
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 31);
        const snap = await getDocs(query(
            collection(db, "users", email, "syncHistory"),
            where("timestamp", ">=", thirtyDaysAgo)
        ));
        const dates = [];
        // What the user actually got done in the last 30 days (UX audit #7).
        const totals = { pages: 0, events: 0, tasks: 0, done: 0 };
        snap.forEach(d => {
            const data = d.data();
            if (data.status !== 'success' || !data.timestamp) return;
            dates.push(data.timestamp.toDate());
            const c = data.counts || {};
            const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
            if (data.syncType !== 'voice_note') totals.pages += n(Number(data.imageCount)) || 1;
            totals.events += n(c.events);
            totals.tasks += n(c.tasks);
            totals.done += n(c.completedTasks);
        });
        setTotal('reports-pages', totals.pages);
        setTotal('reports-events', totals.events);
        setTotal('reports-tasks', totals.tasks);
        setTotal('reports-done', totals.done);
        let timeZone = userProfile?.timeZone;
        try { timeZone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { /* fallback below */ }
        const days = buildHeatmapDays(dates, timeZone || 'UTC');
        const boxes = days.map(({ date, count }) => {
            const level = count >= 3 ? 3 : count;
            const label = `${date}: ${count} sync${count === 1 ? '' : 's'}`;
            return `<div role="img" aria-label="${label}" title="${label}" class="heat-cell${level ? ` heat-cell-${level}` : ''}"></div>`;
        });
        heatmapGrid.innerHTML = boxes.join('');
    } catch (err) {
        console.error(err);
        ['reports-pages', 'reports-events', 'reports-tasks', 'reports-done'].forEach(id => setTotal(id, '—'));
        heatmapGrid.innerHTML = '<div class="text-sm text-danger w-full">Couldn’t load your last 30 days. Check your connection and try again.</div>';
    }
};

// --------------------------------------------------------------------------
// PAYMENTS (S-08, B-17, UX 12)
// --------------------------------------------------------------------------
const collectPhoneNumber = () => {
    return new Promise((resolve, reject) => {
        const modal = $('phone-modal');
        const content = $('phone-modal-content');
        const form = $('phone-form');
        const closeBtn = $('close-phone-modal');
        const phoneInput = $('user-phone');
        let deactivate = null;

        modal.classList.remove('hidden');
        modal.classList.add('flex');
        showFieldError('phone-error', '');
        setTimeout(() => {
            content.classList.remove('scale-95', 'opacity-0');
            content.classList.add('scale-100', 'opacity-100');
        }, 10);

        const cleanup = () => {
            content.classList.add('scale-95', 'opacity-0');
            content.classList.remove('scale-100', 'opacity-100');
            setTimeout(() => {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }, 300);
            form.removeEventListener('submit', onSubmit);
            closeBtn.removeEventListener('click', onCancel);
            if (deactivate) deactivate();
        };

        const onSubmit = (e) => {
            e.preventDefault();
            const phone = phoneInput.value.trim();
            if (/^[6-9]\d{9}$/.test(phone)) {
                cleanup();
                resolve(phone);
            } else {
                $('phone-error').textContent = 'Enter a 10-digit Indian mobile number starting with 6–9.';
                $('phone-error').classList.remove('hidden');
                phoneInput.focus();
            }
        };

        const onCancel = () => {
            cleanup();
            reject(new Error("Payment cancelled by user."));
        };

        form.addEventListener('submit', onSubmit);
        closeBtn.addEventListener('click', onCancel);
        deactivate = activateDialog(modal, onCancel, phoneInput);
    });
};

const showPaymentResult = ({ iconName = 'circle-check', title, text }) => {
    showPricingModal();
    [1, 2, 3].forEach(n => $(`upgrade-step-${n}`)?.classList.add('hidden'));
    const panel = $('payment-result');
    panel?.classList.remove('hidden');
    $('payment-result-icon').innerHTML = `<span class="mode-icon w-14 h-14 rounded-2xl bg-signal-soft text-signal-ink">${icon(iconName, 'icon-lg')}</span>`;
    $('payment-result-title').textContent = title;
    $('payment-result-text').textContent = text || '';
    setTimeout(() => $('payment-result-close')?.focus(), 0);
};
$('payment-result-close')?.addEventListener('click', closeUpgradeFlow);

const creditTotal = (p) => (p?.tierCredits || 0) + (p?.boosterCredits || 0);

function checkPendingPayment(profile) {
    if (!pendingPayment || !pendingPayment.confirmedByGateway) return;
    const { before, kind } = pendingPayment;
    const tierChanged = profile.tier && profile.tier !== before.tier;
    const creditsUp = creditTotal(profile) > before.credits;
    const expiryChanged = (profile.subscriptionExpiryDate || null) !== before.expiry;
    if (!(tierChanged || creditsUp || expiryChanged)) return;
    clearTimeout(pendingPayment.timer);
    pendingPayment = null;
    const total = creditTotal(profile);
    if (kind === 'booster') {
        showPaymentResult({ iconName: 'coins', title: `Credits added · ${total} available`, text: 'Thanks! Your booster credits are ready to use.' });
    } else {
        const label = profile.tier === 'pro' ? 'Pro' : profile.tier === 'standard' ? 'Standard' : 'Your plan';
        showPaymentResult({ iconName: 'circle-check', title: `${label} active · ${total} credits`, text: 'Thanks! Everything in your plan is unlocked now.' });
    }
}

const handlePaymentClick = async (e, basePrice, kind) => {
    const btn = e.currentTarget;
    const origText = btn.innerHTML;
    if (btn.disabled || isPaying) return;

    try {
        if (!currentUser) throw new Error("Please sign in to upgrade.");

        const phoneNumber = await collectPhoneNumber();

        isPaying = true;
        setBusy();
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner w-4 h-4 border-white mr-2" aria-hidden="true"></span> Opening secure checkout…';

        // S-08: the Cashfree SDK is only loaded once a checkout actually starts.
        const sdkReady = loadScriptOnce(CASHFREE_SDK_SRC);
        sdkReady.catch(() => { /* surfaced below */ });

        const freshIdToken = await auth.currentUser.getIdToken();
        const response = await apiFetch('/createCashfreeOrder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken: freshIdToken, price: basePrice, phone: phoneNumber })
        });
        let data = {};
        try { data = await parseJsonResponse(response); } catch (_) { data = {}; }
        if (!response.ok || !data.payment_session_id) {
            throw new Error(describeApiError({ status: response.status, data }).message || "Couldn’t start the payment.");
        }
        if (!['production', 'sandbox'].includes(data.payment_environment)) {
            throw new Error("Payment environment was not provided by the server.");
        }

        await sdkReady;
        if (typeof window.Cashfree !== 'function') throw new Error('The payment window couldn’t load. Check your connection and try again.');
        const cashfree = await window.Cashfree({ mode: data.payment_environment });

        pendingPayment = {
            kind,
            before: {
                tier: userProfile?.tier || 'free',
                credits: creditTotal(userProfile),
                expiry: userProfile?.subscriptionExpiryDate || null,
            },
            confirmedByGateway: false,
            timer: null,
        };

        const result = await cashfree.checkout({
            paymentSessionId: data.payment_session_id,
            redirectTarget: "_modal"
        });

        if (result?.error) {
            pendingPayment = null;
            showPaymentResult({
                iconName: 'rotate-ccw',
                title: 'Payment not completed',
                text: result.error.message ? `${result.error.message} You have not been charged.` : 'You have not been charged. You can try again any time.',
            });
        } else if (result?.paymentDetails || !result?.redirect) {
            pendingPayment.confirmedByGateway = true;
            showPaymentResult({ iconName: 'hourglass', title: 'Payment received', text: 'Activating your purchase… this usually takes a few seconds.' });
            pendingPayment.timer = setTimeout(() => {
                if (!pendingPayment) return;
                pendingPayment = null;
                showPaymentResult({ iconName: 'circle-check', title: 'Payment received', text: 'Your plan will update shortly. If it hasn’t in a few minutes, reload the page or contact support.' });
            }, 60000);
            if (userProfile) checkPendingPayment(userProfile);
        }
    } catch (err) {
        if (err.message !== "Payment cancelled by user.") {
            console.error("Payment error:", err);
            showActionableError({ title: 'Payment couldn’t start', summary: err.message || 'Please try again.', details: '' });
        }
    } finally {
        isPaying = false;
        setBusy();
        btn.innerHTML = origText;
        btn.disabled = false;
        const phoneInput = $('user-phone');
        if (phoneInput) phoneInput.value = ''; // Zero-storage
    }
};

$('buy-booster-btn')?.addEventListener('click', (e) => handlePaymentClick(e, 19, 'booster'));
$('buy-booster-btn-modal')?.addEventListener('click', (e) => handlePaymentClick(e, 19, 'booster'));
$('checkout-selected-plan-btn')?.addEventListener('click', (e) => {
    if (!upgradeState.plan) return;
    const price = upgradePrices[upgradeState.plan][upgradeState.billing];
    handlePaymentClick(e, price, 'plan');
});

// --------------------------------------------------------------------------
// HISTORY
// --------------------------------------------------------------------------
const HISTORY_TYPES = {
    morning: ['sun', 'Morning plan'],
    evening: ['moon', 'Evening review'],
    night: ['moon', 'Evening review'],
    journal: ['book-open', 'Journal'],
    voice_note: ['mic', 'Voice note'],
};
const escapeHTML = str => String(str ?? '').replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag]));

const loadSyncHistory = async (email) => {
    const historyList = $('history-list');
    if (!historyList) return;
    try {
        historyList.innerHTML = '<div class="flex justify-center py-6" role="status"><div class="spinner" aria-hidden="true"></div><span class="sr-only">Loading history</span></div>';
        const { db, collection, query, orderBy, limit, getDocs } = await loadDb();
        // Never leave an endless spinner: give up after 15 s and offer a retry.
        const querySnapshot = await Promise.race([
            getDocs(query(
                collection(db, "users", email, "syncHistory"),
                orderBy("timestamp", "desc"),
                limit(10)
            )),
            new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('History took too long to load.'), { code: 'timeout' })), 15000)),
        ]);

        if (querySnapshot.empty) {
            historyList.innerHTML = '<div class="card p-6 text-center text-muted">No syncs yet. Your synced pages will show up here.</div>';
            return;
        }

        let html = '';
        querySnapshot.forEach((doc) => {
            const data = doc.data();
            const d = data.timestamp ? data.timestamp.toDate() : new Date();
            const timeString = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            const [typeIcon, typeLabel] = HISTORY_TYPES[data.syncType] || ['file-text', 'Sync'];
            // C11: interrupted syncs (failed + failureReason 'interrupted') read "Interrupted — credit refunded".
            const { state, message } = describeHistoryEntry(data);
            const statusColor = {
                success: 'text-signal-ink',
                pending: 'text-warning',
                interrupted: 'text-warning',
                failed: 'text-danger',
            }[state];
            const statusIcon = { success: 'circle-check', pending: 'hourglass', interrupted: 'rotate-ccw', failed: 'triangle-alert' }[state];
            const count = Number(data.imageCount) || 1;
            const unit = data.syncType === 'voice_note' ? 'recording' : (count === 1 ? 'page' : 'pages');

            html += `
                <div class="card p-4 flex justify-between items-start gap-3">
                    <div class="flex gap-3 min-w-0">
                        <span class="mode-icon bg-bg" aria-hidden="true">${icon(typeIcon)}</span>
                        <div class="min-w-0">
                            <p class="font-semibold text-ink">${escapeHTML(typeLabel)} <span class="text-sm font-normal text-muted">· ${count} ${unit}</span></p>
                            <p class="text-sm ${statusColor} flex items-start gap-1.5 mt-0.5">${icon(statusIcon, 'icon-sm mt-0.5')}<span>${escapeHTML(message)}</span></p>
                        </div>
                    </div>
                    <span class="text-xs text-muted text-right shrink-0">${escapeHTML(timeString)}</span>
                </div>
            `;
        });
        historyList.innerHTML = html;
    } catch (e) {
        console.error("Error loading history:", e);
        historyList.innerHTML = `
            <div class="text-center py-6 space-y-3" role="alert">
                <p class="text-sm text-danger">Couldn’t load your sync history. Check your connection and try again.</p>
                <button type="button" id="history-retry-btn" class="btn btn-secondary">Retry</button>
            </div>`;
        $('history-retry-btn')?.addEventListener('click', () => loadSyncHistory(email));
    }
};

// --------------------------------------------------------------------------
// THEME (B-30)
// --------------------------------------------------------------------------
const themeBtn = $('theme-btn');
const themeMenu = $('theme-dropdown');
const setThemeMenu = (open) => {
    themeMenu?.classList.toggle('active', open);
    themeBtn?.setAttribute('aria-expanded', open ? 'true' : 'false');
};
// After a pick, focus goes back to the theme button instead of a hidden menu item.
const closeThemeMenuAfterPick = () => { setThemeMenu(false); themeBtn?.focus(); };

themeBtn?.addEventListener('click', () => setThemeMenu(!themeMenu.classList.contains('active')));
themeMenu?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { setThemeMenu(false); themeBtn?.focus(); }
});
// Tabbing out of the menu closes it.
themeMenu?.addEventListener('focusout', (e) => {
    const next = e.relatedTarget;
    if (next && next !== themeBtn && !themeMenu.contains(next)) setThemeMenu(false);
});

document.querySelectorAll('.theme-item[data-theme]').forEach(item => {
    item.addEventListener('click', () => {
        const mode = item.dataset.theme;
        try { localStorage.setItem('theme', mode); } catch (_) { /* storage blocked */ }
        applyTheme(mode);
        closeThemeMenuAfterPick();
    });
});

document.addEventListener('click', (e) => {
    if (themeBtn && themeMenu && !themeBtn.contains(e.target) && !themeMenu.contains(e.target)) {
        setThemeMenu(false);
    }
});

function applyTheme(mode) {
    const html = document.documentElement;
    const items = document.querySelectorAll('.theme-item[data-theme]');
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyThemeHelper(mode, html, themeBtn, items, systemDark);
    window.ThemePacks?.syncThemeColor(document);
}

const savedTheme = () => {
    try { return localStorage.getItem('theme') || 'auto'; } catch (_) { return 'auto'; }
};
applyTheme(savedTheme());
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (savedTheme() === 'auto') applyTheme('auto');
});

// Style (theme packs, docs/THEMES.md): themes/packs.js has already applied the saved one.
const themePacks = window.ThemePacks;
const markSelectedStyle = () => {
    const current = document.documentElement.dataset.style;
    document.querySelectorAll('.theme-item[data-style-choice]').forEach((el) => {
        const selected = el.dataset.styleChoice === current;
        el.classList.toggle('selected', selected);
        el.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
};
if (themePacks) {
    const styleItems = $('style-items');
    themePacks.PACKS.forEach((pack) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'theme-item';
        item.dataset.styleChoice = pack.id;
        item.title = pack.description;
        const swatch = document.createElement('span');
        swatch.className = 'style-swatch';
        swatch.setAttribute('aria-hidden', 'true');
        pack.swatch.forEach((colour) => {
            const dot = document.createElement('span');
            dot.style.background = colour;
            swatch.append(dot);
        });
        const label = document.createElement('span');
        label.textContent = pack.label;
        item.append(swatch, label);
        item.addEventListener('click', () => {
            themePacks.setStyle(pack.id, document);
            markSelectedStyle();
            closeThemeMenuAfterPick();
        });
        styleItems?.append(item);
    });
    markSelectedStyle();
    window.addEventListener('storage', (e) => { if (themePacks.isStyleChange(e)) markSelectedStyle(); });
}

// Initial dashboard render (empty state) and periodic primary-mode refresh.
renderThumbnails();
setBusy();
setInterval(() => { if (!isSyncing) updateDashButtons(); }, 5 * 60 * 1000);

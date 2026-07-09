// AI Planner — Main Application Module
// Extracted from inline <script type="module"> for CSP compliance

import { computeDisplayStreak, normalizeSyncDateStr } from './streak-utils.js';

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-app.js";
import { getAuth, initializeAuth, inMemoryPersistence, GoogleAuthProvider, signInWithCredential, signInWithPopup, signInWithRedirect, getRedirectResult, connectAuthEmulator, signInWithEmailAndPassword, createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-auth.js";

// FIREBASE CONFIG
const firebaseConfig = {
    apiKey: "AIzaSyBRVEfF58gL3yxQ2UY-_lMgftPnFrZ0_T0",
    authDomain: "planner.analogdigital.tech",
    projectId: "ai-planner-project-467800",
    storageBucket: "ai-planner-project-467800.firebasestorage.app",
    messagingSenderId: "195957114195",
    appId: "1:195957114195:web:06bf15f172f55d2ff3cda6"
};

const app = initializeApp(firebaseConfig);
const isNativeWebView = !!window.ReactNativeWebView;



const auth = isNativeWebView
    ? initializeAuth(app, { persistence: inMemoryPersistence })
    : getAuth(app);

const postNativeMessage = (type, payload = {}) => {
    if (!window.ReactNativeWebView?.postMessage) return;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type, payload }));
};

// Bridge for native mobile login
window.mobileLogin = async (idToken, accessToken, pushToken) => {
    postNativeMessage('MOBILE_LOGIN_START');

    try {
        if (!idToken || !accessToken) {
            throw new Error("Native Google login did not provide the required tokens.");
        }

        const credential = GoogleAuthProvider.credential(idToken, accessToken);
        const result = await signInWithCredential(auth, credential);
        googleAccessToken = accessToken;
        
        // Save Push Token securely via backend
        if (pushToken && result.user) {
            try {
                const firebaseIdToken = await result.user.getIdToken();
                const pushRes = await fetch('/updateProfile', {
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
    } finally {
        // Security: Remove the bridge function after use to reduce XSS token exposure surface
        delete window.mobileLogin;
    }
};

if (window.location.hostname === "localhost" && window.location.search.includes("emulator=true")) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099");
    
    // Non-production test auth path for E2E Playwright tests
    window.e2eLogin = async (email, password) => {
        try {
            await signInWithEmailAndPassword(auth, email, password);
        } catch (e) {
            // Auto-provision the test user in the emulator if they don't exist
            if (e.code === 'auth/user-not-found' || e.code === 'auth/invalid-credential') {
                await createUserWithEmailAndPassword(auth, email, password);
            } else {
                throw e;
            }
        }
    };
}

// STATE
let currentUser = null;
let filesAsBase64 = []; // Array to store multiple images (max 5)
// Keep OAuth token only in memory (not session/local storage)
let googleAccessToken = null;
let profileUnsubscribe = null;
let userProfile = null;

const helpers = window.AppHelpers;
if (!helpers) {
    throw new Error("AppHelpers not loaded. Ensure app-helpers.js is included before app.js.");
}
const {
    parseJsonResponse,
    readApiError,
    showActionableError,
    getApiUrls,
    switchView: switchViewHelper,
    applyTheme: applyThemeHelper,
} = helpers;

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
            fetch(PRIMARY_API_URL, {
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

// Display a deterministic frontend build marker (derived from app.js?v=...)
// so support/debugging can immediately verify which bundle is live.
const setBuildVersionBadge = () => {
    const buildBadge = document.getElementById('build-version');
    if (!buildBadge) return;

    const appScript = Array.from(document.querySelectorAll('script[src]'))
        .find(el => /app\.js(\?|$)/.test(el.getAttribute('src') || ''));
    if (!appScript) return;

    const srcUrl = new URL(appScript.src, window.location.origin);
    const version = srcUrl.searchParams.get('v') || 'dev';
    buildBadge.textContent = `build v${version}`;
};

setBuildVersionBadge();

const buildGoogleProvider = () => {
    const provider = new GoogleAuthProvider();
    provider.addScope('https://www.googleapis.com/auth/calendar.events');
    provider.addScope('https://www.googleapis.com/auth/tasks');
    provider.addScope('https://www.googleapis.com/auth/drive.file'); // Required for creating/editing the Expense Spreadsheet during Evening Sync
    return provider;
};

const buildLoginProvider = () => {
    // Request full scopes at login to prevent 'insufficient authentication scopes'
    // errors during sync due to the token being cached from a minimal login.
    const provider = new GoogleAuthProvider();
    provider.addScope('https://www.googleapis.com/auth/calendar.events');
    provider.addScope('https://www.googleapis.com/auth/tasks');
    provider.addScope('https://www.googleapis.com/auth/drive.file');
    provider.setCustomParameters({ prompt: 'select_account' });
    return provider;
};

const SCOPE_REDIRECT_GUARD_KEY = 'ai_planner_scope_redirect_started_at';
const SCOPE_REDIRECT_GUARD_MS = 5 * 60 * 1000; // 5 minutes

const markScopeRedirectStarted = () => {
    try {
        sessionStorage.setItem(SCOPE_REDIRECT_GUARD_KEY, String(Date.now()));
    } catch (_) { /* no-op */ }
};

const consumeRecentScopeRedirectMark = () => {
    try {
        const startedAt = Number(sessionStorage.getItem(SCOPE_REDIRECT_GUARD_KEY) || 0);
        if (!startedAt) return false;
        sessionStorage.removeItem(SCOPE_REDIRECT_GUARD_KEY);
        const age = Date.now() - startedAt;
        return age >= 0 && age < SCOPE_REDIRECT_GUARD_MS;
    } catch (_) {
        return false;
    }
};

const clearScopeRedirectMark = () => {
    try { sessionStorage.removeItem(SCOPE_REDIRECT_GUARD_KEY); } catch (_) { /* no-op */ }
};

const canFallbackToRedirect = (errorCode) => (
    errorCode === 'auth/popup-blocked' ||
    errorCode === 'auth/operation-not-supported-in-this-environment'
);

const ensureGoogleAccessToken = async (forceRefresh = false) => {
    if (forceRefresh) googleAccessToken = null;
    if (googleAccessToken) return googleAccessToken;
    if (!auth.currentUser) throw new Error("Please sign in again.");

    try {
        const result = await signInWithPopup(auth, buildGoogleProvider());
        const credential = GoogleAuthProvider.credentialFromResult(result);
        if (!credential?.accessToken) throw new Error("Failed to acquire Google token.");
        googleAccessToken = credential.accessToken;
        return googleAccessToken;
    } catch (e) {
        if (canFallbackToRedirect(e.code)) {
            if (consumeRecentScopeRedirectMark()) {
                throw new Error("Google permission flow did not return a token. Please retry once in Chrome with cookies enabled.");
            }
            markScopeRedirectStarted();
            await signInWithRedirect(auth, buildGoogleProvider());
            return;
        }
        throw e;
    }
};

// --- 1. AUTH FLOW ---
// Handle redirect result (if user was redirected back from Google login)
getRedirectResult(auth).then((result) => {
    if (result) {
        const credential = GoogleAuthProvider.credentialFromResult(result);
        if (credential?.accessToken) {
            googleAccessToken = credential.accessToken;
            clearScopeRedirectMark();
        }
    }
}).catch((err) => console.warn("Redirect result error:", err));

const loginBtn = document.getElementById('login-btn');
loginBtn?.addEventListener('click', async () => {
    try {
        const result = await signInWithPopup(auth, buildLoginProvider());
        const credential = GoogleAuthProvider.credentialFromResult(result);
        googleAccessToken = credential.accessToken;
    } catch (e) {
        if (canFallbackToRedirect(e.code)) {
            await signInWithRedirect(auth, buildLoginProvider());
            return;
        }
        alert("Login failed: " + e.message);
    }
});

auth.onAuthStateChanged(async (user) => {
    if (user) {
        currentUser = user;
        // Show user display name (from Google profile as default)
        const displayName = user.displayName || user.email.split('@')[0];
        document.getElementById('user-display-name').textContent = `Hi, ${displayName}`;
        document.getElementById('drawer-user-email').textContent = user.email;
        document.getElementById('gamification-bars').classList.remove('hidden');
        document.getElementById('gamification-bars').classList.add('flex');
        await checkUserSetup(user);
    } else {
        currentUser = null;
        googleAccessToken = null;
        if (profileUnsubscribe) { profileUnsubscribe(); profileUnsubscribe = null; }
        document.getElementById('gamification-bars').classList.add('hidden');
        document.getElementById('gamification-bars').classList.remove('flex');
        switchView('view-login');
    }
});

// --- 2. SETUP FLOW ---
async function checkUserSetup(user) {
    try {
        const { getFirestore, doc, getDoc, onSnapshot } = await import("https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js");
        const db = getFirestore(app);

        // Check Firestore for profile
        const userRef = doc(db, "users", user.email);
        const snap = await getDoc(userRef);

        // Setup real-time listener for Gamification & Tier logic
        if (profileUnsubscribe) profileUnsubscribe();
        let staleStreakRefreshAttempted = false;
        profileUnsubscribe = onSnapshot(userRef, (docSnap) => {
            if (docSnap.exists()) {
                userProfile = docSnap.data();
                updateGamificationUI(userProfile);
                if (!staleStreakRefreshAttempted) {
                    staleStreakRefreshAttempted = true;
                    refreshStaleStreakIfNeeded(user, userProfile);
                }
                // Sync dedup toggles from stored preferences (default: ON)
                const calToggle = document.getElementById('dedup-calendar');
                const taskToggle = document.getElementById('dedup-tasks');
                if (calToggle) calToggle.checked = userProfile.dedupCalendar !== false;
                if (taskToggle) taskToggle.checked = userProfile.dedupTasks !== false;
            }
        });

        if (snap.exists() && (snap.data().notionKey || snap.data().geminiKey || snap.data().byokConfig || snap.data().byokKmsData || snap.data().setupComplete)) {
            // Update display name from Firestore if stored
            if (snap.data().displayName) {
                document.getElementById('user-display-name').textContent = `Hi, ${snap.data().displayName}`;
            }
            // Update plan badge
            const tier = snap.data().tier || 'free';
            const planBadge = document.getElementById('current-plan-badge');
            if (planBadge) {
                planBadge.textContent = tier === 'free' ? 'Free Plan' : tier === 'standard' ? 'Standard' : 'Pro';
            }
            // Update Notion status on the onboarding page (for revisits from drawer)
            const hasNotion = !!snap.data().notionKey;
            const notionOnboardStatus = document.getElementById('notion-onboard-status');
            if (notionOnboardStatus && hasNotion) {
                notionOnboardStatus.classList.remove('hidden');
                notionOnboardStatus.classList.add('flex');
            }
            // Update Advanced Settings Notion status card
            const advBadge = document.getElementById('adv-notion-badge');
            if (advBadge) advBadge.textContent = hasNotion ? '✅ Connected' : 'Not connected';
            // User has setup -> Go to Dashboard
            switchView('view-dashboard');
            // Fetch sync history in the background
            loadSyncHistory(user.email);
        } else if (snap.exists() && !snap.data().displayName) {
            // User exists but no display name -> Ask for name first
            switchView('view-name-prompt');
            const googleName = user.displayName || '';
            document.getElementById('user-display-name-input').value = googleName;
        } else if (!snap.exists()) {
            // Brand new user -> Ask for name
            switchView('view-name-prompt');
            const googleName = user.displayName || '';
            document.getElementById('user-display-name-input').value = googleName;
        } else {
            // Has profile but no keys -> Notion Setup (not BYOK)
            switchView('view-notion-setup');
        }
    } catch (err) {
        console.error("Profile Load Error:", err);
        switchView('view-dashboard');
    }
}

async function refreshStaleStreakIfNeeded(user, profileData) {
    const stored = profileData.currentStreak || 0;
    const display = computeDisplayStreak(profileData);
    if (display !== 0 || stored === 0) return;
    try {
        const idToken = await user.getIdToken();
        const { PRIMARY_API_URL } = getApiUrls(window.location.hostname, 'refreshStaleStreak');
        await fetch(PRIMARY_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken })
        });
    } catch (_) { /* best-effort — UI already shows computed 0 */ }
}

function updateGamificationUI(data) {
    const tierCredits = data.tierCredits || 0;
    const boosterCredits = data.boosterCredits || 0;
    const currentStreak = computeDisplayStreak(data);
    const highestStreak = data.highestStreak || 0;
    const streakFreezes = data.streakFreezes || 0;
    const hasKmsBYOK = !!data.geminiKey || !!data.byokConfig || !!data.byokKmsData;
    const hasStatelessBYOK = !!sessionStorage.getItem('byok_stateless_config') || !!sessionStorage.getItem('byok_stateless_key');
    const hasBYOK = hasKmsBYOK || hasStatelessBYOK;

    const streakBadge = document.getElementById('streak-badge');
    const timeZone = data.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
    const normalizedLastSync = normalizeSyncDateStr(data.lastSyncDate, timeZone);
    const lastSyncLabel = normalizedLastSync ? ` · last sync ${normalizedLastSync}` : '';
    if (streakBadge) {
        streakBadge.dataset.tooltip = currentStreak > 0
            ? `Current streak (days)${lastSyncLabel}`
            : `Streak lapsed — sync to start again${lastSyncLabel}`;
    }

    // Head HUD
    document.getElementById('streak-badge').textContent = `🔥 ${currentStreak}`;
    document.getElementById('credits-badge').textContent = hasBYOK ? `🪙 ∞` : `🪙 ${tierCredits + boosterCredits}`;
    document.getElementById('freezes-badge').textContent = `❄️ ${streakFreezes}`;
    
    // Reports Metrics
    document.getElementById('reports-current-streak').textContent = `🔥 ${currentStreak}`;
    document.getElementById('reports-highest-streak').textContent = `${highestStreak}`;
    document.getElementById('reports-streak-freezes').textContent = `❄️ ${streakFreezes}`;
}

// Restore BYOK UI state
const statelessConfigStr = sessionStorage.getItem('byok_stateless_config');
if (statelessConfigStr) {
    try {
        const config = JSON.parse(statelessConfigStr);
        const apiKeyInput = document.getElementById('byok-api-key');
        const providerSelect = document.getElementById('byok-provider');
        const statelessRadio = document.querySelector('input[name="byok-mode"][value="stateless"]');
        if (apiKeyInput && statelessRadio && providerSelect) {
            apiKeyInput.value = config.apiKey;
            if (config.customUrl) {
                providerSelect.value = 'custom:cloud';
                showCustomFields('cloud');
                document.getElementById('byok-custom-url').value = config.customUrl;
                document.getElementById('byok-custom-model').value = config.modelName;
            } else {
                providerSelect.value = `${config.provider}:${config.modelName}`;
            }
            statelessRadio.checked = true;
        }
    } catch(e){}
} else {
    const statelessKey = sessionStorage.getItem('byok_stateless_key');
    if (statelessKey) {
        const apiKeyInput = document.getElementById('byok-api-key');
        if (apiKeyInput) apiKeyInput.value = statelessKey;
        document.querySelector('input[name="byok-mode"][value="stateless"]').checked = true;
    }
}

// Custom provider sub-category field logic
function showCustomFields(subType) {
    const fields = document.getElementById('byok-custom-fields');
    const label = document.getElementById('custom-type-label');
    const urlInput = document.getElementById('byok-custom-url');
    const versionGroup = document.getElementById('custom-api-version-group');
    fields.classList.remove('hidden');
    versionGroup.classList.add('hidden');
    if (subType === 'cloud') {
        label.textContent = '☁️ Standard Cloud API (OpenAI-compatible)';
        urlInput.placeholder = 'https://api.example.com/v1/chat/completions';
    } else if (subType === 'local') {
        label.textContent = '🏠 Local / Self-Hosted (e.g., Ollama)';
        urlInput.placeholder = 'https://your-secure-ollama.example.com/v1/chat/completions';
    } else if (subType === 'enterprise') {
        label.textContent = '🏢 Enterprise Endpoint';
        urlInput.placeholder = 'https://your-company.openai.azure.com';
        versionGroup.classList.remove('hidden');
    }
}

document.getElementById('byok-provider').addEventListener('change', (e) => {
    const val = e.target.value;
    if (val.startsWith('custom:')) {
        showCustomFields(val.split(':')[1]);
    } else {
        document.getElementById('byok-custom-fields').classList.add('hidden');
    }
});



// --- NOTION ONBOARDING SAVE HANDLER ---
document.getElementById('save-notion-btn')?.addEventListener('click', async () => {
    const key = document.getElementById('notion-key-input').value.trim();
    const dbId = document.getElementById('notion-db-input').value.trim();

    if (!key || !dbId) {
        alert("Please enter both your Notion Integration Key and Database ID.");
        return;
    }

    const saveBtn = document.getElementById('save-notion-btn');
    const originalText = saveBtn.innerText;
    saveBtn.innerText = "Securing...";
    saveBtn.disabled = true;

    try {
        const idToken = await auth.currentUser.getIdToken();

        const res = await fetch('/setupNotion', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken, notionKey: key, notionDbId: dbId })
        });
        if (!res.ok) {
            const apiErr = await readApiError(res);
            showActionableError({
                title: 'Notion setup failed',
                summary: 'Could not save Notion keys securely. Please try again.',
                details: apiErr.details,
            });
            return;
        }

        // Mark setup complete via backend instead of frontend to bypass security rules
        const profileRes = await fetch('/updateProfile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken, updates: { setupComplete: true } })
        });
        if (!profileRes.ok) {
            const apiErr = await readApiError(profileRes);
            showActionableError({
                title: 'Setup incomplete',
                summary: 'Notion keys were saved, but setup could not be marked complete.',
                details: apiErr.details,
            });
            return;
        }

        switchView('view-dashboard');
        if (currentUser) loadSyncHistory(currentUser.email);
    } catch (err) {
        console.error("Failed to save Notion keys:", err);
        showActionableError({
            title: 'Notion setup failed',
            summary: 'Could not save Notion keys securely. Please try again.',
            details: err?.message || String(err),
        });
    } finally {
        saveBtn.innerText = originalText;
        saveBtn.disabled = false;
    }
});

document.getElementById('skip-notion-btn')?.addEventListener('click', async (event) => {
    event.preventDefault();
    // Defensive fallback: enforce a single visible view even if stale CSS/helper is cached.
    document.querySelectorAll('[id^="view-"]').forEach((el) => {
        el.classList.add('view-hidden');
        el.style.display = 'none';
        el.hidden = true;
        el.setAttribute('aria-hidden', 'true');
    });
    const dashboardView = document.getElementById('view-dashboard');
    if (dashboardView) {
        dashboardView.classList.remove('view-hidden');
        dashboardView.style.removeProperty('display');
        dashboardView.hidden = false;
        dashboardView.setAttribute('aria-hidden', 'false');
    }

    try {
        const idToken = await auth.currentUser.getIdToken();
        await fetch('/updateProfile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken, updates: { setupComplete: true } })
        });
    } catch (e) { /* best effort */ }
    switchView('view-dashboard');
    if (currentUser) loadSyncHistory(currentUser.email);
});

// Change notion keys on revisit
document.getElementById('change-notion-onboard-btn')?.addEventListener('click', () => {
    document.getElementById('notion-onboard-status').classList.add('hidden');
    document.getElementById('notion-onboard-status').classList.remove('flex');
    document.getElementById('notion-key-input').value = '';
    document.getElementById('notion-db-input').value = '';
});

// Advanced Settings → Notion configure button
document.getElementById('adv-notion-configure')?.addEventListener('click', () => {
    switchView('view-notion-setup');
});

// Back to Dashboard from Advanced Settings
document.getElementById('back-to-dash-from-adv')?.addEventListener('click', () => {
    switchView('view-dashboard');
});

// --- BYOK SAVE HANDLER (Advanced Settings only) ---
document.getElementById('save-setup-btn')?.addEventListener('click', async () => {
    // BYOK Config
    const byokMode = document.querySelector('input[name="byok-mode"]:checked').value;
    const byokKey = document.getElementById('byok-api-key').value.trim();
    const providerVal = document.getElementById('byok-provider').value;
    
    let provider, modelName, customUrl, apiVersion;
    if (providerVal.startsWith('custom:')) {
        const subType = providerVal.split(':')[1];
        customUrl = document.getElementById('byok-custom-url').value.trim();
        modelName = document.getElementById('byok-custom-model').value.trim();
        apiVersion = document.getElementById('byok-custom-api-version')?.value.trim();
        if (subType === 'local') {
            provider = 'ollama';
        } else if (subType === 'enterprise') {
            provider = customUrl?.includes('azure') ? 'azure' : 'openai';
        } else {
            provider = 'openai'; // Standard cloud = OpenAI compatible
        }
        if (byokKey && (!customUrl || !modelName)) {
            alert("Please provide the API Base URL and Model Name");
            return;
        }
    } else {
        [provider, modelName] = providerVal.split(':');
    }

    const saveBtn = document.getElementById('save-setup-btn');
    const originalText = saveBtn.innerText;
    saveBtn.innerText = "Securing...";
    saveBtn.disabled = true;

    try {
        const idToken = await auth.currentUser.getIdToken();

        // Save BYOK Keys
        if (byokKey) {
            const byokConfig = { apiKey: byokKey, provider, modelName, customUrl, apiVersion };
            if (byokMode === 'stateless') {
                sessionStorage.setItem('byok_stateless_config', JSON.stringify(byokConfig));
                sessionStorage.removeItem('byok_stateless_key');
                localStorage.removeItem('byok_stateless_config'); // cleanup dangling
                localStorage.removeItem('byok_stateless_key'); // cleanup dangling
            } else if (byokMode === 'kms') {
                sessionStorage.removeItem('byok_stateless_config');
                sessionStorage.removeItem('byok_stateless_key');
                localStorage.removeItem('byok_stateless_config');
                localStorage.removeItem('byok_stateless_key');
                const byokRes = await fetch('/setupBYOK', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ idToken, apiKey: byokKey, provider, modelName, baseUrl: customUrl, apiVersion })
                });
                const byokData = await parseJsonResponse(byokRes);
                if (!byokRes.ok) throw new Error(byokData.error || "Failed to securely envelope BYOK keys.");
            }
        } else {
            sessionStorage.removeItem('byok_stateless_config');
            sessionStorage.removeItem('byok_stateless_key');
            localStorage.removeItem('byok_stateless_config');
            localStorage.removeItem('byok_stateless_key');
        }

        switchView('view-dashboard');
    } catch (err) {
        console.error("Failed to save BYOK settings:", err);
        alert("Could not save BYOK settings securely. Please try again.");
    } finally {
        saveBtn.innerText = originalText;
        saveBtn.disabled = false;
    }
});

// --- Dedup Preference Toggles ---
const dedupCalendarToggle = document.getElementById('dedup-calendar');
const dedupTasksToggle = document.getElementById('dedup-tasks');

async function saveDedupPreference(field, value) {
    try {
        const idToken = await auth.currentUser.getIdToken();
        await fetch('/updateProfile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken, updates: { [field]: value } })
        });
    } catch (err) {
        console.error('Failed to save dedup preference:', err);
    }
}

dedupCalendarToggle?.addEventListener('change', (e) => {
    saveDedupPreference('dedupCalendar', e.target.checked);
});

dedupTasksToggle?.addEventListener('change', (e) => {
    saveDedupPreference('dedupTasks', e.target.checked);
});

// Guide Modal
const modal = document.getElementById('guide-modal');
document.getElementById('open-guide-onboard')?.addEventListener('click', () => {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
});
document.getElementById('close-guide')?.addEventListener('click', () => {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
});

// --- 3. DASHBOARD LOGIC ---
const dropZone = document.getElementById('drop-zone');
const dashBtns = document.querySelectorAll('.dash-btn');

const updateDashButtons = (enabled) => {
    dashBtns.forEach(b => {
        if (b.id !== 'btn-voice-note') {
            b.disabled = !enabled;
        } else {
            b.disabled = false; // Voice note is always enabled (doesn't require image)
        }
    });
};
updateDashButtons(false);

const defaultUploadUI = `
    <div id="upload-ui" class="w-full h-full flex items-center justify-center gap-4 sm:gap-6 relative z-10">
        <label class="flex flex-col items-center p-3 sm:p-4 hover:bg-theme-border/30 active:bg-theme-border/50 rounded-xl transition-colors cursor-pointer">
            <input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" capture="environment" class="upload-input hidden">
            <span class="text-3xl mb-1.5 pointer-events-none">📷</span>
            <span class="text-xs sm:text-sm font-bold text-theme-text pointer-events-none">Camera</span>
        </label>
        <div class="w-px h-14 bg-theme-border/60"></div>
        <label class="flex flex-col items-center p-3 sm:p-4 hover:bg-theme-border/30 active:bg-theme-border/50 rounded-xl transition-colors cursor-pointer">
            <input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" class="upload-input hidden">
            <span class="text-3xl mb-1.5 pointer-events-none">🖼️</span>
            <span class="text-xs sm:text-sm font-bold text-theme-text pointer-events-none">Gallery</span>
        </label>
        <div class="w-px h-14 bg-theme-border/60"></div>
        <label class="flex flex-col items-center p-3 sm:p-4 hover:bg-theme-border/30 active:bg-theme-border/50 rounded-xl transition-colors cursor-pointer">
            <input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" class="upload-input hidden">
            <span class="text-3xl mb-1.5 pointer-events-none">📁</span>
            <span class="text-xs sm:text-sm font-bold text-theme-text pointer-events-none">Files</span>
        </label>
    </div>
`;

// Bind change events on any .upload-input inside the drop zone (works with dynamic HTML)
dropZone.addEventListener('change', (e) => {
    if (e.target.classList.contains('upload-input')) {
        handleFiles(e.target.files);
    }
});

const renderThumbnails = () => {
    if (filesAsBase64.length > 0) {
        dropZone.innerHTML = `
            <div class="flex flex-wrap gap-2 justify-center p-2 items-center h-full w-full overflow-y-auto">
                ${filesAsBase64.map((b64, idx) => `
                    <div class="relative group h-24 w-auto shrink-0">
                        <img src="${b64}" class="h-full w-auto object-cover border border-theme-border rounded shadow-sm">
                        <button class="delete-btn absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs shadow hover:bg-red-600 transition-colors opacity-100 md:opacity-0 md:group-hover:opacity-100 cursor-pointer z-10" data-idx="${idx}" title="Remove image">
                            ✕
                        </button>
                    </div>
                `).join('')}
                ${filesAsBase64.length < 5 ? `
                    <div class="flex flex-col gap-1">
                        <label class="h-11 w-11 shrink-0 border-2 border-dashed border-theme-border flex items-center justify-center text-theme-muted hover:text-theme-text hover:border-theme-text transition-colors rounded-lg bg-theme-bg/50 cursor-pointer" title="Take Photo">
                            <input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" capture="environment" class="upload-input hidden">
                            <span class="text-lg pointer-events-none">📷</span>
                        </label>
                        <label class="h-11 w-11 shrink-0 border-2 border-dashed border-theme-border flex items-center justify-center text-theme-muted hover:text-theme-text hover:border-theme-text transition-colors rounded-lg bg-theme-bg/50 cursor-pointer" title="Add from Gallery">
                            <input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" class="upload-input hidden">
                            <span class="text-lg pointer-events-none">🖼️</span>
                        </label>
                    </div>
                ` : ''}
            </div>
            <div class="absolute bottom-2 right-2 bg-emerald-500/90 text-white text-xs px-2 py-1 rounded-full font-medium pointer-events-none shadow-sm z-20">
                ${filesAsBase64.length}/5 Page${filesAsBase64.length > 1 ? 's' : ''}
            </div>
        `;

        const deleteBtns = dropZone.querySelectorAll('.delete-btn');
        deleteBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const idx = parseInt(e.currentTarget.dataset.idx);
                filesAsBase64.splice(idx, 1);
                renderThumbnails();
            });
        });

        updateDashButtons(true);
    } else {
        dropZone.innerHTML = defaultUploadUI;
        updateDashButtons(false);
    }
};

// File Handler with Compression & HEIC Support
const handleFiles = async (files) => {
    if (!files || files.length === 0) return;

    // Feature Guarding: Check limits based on Tier + sync mode (must match backend)
    const tier = userProfile?.tier || 'free';
    const selectedMode = document.querySelector('.sync-btn.active')?.dataset?.mode || 'morning';
    let limit;
    if (tier === 'free') {
        limit = 1;
    } else if (tier === 'standard') {
        limit = (selectedMode === 'journal') ? 3 : 1;
    } else {
        limit = 5; // pro
    }
    const remainingSlots = limit - filesAsBase64.length;

    if (remainingSlots <= 0) {
        document.getElementById('paywall-message').textContent = tier === 'free' 
            ? "Batch uploading is available only on paid tiers. Upgrade to Standard or Pro to upload multiple pages!"
            : "Standard tier limit reached. Upgrade to Pro for 5-page batch uploads!";
        document.getElementById('paywall-modal').classList.remove('hidden');
        document.getElementById('paywall-modal').classList.add('flex');
        return;
    }

    const filesToProcess = Array.from(files).slice(0, remainingSlots);
    if (files.length > remainingSlots) {
        document.getElementById('paywall-message').textContent = tier === 'free' 
            ? `Batch uploading is available only on paid tiers. Only the first image was added. Upgrade to unlock!`
            : `Your tier limit is ${limit} pages. Only ${remainingSlots} images were added. Upgrade for more!`;
        document.getElementById('paywall-modal').classList.remove('hidden');
        document.getElementById('paywall-modal').classList.add('flex');
    }

    dropZone.innerHTML = '<div class="spinner border-theme-text"></div><p class="mt-2 text-sm text-theme-muted">Processing images...</p>';

    for (let i = 0; i < filesToProcess.length; i++) {
        let file = filesToProcess[i];

        // Handle HEIC/HEIF conversion
        if (file.type === "image/heic" || file.type === "image/heif" || file.name.toLowerCase().endsWith('.heic')) {
            console.log(`HEIC detected for ${file.name}. Converting...`);
            try {
                const blob = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.8 });
                const convertedBlob = Array.isArray(blob) ? blob[0] : blob;
                file = new File([convertedBlob], file.name.replace(/\.heic$/i, ".jpg"), { type: "image/jpeg" });
            } catch (e) {
                console.error("HEIC Conversion failed:", e);
                alert(`Could not convert ${file.name}. Skipping.`);
                continue;
            }
        }

        if (file.type.startsWith('image/')) {
            // Allow large camera files; they are resized/compressed before upload.
            if (file.size > 20 * 1024 * 1024) {
                alert(`${file.name} is too large. Images must be under 20MB.`);
                continue;
            }

            const base64Data = await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = (ev) => {
                    const img = new Image();
                    img.onerror = () => {
                        alert("Corrupted or unsupported image file detected.");
                        resolve(null);
                    };
                    img.onload = () => {
                        // Max dimensions
                        const MAX_WIDTH = 1200;
                        const MAX_HEIGHT = 1600;
                        let width = img.width;
                        let height = img.height;

                        if (width > height) {
                            if (width > MAX_WIDTH) {
                                height *= MAX_WIDTH / width;
                                width = MAX_WIDTH;
                            }
                        } else {
                            if (height > MAX_HEIGHT) {
                                width *= MAX_HEIGHT / height;
                                height = MAX_HEIGHT;
                            }
                        }

                        const canvas = document.createElement('canvas');
                        canvas.width = width;
                        canvas.height = height;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0, width, height);

                        resolve(canvas.toDataURL('image/jpeg', 0.85)); // 85% quality JPG
                    };
                    img.src = ev.target.result;
                };
                reader.onerror = () => {
                    alert("Failed to read image file.");
                    resolve(null);
                };
                reader.readAsDataURL(file);
            });
            if (base64Data) {
                filesAsBase64.push(base64Data);
            }
        }
    }

    renderThumbnails();
};


// Drag & Drop Logic
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, preventDefaults, false);
});

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, highlight, false);
});

['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, unhighlight, false);
});

function highlight(e) { dropZone.classList.add('bg-blue-50', 'border-blue-400', 'dark:bg-emerald-900/20'); }
function unhighlight(e) { dropZone.classList.remove('bg-blue-50', 'border-blue-400', 'dark:bg-emerald-900/20'); }

dropZone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    handleFiles(files);
});

// Sync button bindings
document.getElementById('btn-morning')?.addEventListener('click', () => triggerSync('morning'));
document.getElementById('btn-night')?.addEventListener('click', () => triggerSync('night'));
document.getElementById('btn-journal')?.addEventListener('click', () => triggerSync('journal'));

let mediaRecorder;
let audioChunks = [];
let isRecording = false;
let audioStream = null;

document.getElementById('btn-voice-note')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-voice-note');
    const icon = document.getElementById('voice-note-icon');
    const label = document.getElementById('voice-note-label');
    const pulse = document.getElementById('voice-recording-pulse');

    if (isRecording) {
        // Stop recording
        mediaRecorder.stop();
        isRecording = false;
        
        icon.textContent = '🎤';
        label.textContent = 'Voice Note';
        pulse.classList.add('hidden');
        btn.classList.remove('ring-2', 'ring-red-400');
    } else {
        // Start recording
        try {
            audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(audioStream);
            audioChunks = [];
            
            mediaRecorder.addEventListener('dataavailable', event => {
                if (event.data.size > 0) audioChunks.push(event.data);
            });
            
            mediaRecorder.addEventListener('stop', () => {
                // Stop all tracks to release microphone
                audioStream.getTracks().forEach(track => track.stop());

                const audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/mp4' });
                
                // Convert Blob to Base64
                const reader = new FileReader();
                reader.onloadend = () => {
                    const base64Audio = reader.result;
                    // Trigger sync process with the recorded audio
                    triggerSync('voice_note', [base64Audio]);
                };
                reader.readAsDataURL(audioBlob);
            });
            
            mediaRecorder.start();
            isRecording = true;
            
            icon.textContent = '⏹️';
            label.textContent = 'Stop';
            pulse.classList.remove('hidden');
            btn.classList.add('ring-2', 'ring-red-400');
            
        } catch (err) {
            console.error('Microphone access denied:', err);
            alert('Please allow microphone access to record voice notes.');
        }
    }
});

const triggerSync = async (syncType, overrideFiles = null) => {
    // UI Loading with Granular Messages
    const loader = document.getElementById('dash-loader');
    loader.style.display = 'flex';
    const statusArea = document.getElementById('status-area');
    statusArea.classList.remove('hidden', 'text-red-600', 'bg-red-50', 'text-green-600', 'bg-green-50');
    statusArea.classList.add('text-blue-600', 'bg-blue-50');
    statusArea.textContent = "Compressing Image..."; // Initial State

    updateDashButtons(false);

    // Granular Progress Timer (Simulated for UX)
    let steps = [];
    if (syncType === 'voice_note') {
        statusArea.textContent = "Processing Audio...";
        steps = [
            { t: 1000, msg: "Uploading to Secure Cloud..." },
            { t: 5000, msg: "AI is Transcribing Audio..." },
            { t: 15000, msg: "Extracting Insights..." },
            { t: 25000, msg: "Syncing with Notion..." },
            { t: 40000, msg: "Almost there..." }
        ];
    } else if (syncType === 'journal') {
        statusArea.textContent = "Processing Image...";
        steps = [
            { t: 1000, msg: "Uploading to Secure Cloud..." },
            { t: 5000, msg: "AI is Reading Handwriting..." },
            { t: 15000, msg: "Extracting Journal Entries..." },
            { t: 25000, msg: "Syncing with Notion..." },
            { t: 40000, msg: "Almost there..." }
        ];
    } else {
        steps = [
            { t: 1000, msg: "Uploading to Secure Cloud..." },
            { t: 5000, msg: "AI is Reading Handwriting..." },
            { t: 15000, msg: "Extracting Tasks & Events..." },
            { t: 25000, msg: "Syncing with Notion & Google..." },
            { t: 40000, msg: "Almost there..." }
        ];
    }

    let timers = [];
    steps.forEach(step => {
        timers.push(setTimeout(() => {
            if (loader.style.display !== 'none') { // Only update if still loading
                statusArea.textContent = step.msg;
            }
        }, step.t));
    });

    try {
        const clientTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
        const { PRIMARY_API_URL, FALLBACK_API_URL } = getApiUrls(window.location.hostname, 'syncPlanner');
        let res;
        let data;
        let attempt = 0;
        let currentToken = null;
        if (syncType !== 'journal' && syncType !== 'voice_note') {
            currentToken = await ensureGoogleAccessToken();
        }
        const idToken = await auth.currentUser.getIdToken();

        while (attempt < 2) {
            const payload = {
                idToken,
                googleToken: currentToken,
                images: overrideFiles || filesAsBase64,
                syncType,
                timeZone: clientTimeZone
            };

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 minutes Frontend Timeout

            // Inject BYOK Stateless Token if it exists
            const fetchHeaders = { 'Content-Type': 'application/json' };
            const storedConfigStr = sessionStorage.getItem('byok_stateless_config');
            if (storedConfigStr) {
                try {
                    const config = JSON.parse(storedConfigStr);
                    fetchHeaders['X-BYOK-Token'] = config.apiKey;
                    fetchHeaders['X-BYOK-Provider'] = config.provider;
                    fetchHeaders['X-BYOK-Model'] = config.modelName;
                    if (config.customUrl) fetchHeaders['X-BYOK-BaseURL'] = config.customUrl;
                    if (config.apiVersion) fetchHeaders['X-BYOK-ApiVersion'] = config.apiVersion;
                } catch(e) {}
            } else {
                const storedToken = sessionStorage.getItem('byok_stateless_key');
                if (storedToken) {
                    fetchHeaders['X-BYOK-Token'] = storedToken;
                }
            }

            try {
                res = await fetch(PRIMARY_API_URL, {
                    method: 'POST',
                    headers: fetchHeaders,
                    body: JSON.stringify(payload),
                    signal: controller.signal
                });
                data = await parseJsonResponse(res);
            } catch (primaryErr) {
                console.warn("Primary API route failed, retrying direct function URL.", primaryErr);
                res = await fetch(FALLBACK_API_URL, {
                    method: 'POST',
                    headers: fetchHeaders,
                    body: JSON.stringify(payload),
                    signal: controller.signal
                });
                data = await parseJsonResponse(res);
            }

            clearTimeout(timeoutId);

            if (res.status === 401 && attempt === 0 && (syncType !== 'journal' && syncType !== 'voice_note')) {
                console.warn("401 Unauthorized. Expired Google token detected, forcing refresh.");
                attempt++;
                try {
                    currentToken = await ensureGoogleAccessToken(true);
                    continue;
                } catch (retryErr) {
                    console.error("Token refresh failed:", retryErr);
                    break;
                }
            }

            break; // Exit loop on success or non-401 error
        }

        timers.forEach(t => clearTimeout(t)); // Stop simulated progress

        // Reset all file inputs inside the drop zone
        dropZone.querySelectorAll('.upload-input').forEach(input => { input.value = ''; });
        filesAsBase64 = [];
        renderThumbnails();

        if (res.ok) {
            statusArea.classList.remove('text-red-600', 'bg-red-50', 'text-blue-600', 'bg-blue-50');
            statusArea.classList.add('text-green-600', 'bg-green-50');
            statusArea.textContent = `Success! ${data.text}`;
            if (currentUser) loadSyncHistory(currentUser.email); // Refresh history
        } else {
            throw new Error(data.error || "Server Error");
        }
    } catch (err) {
        console.error(err);
        timers.forEach(t => clearTimeout(t));
        statusArea.classList.remove('hidden', 'text-blue-600', 'bg-blue-50', 'text-green-600', 'bg-green-50');
        statusArea.classList.add('text-red-600', 'bg-red-50');

        // Friendly Errors
        let msg = err.message;
        if (msg.includes("Failed to fetch")) msg = "Network Error. Check your connection.";

        statusArea.textContent = `Error: ${msg}`;
        statusArea.classList.add('text-red-600', 'bg-red-50');
    } finally {
        document.getElementById('dash-loader').style.display = 'none';
        updateDashButtons(filesAsBase64.length > 0);
    }
};

// --- GDPR: Export & Delete ---
async function exportMyData() {
    try {
        if (!auth.currentUser) { alert('Please sign in first.'); return; }
        const token = await auth.currentUser.getIdToken();
        const res = await fetch('/exportUserData', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
        });
        const data = await parseJsonResponse(res);
        if (!res.ok) throw new Error(data.error || "Export failed");

        // Trigger download
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ai-planner-data-${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
    } catch (err) {
        console.error("Export error:", err);
        alert("Failed to export data: " + err.message);
    }
}

// --- NAVIGATION ---

// History back button
document.getElementById('back-to-dash-btn').addEventListener('click', () => switchView('view-dashboard'));

// Reports back button
document.getElementById('back-to-dash-btn-reports').addEventListener('click', () => switchView('view-dashboard'));

// Settings back button
document.getElementById('back-to-dash-from-setup')?.addEventListener('click', () => switchView('view-dashboard'));

// --- HAMBURGER DRAWER ---
const drawerContainer = document.getElementById('drawer-container');
const openDrawer = () => {
    drawerContainer.classList.remove('hidden');
    // Double rAF ensures the browser paints the hidden->visible state before
    // adding the class that triggers the CSS transition
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            drawerContainer.classList.add('drawer-open');
        });
    });
};
const closeDrawer = () => { drawerContainer.classList.remove('drawer-open'); setTimeout(() => drawerContainer.classList.add('hidden'), 300); };

document.getElementById('hamburger-btn')?.addEventListener('click', openDrawer);
document.getElementById('close-drawer')?.addEventListener('click', closeDrawer);
document.getElementById('drawer-overlay')?.addEventListener('click', closeDrawer);

// Drawer item handlers
document.querySelectorAll('[data-drawer]').forEach(btn => {
    btn.addEventListener('click', () => {
        closeDrawer();
        const action = btn.dataset.drawer;
        switch(action) {
            case 'upgrade':
                document.getElementById('pricing-modal').classList.remove('hidden');
                document.getElementById('pricing-modal').classList.add('flex');
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
                switchView('view-notion-setup');
                break;
            case 'settings':
                document.getElementById('back-to-dash-from-setup')?.classList.remove('hidden');
                switchView('view-setup');
                break;
            case 'export':
                exportMyData();
                break;
            case 'delete':
                deleteMyAccount();
                break;
            case 'logout':
                auth.signOut();
                break;
        }
    });
});

// --- PRICING MODAL ---
const pricingModal = document.getElementById('pricing-modal');
document.getElementById('current-plan-badge')?.addEventListener('click', () => {
    pricingModal.classList.remove('hidden');
    pricingModal.classList.add('flex');
});
document.getElementById('close-pricing')?.addEventListener('click', () => {
    pricingModal.classList.add('hidden');
    pricingModal.classList.remove('flex');
});

// Pricing toggle: Monthly <-> Upfront
let pricingMode = 'monthly';
const toggleMonthly = document.getElementById('toggle-monthly');
const toggleUpfront = document.getElementById('toggle-upfront');
const saveBadge = document.getElementById('save-badge');

const updatePricingUI = () => {
    const isMonthly = pricingMode === 'monthly';
    toggleMonthly.classList.toggle('pricing-toggle-active', isMonthly);
    toggleMonthly.style.backgroundColor = isMonthly ? 'var(--text-main)' : 'transparent';
    toggleMonthly.style.color = isMonthly ? 'var(--bg-main)' : 'var(--text-muted)';

    toggleUpfront.classList.toggle('pricing-toggle-active', !isMonthly);
    toggleUpfront.style.backgroundColor = !isMonthly ? 'var(--text-main)' : 'transparent';
    toggleUpfront.style.color = !isMonthly ? 'var(--bg-main)' : 'var(--text-muted)';
    
    // Show/hide upfront options and save badge
    document.getElementById('standard-upfront-opts')?.classList.toggle('hidden', isMonthly);
    document.getElementById('pro-upfront-opts')?.classList.toggle('hidden', isMonthly);
    document.getElementById('standard-annual-tag')?.classList.toggle('hidden', isMonthly);
    document.getElementById('pro-annual-tag')?.classList.toggle('hidden', isMonthly);
    saveBadge?.classList.toggle('hidden', isMonthly);
    
    // Update hero prices
    if (isMonthly) {
        document.getElementById('standard-price').innerHTML = '₹29<span class="text-sm font-medium text-theme-muted"> /mo</span>';
        document.getElementById('pro-price').innerHTML = '₹49<span class="text-sm font-medium text-theme-muted"> /mo</span>';
    } else {
        updateUpfrontPrices();
    }
};

const updateUpfrontPrices = () => {
    const stdDuration = document.querySelector('input[name="standard-duration"]:checked')?.value || 'annual';
    const proDuration = document.querySelector('input[name="pro-duration"]:checked')?.value || 'annual';
    
    document.getElementById('standard-price').innerHTML = stdDuration === 'annual' 
        ? '₹290<span class="text-sm font-medium text-theme-muted"> /year</span>'
        : '₹79<span class="text-sm font-medium text-theme-muted"> /90 days</span>';
    document.getElementById('standard-annual-tag')?.classList.toggle('hidden', stdDuration !== 'annual');
    
    document.getElementById('pro-price').innerHTML = proDuration === 'annual'
        ? '₹490<span class="text-sm font-medium text-theme-muted"> /year</span>'
        : '₹129<span class="text-sm font-medium text-theme-muted"> /90 days</span>';
    document.getElementById('pro-annual-tag')?.classList.toggle('hidden', proDuration !== 'annual');
};

toggleMonthly?.addEventListener('click', () => { pricingMode = 'monthly'; updatePricingUI(); });
toggleUpfront?.addEventListener('click', () => { pricingMode = 'upfront'; updatePricingUI(); });
document.querySelectorAll('input[name="standard-duration"], input[name="pro-duration"]').forEach(r => {
    r.addEventListener('change', updateUpfrontPrices);
});

// --- PAYWALL MODAL ---
document.getElementById('close-paywall')?.addEventListener('click', () => {
    document.getElementById('paywall-modal').classList.add('hidden');
    document.getElementById('paywall-modal').classList.remove('flex');
});

// --- NAME PROMPT ---
document.getElementById('save-name-btn')?.addEventListener('click', async () => {
    const nameInput = document.getElementById('user-display-name-input');
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    
    try {
        const idToken = await auth.currentUser.getIdToken();
        await fetch('/updateProfile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken, updates: { displayName: name } })
        });
        document.getElementById('user-display-name').textContent = `Hi, ${name}`;
        switchView('view-notion-setup');
    } catch(e) {
        console.error('Failed to save name:', e);
        switchView('view-notion-setup');
    }
});

// Reports Heatmap Loader
const loadHeatmap = async (email) => {
    import("https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js").then(async ({ getFirestore, collection, query, where, getDocs }) => {
        const db = getFirestore(app);
        const heatmapGrid = document.getElementById('heatmap-grid');
        if (!heatmapGrid) return;

        heatmapGrid.innerHTML = '<div class="w-full flex justify-center py-4"><div class="spinner border-theme-text w-5 h-5"></div></div>';

        try {
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

            const q = query(
                collection(db, "users", email, "syncHistory"),
                where("timestamp", ">=", thirtyDaysAgo)
            );
            const snap = await getDocs(q);
            
            const daysMap = {};
            snap.forEach(doc => {
                const data = doc.data();
                if(data.status === 'success' && data.timestamp) {
                    const dateStr = data.timestamp.toDate().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
                    daysMap[dateStr] = (daysMap[dateStr] || 0) + 1;
                }
            });

            const boxes = [];
            const today = new Date();
            for(let i=29; i>=0; i--) {
                const d = new Date(today);
                d.setDate(d.getDate() - i);
                const dStr = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
                const count = daysMap[dStr] || 0;
                
                let colorClass = 'bg-gray-100 dark:bg-gray-800 border-gray-200 dark:border-gray-700';
                if (count === 1) colorClass = 'bg-emerald-200 dark:bg-emerald-900/40 border-emerald-300 dark:border-emerald-800';
                else if (count === 2) colorClass = 'bg-emerald-400 dark:bg-emerald-700/60 border-emerald-500 dark:border-emerald-600';
                else if (count >= 3) colorClass = 'bg-emerald-600 dark:bg-emerald-500 border-emerald-700 dark:border-emerald-400';

                boxes.push(`<div title="${dStr}: ${count} sync(s)" class="w-5 h-5 sm:w-6 sm:h-6 rounded border ${colorClass} transition-all duration-300 cursor-help hover:scale-110 hover:shadow-sm"></div>`);
            }
            
            heatmapGrid.innerHTML = boxes.join('');
        } catch (err) {
            console.error(err);
            heatmapGrid.innerHTML = '<div class="text-xs text-red-500 w-full text-center">Failed to load heatmap</div>';
        }
    });
};

// --- MONETIZATION & CASHFREE PLACEHOLDERS ---
document.getElementById('close-paywall')?.addEventListener('click', () => {
    document.getElementById('paywall-modal').classList.add('hidden');
    document.getElementById('paywall-modal').classList.remove('flex');
});

const collectPhoneNumber = () => {
    return new Promise((resolve, reject) => {
        const modal = document.getElementById('phone-modal');
        const content = document.getElementById('phone-modal-content');
        const form = document.getElementById('phone-form');
        const closeBtn = document.getElementById('close-phone-modal');
        const phoneInput = document.getElementById('user-phone');

        modal.classList.remove('hidden');
        modal.classList.add('flex');
        
        setTimeout(() => {
            content.classList.remove('scale-95', 'opacity-0');
            content.classList.add('scale-100', 'opacity-100');
        }, 10);

        phoneInput.focus();

        const cleanup = () => {
            content.classList.add('scale-95', 'opacity-0');
            content.classList.remove('scale-100', 'opacity-100');
            setTimeout(() => {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }, 300);
            
            form.removeEventListener('submit', onSubmit);
            closeBtn.removeEventListener('click', onCancel);
        };

        const onSubmit = (e) => {
            e.preventDefault();
            const phone = phoneInput.value.trim();
            if (/^[6-9]\d{9}$/.test(phone)) {
                cleanup();
                resolve(phone);
            }
        };

        const onCancel = () => {
            cleanup();
            reject(new Error("Payment cancelled by user."));
        };

        form.addEventListener('submit', onSubmit);
        closeBtn.addEventListener('click', onCancel);
    });
};

const handlePaymentClick = async (e, tierName, basePrice) => {
    const btn = e.currentTarget;
    const origText = btn.innerHTML;
    
    if (btn.disabled) return;
    
    let price = basePrice;
    if (typeof pricingMode !== 'undefined' && pricingMode === 'upfront') {
        if (tierName === 'Standard Tier') {
            const stdDuration = document.querySelector('input[name="standard-duration"]:checked')?.value || 'annual';
            price = stdDuration === 'annual' ? 290 : 79;
        } else if (tierName === 'Pro Tier') {
            const proDuration = document.querySelector('input[name="pro-duration"]:checked')?.value || 'annual';
            price = proDuration === 'annual' ? 490 : 129;
        }
    }

    try {
        if (!currentUser) {
            throw new Error("You must be logged in to upgrade.");
        }

        // 1. Get Phone Number (Ephemeral)
        const phoneNumber = await collectPhoneNumber();

        // Prevent double clicks after phone is collected
        btn.disabled = true;
        btn.innerHTML = `<span class="spinner w-4 h-4 border-white mr-2"></span> Redirecting...`;

        // 2. Get a fresh Firebase ID token for backend verification
        const freshIdToken = await auth.currentUser.getIdToken();

        // 3. Call your backend to create the Cashfree order
        const response = await fetch('/createCashfreeOrder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                idToken: freshIdToken,
                price: price,
                phone: phoneNumber // Send the collected phone number
            })
        });

        const data = await response.json();

        if (!response.ok || !data.payment_session_id) {
            throw new Error(data.error || "Failed to initialize payment.");
        }

        // 4. Initialize Cashfree SDK and trigger popup
        if (!['production', 'sandbox'].includes(data.payment_environment)) {
            throw new Error("Payment environment was not provided by the server.");
        }
        const cashfree = await Cashfree({ mode: data.payment_environment });
        cashfree.checkout({
            paymentSessionId: data.payment_session_id,
            redirectTarget: "_modal"
        });

    } catch (err) {
        if (err.message !== "Payment cancelled by user.") {
            console.error("Payment error:", err);
            alert(err.message || "An error occurred while launching payment.");
        }
    } finally {
        btn.innerHTML = origText;
        btn.disabled = false;
        // Clear phone input to ensure Zero-Storage
        const phoneInput = document.getElementById('user-phone');
        if (phoneInput) phoneInput.value = '';
    }
};

document.getElementById('buy-booster-btn')?.addEventListener('click', (e) => handlePaymentClick(e, 'Booster Credits', 19));
document.getElementById('buy-booster-btn-modal')?.addEventListener('click', (e) => handlePaymentClick(e, 'Booster Credits', 19));
document.getElementById('upgrade-standard-btn')?.addEventListener('click', (e) => handlePaymentClick(e, 'Standard Tier', 29));
document.getElementById('upgrade-standard-pricing-btn')?.addEventListener('click', (e) => handlePaymentClick(e, 'Standard Tier', 29));
document.getElementById('upgrade-pro-btn')?.addEventListener('click', (e) => handlePaymentClick(e, 'Pro Tier', 49));
const loadSyncHistory = async (email) => {
    import("https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js").then(async ({ getFirestore, collection, query, orderBy, limit, getDocs }) => {
        const db = getFirestore(app);
        const historyList = document.getElementById('history-list');
        if (!historyList) return;

        try {
            historyList.innerHTML = '<div class="flex justify-center py-4"><div class="spinner border-theme-text w-5 h-5"></div></div>';

            const q = query(
                collection(db, "users", email, "syncHistory"),
                orderBy("timestamp", "desc"),
                limit(10)
            );
            const querySnapshot = await getDocs(q);

            if (querySnapshot.empty) {
                historyList.innerHTML = '<div class="text-center text-sm text-theme-muted py-6">No sync history found yet. Sync a planner to see results here!</div>';
                return;
            }

            let html = '';
            querySnapshot.forEach((doc) => {
                const data = doc.data();
                const d = data.timestamp ? data.timestamp.toDate() : new Date();
                const timeString = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

                const escapeHTML = str => String(str || '').replace(/[&<>'"]/g, tag => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'}[tag]));
                const typeIcon = data.syncType === 'morning' ? '☀️' : data.syncType === 'evening' ? '🌙' : '📖';
                const statusColor = data.status === 'success' ? 'text-emerald-600' : 'text-red-500';
                const statusIcon = data.status === 'success' ? '✓' : '⚠️';

                html += `
                    <div class="p-3 border flex justify-between items-center rounded-xl border-theme-border mb-2 bg-theme-bg/50">
                        <div>
                            <span class="font-medium text-theme-text text-sm flex items-center gap-2 mb-1">
                                ${typeIcon} <span class="capitalize">${escapeHTML(data.syncType)}</span>
                                <span class="text-[10px] text-theme-muted font-normal bg-black/5 dark:bg-white/5 px-2 py-0.5 rounded-full">${data.imageCount || 1} pg</span>
                            </span>
                            <p class="text-xs ${statusColor} font-medium leading-snug">${statusIcon} ${escapeHTML(data.message)}</p>
                        </div>
                        <span class="text-[10px] text-theme-muted ml-2 text-right">${timeString}</span>
                    </div>
                `;
            });
            historyList.innerHTML = html;
        } catch (e) {
            console.error("Error loading history:", e);
            historyList.innerHTML = '<div class="text-center text-xs text-red-500 py-6">Failed to load history.</div>';
        }
    });
};

async function deleteMyAccount() {
    const confirmed = confirm(
        "⚠️ Delete your account?\n\n" +
        "This will permanently delete:\n" +
        "• Your email from our database\n" +
        "• Your encrypted Notion keys\n\n" +
        "This action cannot be undone."
    );
    if (!confirmed) return;

    const doubleConfirm = confirm("Are you absolutely sure? This is permanent.");
    if (!doubleConfirm) return;

    try {
        if (!auth.currentUser) { alert('Please sign in first.'); return; }
        const token = await auth.currentUser.getIdToken();
        const res = await fetch('/deleteUserAccount', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
        });
        const data = await parseJsonResponse(res);
        if (!res.ok) throw new Error(data.error || "Delete failed");

        alert("✅ Your account data has been permanently deleted.");
        // Notify native app to clear SecureStore tokens (mobile sign-out path)
        if (window.ReactNativeWebView) {
            window.ReactNativeWebView.postMessage('SIGNOUT');
        }
        auth.signOut();
    } catch (err) {
        console.error("Delete error:", err);
        alert("Failed to delete account: " + err.message);
    }
}

// --- 4. THEME LOGIC (Dropdown & Auto) ---
const themeBtn = document.getElementById('theme-btn');
const themeMenu = document.getElementById('theme-dropdown');

// Toggle Dropdown
themeBtn?.addEventListener('click', () => {
    themeMenu.classList.toggle('active');
});

// Theme items use data-theme attribute instead of inline onclick
document.querySelectorAll('.theme-item[data-theme]').forEach(item => {
    item.addEventListener('click', () => {
        const mode = item.dataset.theme;
        localStorage.setItem('theme', mode);
        applyTheme(mode);
        themeMenu.classList.remove('active');
    });
});

// Close when clicking outside
document.addEventListener('click', (e) => {
    if (themeBtn && themeMenu && !themeBtn.contains(e.target) && !themeMenu.contains(e.target)) {
        themeMenu.classList.remove('active');
    }
});

function applyTheme(mode) {
    const html = document.documentElement;
    const items = document.querySelectorAll('.theme-item');
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyThemeHelper(mode, html, themeBtn, items, systemDark);
}

// Init Theme
(() => {
    const saved = localStorage.getItem('theme') || 'auto'; // Default to Auto
    applyTheme(saved);

    // Listen for System Changes
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
        if (localStorage.getItem('theme') === 'auto') {
            // Re-apply auto logic if system changes
            applyTheme('auto');
        }
    });
})();

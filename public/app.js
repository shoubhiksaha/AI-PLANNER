// AI Planner — Main Application Module
// Extracted from inline <script type="module"> for CSP compliance

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, connectAuthEmulator, signInWithEmailAndPassword, createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-auth.js";

// FIREBASE CONFIG
const firebaseConfig = {
    apiKey: "AIzaSyBRVEfF58gL3yxQ2UY-_lMgftPnFrZ0_T0",
    authDomain: "ai-planner-project-467800.firebaseapp.com",
    projectId: "ai-planner-project-467800",
    storageBucket: "ai-planner-project-467800.firebasestorage.app",
    messagingSenderId: "195957114195",
    appId: "1:195957114195:web:06bf15f172f55d2ff3cda6"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

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
    getApiUrls,
    switchView: switchViewHelper,
    applyTheme: applyThemeHelper,
} = helpers;

// --- GLOBAL ERROR HANDLING (GCP Error Reporting) ---
const logToGCP = (errorEvent) => {
    try {
        const errorData = {
            message: errorEvent.message || errorEvent.reason?.message || "Unknown error",
            stack: errorEvent.error?.stack || errorEvent.reason?.stack || "",
            url: window.location.href,
            line: errorEvent.lineno,
            column: errorEvent.colno,
            userEmail: currentUser?.email
        };

        const { PRIMARY_API_URL } = getApiUrls(window.location.hostname, 'logClientError');
        const targetUrl = PRIMARY_API_URL;
        // Fire and forget via fetch to avoid blocking the main thread
        fetch(targetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(errorData),
            keepalive: true // Ensure request finishes even if page closes
        }).catch(() => { }); // Swallow errors during error logging
    } catch (e) { /* failsafe */ }
};

window.addEventListener('error', logToGCP);
window.addEventListener('unhandledrejection', logToGCP);

// NAVIGATION
const switchView = (viewId) => {
    switchViewHelper(viewId);
};

const buildGoogleProvider = () => {
    const provider = new GoogleAuthProvider();
    provider.addScope('https://www.googleapis.com/auth/calendar.events');
    provider.addScope('https://www.googleapis.com/auth/tasks');
    provider.addScope('https://www.googleapis.com/auth/drive.file'); // Required for creating/editing the Expense Spreadsheet during Evening Sync
    return provider;
};

// Mobile detection: Use redirect instead of popup on phones/tablets
const isMobile = /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent);

const ensureGoogleAccessToken = async (forceRefresh = false) => {
    if (forceRefresh) googleAccessToken = null;
    if (googleAccessToken) return googleAccessToken;
    if (!auth.currentUser) throw new Error("Please sign in again.");

    if (isMobile) {
        // Mobile: always use redirect (popups are unreliable on phones)
        await signInWithRedirect(auth, buildGoogleProvider());
        return; // Page will reload after redirect
    }

    try {
        const result = await signInWithPopup(auth, buildGoogleProvider());
        const credential = GoogleAuthProvider.credentialFromResult(result);
        if (!credential?.accessToken) throw new Error("Failed to acquire Google token.");
        googleAccessToken = credential.accessToken;
        return googleAccessToken;
    } catch (e) {
        if (e.code === 'auth/popup-blocked') {
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
        }
    }
}).catch((err) => console.warn("Redirect result error:", err));

const loginBtn = document.getElementById('login-btn');
loginBtn.addEventListener('click', async () => {
    if (isMobile) {
        // Mobile: skip popup entirely, use full-screen redirect
        await signInWithRedirect(auth, buildGoogleProvider());
        return;
    }

    try {
        const result = await signInWithPopup(auth, buildGoogleProvider());
        const credential = GoogleAuthProvider.credentialFromResult(result);
        googleAccessToken = credential.accessToken;
    } catch (e) {
        if (e.code === 'auth/popup-blocked') {
            await signInWithRedirect(auth, buildGoogleProvider());
            return;
        }
        alert("Login failed: " + e.message);
    }
});

auth.onAuthStateChanged(async (user) => {
    if (user) {
        currentUser = user;
        document.getElementById('user-email').textContent = user.email;
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

document.getElementById('logout-btn').addEventListener('click', () => {
    auth.signOut();
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
        profileUnsubscribe = onSnapshot(userRef, (docSnap) => {
            if (docSnap.exists()) {
                userProfile = docSnap.data();
                updateGamificationUI(userProfile);
            }
        });

        if (snap.exists() && snap.data().notionKey) {
            // User has setup Notion -> Go to Dashboard
            switchView('view-dashboard');
            // Fetch sync history in the background
            loadSyncHistory(user.email);
        } else {
            // No setup -> Go to Setup Screen
            switchView('view-setup');
        }
    } catch (err) {
        console.error("Profile Load Error:", err);
        switchView('view-setup');
    }
}

function updateGamificationUI(data) {
    const tierCredits = data.tierCredits || 0;
    const boosterCredits = data.boosterCredits || 0;
    const currentStreak = data.currentStreak || 0;
    const highestStreak = data.highestStreak || 0;
    const streakFreezes = data.streakFreezes || 0;
    const hasBYOK = !!data.geminiKey || !!data.byokConfig;

    // Head HUD
    document.getElementById('streak-badge').textContent = `🔥 ${currentStreak}`;
    document.getElementById('credits-badge').textContent = hasBYOK ? `🪙 ∞` : `🪙 ${tierCredits + boosterCredits}`;
    
    // Reports Metrics
    document.getElementById('reports-current-streak').textContent = `🔥 ${currentStreak}`;
    document.getElementById('reports-highest-streak').textContent = `${highestStreak}`;
    document.getElementById('reports-streak-freezes').textContent = `❄️ ${streakFreezes}`;
}

// Restore BYOK UI state
const statelessConfigStr = localStorage.getItem('byok_stateless_config');
if (statelessConfigStr) {
    try {
        const config = JSON.parse(statelessConfigStr);
        const apiKeyInput = document.getElementById('byok-api-key');
        const providerSelect = document.getElementById('byok-provider');
        const statelessRadio = document.querySelector('input[name="byok-mode"][value="stateless"]');
        if (apiKeyInput && statelessRadio && providerSelect) {
            apiKeyInput.value = config.apiKey;
            if (config.provider === 'openai' && config.customUrl) {
                providerSelect.value = 'custom:custom';
                document.getElementById('byok-custom-fields').classList.remove('hidden');
                document.getElementById('byok-custom-url').value = config.customUrl;
                document.getElementById('byok-custom-model').value = config.modelName;
            } else {
                providerSelect.value = `${config.provider}:${config.modelName}`;
            }
            statelessRadio.checked = true;
        }
    } catch(e){}
} else {
    const statelessKey = localStorage.getItem('byok_stateless_key');
    if (statelessKey) {
        const apiKeyInput = document.getElementById('byok-api-key');
        if (apiKeyInput) apiKeyInput.value = statelessKey;
        document.querySelector('input[name="byok-mode"][value="stateless"]').checked = true;
    }
}

// Provider dropdown toggle
document.getElementById('byok-provider')?.addEventListener('change', (e) => {
    const customFields = document.getElementById('byok-custom-fields');
    if (e.target.value === 'custom:custom') {
        customFields.classList.remove('hidden');
    } else {
        customFields.classList.add('hidden');
    }
});

document.getElementById('save-setup-btn').addEventListener('click', async () => {
    const key = document.getElementById('setup-key').value;
    const dbId = document.getElementById('setup-db').value;
    
    // BYOK Config
    const byokMode = document.querySelector('input[name="byok-mode"]:checked').value;
    const byokKey = document.getElementById('byok-api-key').value.trim();
    const providerVal = document.getElementById('byok-provider').value;
    
    let provider, modelName, customUrl;
    if (providerVal === 'custom:custom') {
        provider = 'openai'; // OpenAI compatible
        customUrl = document.getElementById('byok-custom-url').value.trim();
        modelName = document.getElementById('byok-custom-model').value.trim();
        if (byokKey && (!customUrl || !modelName)) {
            alert("Please provide the Custom Base URL and Model Name");
            return;
        }
    } else {
        [provider, modelName] = providerVal.split(':');
    }

    if (!key || !dbId) {
        if (!confirm("Notion fields are empty. You won't be able to use Journal mode. Continue anyway?")) return;
    }

    const saveBtn = document.getElementById('save-setup-btn');
    const originalText = saveBtn.innerText;
    saveBtn.innerText = "Securing...";
    saveBtn.disabled = true;

    try {
        const token = await ensureGoogleAccessToken();

        // Save Notion Keys
        if (key && dbId) {
            const res = await fetch('/setupNotion', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, notionKey: key, notionDbId: dbId })
            });
            if (!res.ok) throw new Error("Failed to secure Notion keys.");
        }

        // Save BYOK Keys
        if (byokKey) {
            const byokConfig = { apiKey: byokKey, provider, modelName, customUrl };
            if (byokMode === 'stateless') {
                localStorage.setItem('byok_stateless_config', JSON.stringify(byokConfig));
                localStorage.removeItem('byok_stateless_key'); // Clean up old
            } else if (byokMode === 'kms') {
                localStorage.removeItem('byok_stateless_config');
                localStorage.removeItem('byok_stateless_key');
                const byokRes = await fetch('/setupBYOK', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token, apiKey: byokKey, provider, modelName, baseUrl: customUrl })
                });
                if (!byokRes.ok) throw new Error("Failed to securely envelope BYOK keys.");
            }
        } else {
            localStorage.removeItem('byok_stateless_config');
            localStorage.removeItem('byok_stateless_key');
        }

        switchView('view-dashboard');
    } catch (err) {
        console.error("Failed to save settings:", err);
        alert("Could not save settings securely. Please try again.");
    } finally {
        saveBtn.innerText = originalText;
        saveBtn.disabled = false;
    }
});

document.getElementById('skip-setup-btn').addEventListener('click', () => {
    switchView('view-dashboard');
});

// Guide Modal
const modal = document.getElementById('guide-modal');
document.getElementById('open-guide').addEventListener('click', () => {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
});
document.getElementById('close-guide').addEventListener('click', () => {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
});

// --- 3. DASHBOARD LOGIC ---
const fileInput = document.getElementById('file-upload');
const dashPreview = document.getElementById('dash-preview');
const uploadUi = document.getElementById('upload-ui');
const dashBtns = document.querySelectorAll('.dash-btn');
const dropZone = document.getElementById('drop-zone');

const updateDashButtons = (enabled) => {
    dashBtns.forEach(b => b.disabled = !enabled);
};
updateDashButtons(false);

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
                    <div class="h-24 w-20 shrink-0 border-2 border-dashed border-theme-border flex flex-col items-center justify-center text-theme-muted hover:text-theme-text hover:border-theme-text transition-colors rounded-lg bg-theme-bg/50">
                        <span class="text-2xl font-light mb-1">+</span>
                        <span class="text-[10px]">Add</span>
                    </div>
                ` : ''}
            </div>
            <div class="absolute bottom-2 right-2 bg-emerald-500/90 text-white text-xs px-2 py-1 rounded-full font-medium pointer-events-none shadow-sm">
                ${filesAsBase64.length}/5 Page${filesAsBase64.length > 1 ? 's' : ''}
            </div>
        `;

        // Add event listeners to delete buttons
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
        dropZone.innerHTML = `
            <div id="upload-ui" class="text-center group-hover:scale-105 transition-transform pointer-events-none">
                <span class="text-3xl block mb-2">📸</span>
                <span class="text-sm font-medium text-theme-muted">Tap to Upload or Drag & Drop (Max 5)</span>
            </div>
        `;
        updateDashButtons(false);
    }

    // Reset file input so selecting the same file again works
    fileInput.value = '';
};

// File Handler with Compression & HEIC Support
const handleFiles = async (files) => {
    if (!files || files.length === 0) return;

    // Feature Guarding: Check limits based on Tier
    const tier = userProfile?.tier || 'free';
    const limit = tier === 'free' ? 1 : tier === 'standard' ? 3 : 5;
    const remainingSlots = limit - filesAsBase64.length;

    if (remainingSlots <= 0) {
        document.getElementById('paywall-message').textContent = tier === 'free' 
            ? "Free tier is limited to 1 page per document. Upgrade to Standard or Pro to batch upload multiple pages!"
            : "Standard tier limit reached. Upgrade to Pro for 5-page batch uploads!";
        document.getElementById('paywall-modal').classList.remove('hidden');
        document.getElementById('paywall-modal').classList.add('flex');
        return;
    }

    const filesToProcess = Array.from(files).slice(0, remainingSlots);
    if (files.length > remainingSlots) {
        document.getElementById('paywall-message').textContent = tier === 'free' 
            ? `Free tier is limited to 1 page per document. Only the first image was added. Upgrade to batch upload!`
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
            // Security: 20MB Limit per file
            if (file.size > 20 * 1024 * 1024) {
                alert(`${file.name} is too large. Images must be under 20MB.`);
                continue;
            }

            const base64Data = await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = (ev) => {
                    const img = new Image();
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
                reader.readAsDataURL(file);
            });
            filesAsBase64.push(base64Data);
        }
    }

    renderThumbnails();
};

// Click Upload
fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

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
document.getElementById('btn-morning').addEventListener('click', () => triggerSync('morning'));
document.getElementById('btn-night').addEventListener('click', () => triggerSync('night'));
document.getElementById('btn-journal').addEventListener('click', () => triggerSync('journal'));

const triggerSync = async (syncType) => {
    // UI Loading with Granular Messages
    const loader = document.getElementById('dash-loader');
    loader.style.display = 'flex';
    const statusArea = document.getElementById('status-area');
    statusArea.classList.remove('hidden', 'text-red-600', 'bg-red-50', 'text-green-600', 'bg-green-50');
    statusArea.classList.add('text-blue-600', 'bg-blue-50');
    statusArea.textContent = "Compressing Image..."; // Initial State

    updateDashButtons(false);

    // Granular Progress Timer (Simulated for UX)
    const steps = [
        { t: 1000, msg: "Uploading to Secure Cloud..." },
        { t: 5000, msg: "AI is Reading Handwriting..." },
        { t: 15000, msg: "Extracting Tasks & Events..." },
        { t: 25000, msg: "Syncing with Notion & Google..." },
        { t: 40000, msg: "Almost there..." }
    ];

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
        let res;
        let data;
        let attempt = 0;
        let currentToken = await ensureGoogleAccessToken();

        while (attempt < 2) {
            const payload = {
                token: currentToken,
                images: filesAsBase64,
                syncType,
                timeZone: clientTimeZone
            };

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 minutes Frontend Timeout

            // Inject BYOK Stateless Token if it exists
            const fetchHeaders = { 'Content-Type': 'application/json' };
            const storedConfigStr = localStorage.getItem('byok_stateless_config');
            if (storedConfigStr) {
                try {
                    const config = JSON.parse(storedConfigStr);
                    fetchHeaders['X-BYOK-Token'] = config.apiKey;
                    fetchHeaders['X-BYOK-Provider'] = config.provider;
                    fetchHeaders['X-BYOK-Model'] = config.modelName;
                    if (config.customUrl) fetchHeaders['X-BYOK-BaseURL'] = config.customUrl;
                } catch(e) {}
            } else {
                const storedToken = localStorage.getItem('byok_stateless_key');
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

            if (res.status === 401 && attempt === 0) {
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

        document.getElementById('file-upload').value = ''; // Reset input
        filesAsBase64 = [];
        document.getElementById('upload-ui').innerHTML = `
            <span class="text-4xl block mb-2 opacity-80">📸</span>
            <span class="text-sm font-medium text-theme-muted mb-1">Tap to Upload or Drag & Drop (Max 5)</span>
            <span class="text-xs text-theme-muted opacity-75">e.g., Take a photo of your handwritten planner</span>
            <div class="absolute inset-0 opacity-5 bg-[url('https://images.unsplash.com/photo-1517842645767-c639042777db?auto=format&fit=crop&w=800&q=80')] bg-cover bg-center mix-blend-overlay rounded-xl z-0 pointer-events-none"></div>
        `;
        updateDashButtons(false);

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
        updateDashButtons(true);
    }
};

// --- GDPR: Export & Delete ---
document.getElementById('btn-export').addEventListener('click', exportMyData);
document.getElementById('btn-delete-account').addEventListener('click', deleteMyAccount);

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
        a.download = `ai - planner - data - ${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
    } catch (err) {
        console.error("Export error:", err);
        alert("Failed to export data: " + err.message);
    }
}

// History Navigation
document.getElementById('toggle-history-btn').addEventListener('click', () => {
    switchView('view-history');
    if (currentUser) loadSyncHistory(currentUser.email);
});
document.getElementById('back-to-dash-btn').addEventListener('click', () => {
    switchView('view-dashboard');
});

// Reports Navigation
document.getElementById('toggle-reports-btn').addEventListener('click', () => {
    switchView('view-reports');
    if (currentUser) loadHeatmap(currentUser.email);
});
document.getElementById('back-to-dash-btn-reports').addEventListener('click', () => {
    switchView('view-dashboard');
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
document.getElementById('close-paywall').addEventListener('click', () => {
    document.getElementById('paywall-modal').classList.add('hidden');
    document.getElementById('paywall-modal').classList.remove('flex');
});

const handlePaymentClick = (e, tierName) => {
    // Placeholder for Cashfree SDK integration
    const btn = e.currentTarget;
    const origText = btn.innerHTML;
    btn.innerHTML = `<span class="spinner w-4 h-4 border-white mr-2"></span> Redirecting to Cashfree...`;
    setTimeout(() => {
        alert(`Cashfree Gateway Simulation for ${tierName}. Integration planned for next phase!`);
        btn.innerHTML = origText;
    }, 1500);
};

document.getElementById('buy-booster-btn').addEventListener('click', (e) => handlePaymentClick(e, 'Booster Credits (₹19)'));
document.getElementById('upgrade-standard-btn').addEventListener('click', (e) => handlePaymentClick(e, 'Standard Tier (₹29/mo)'));
document.getElementById('upgrade-pro-btn').addEventListener('click', (e) => handlePaymentClick(e, 'Pro Tier (₹49/mo)'));
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

                const typeIcon = data.syncType === 'morning' ? '☀️' : data.syncType === 'evening' ? '🌙' : '📖';
                const statusColor = data.status === 'success' ? 'text-emerald-600' : 'text-red-500';
                const statusIcon = data.status === 'success' ? '✓' : '⚠️';

                html += `
                    <div class="p-3 border flex justify-between items-center rounded-xl border-theme-border mb-2 bg-theme-bg/50">
                        <div>
                            <span class="font-medium text-theme-text text-sm flex items-center gap-2 mb-1">
                                ${typeIcon} <span class="capitalize">${data.syncType}</span>
                                <span class="text-[10px] text-theme-muted font-normal bg-black/5 dark:bg-white/5 px-2 py-0.5 rounded-full">${data.imageCount || 1} pg</span>
                            </span>
                            <p class="text-xs ${statusColor} font-medium leading-snug">${statusIcon} ${data.message}</p>
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
themeBtn.addEventListener('click', () => {
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

// AI Planner — Main Application Module
// Extracted from inline <script type="module"> for CSP compliance

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js";

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
const db = getFirestore(app);

if (window.location.hostname === "localhost") {
    connectAuthEmulator(auth, "http://127.0.0.1:9099");
}

// STATE
let currentUser = null;
let fileAsBase64 = null;
// Keep OAuth token only in memory (not session/local storage)
let googleAccessToken = null;

// NAVIGATION
const switchView = (viewId) => {
    ['view-login', 'view-setup', 'view-dashboard'].forEach(id => {
        document.getElementById(id).classList.add('view-hidden');
    });
    document.getElementById(viewId).classList.remove('view-hidden');
};

const buildGoogleProvider = () => {
    const provider = new GoogleAuthProvider();
    provider.addScope('https://www.googleapis.com/auth/calendar.events');
    provider.addScope('https://www.googleapis.com/auth/tasks');
    provider.addScope('https://www.googleapis.com/auth/spreadsheets');
    provider.addScope('https://www.googleapis.com/auth/drive.file');
    return provider;
};

// Mobile detection: Use redirect instead of popup on phones/tablets
const isMobile = /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent);

const ensureGoogleAccessToken = async () => {
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

const parseJsonResponse = async (res) => {
    const text = await res.text();
    const contentType = (res.headers.get('content-type') || '').toLowerCase();

    if (!contentType.includes('application/json')) {
        const snippet = text.slice(0, 120).replace(/\s+/g, ' ').trim();
        throw new Error(`Non-JSON API response (${res.status}): ${snippet || 'empty body'}`);
    }

    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error(`Invalid JSON API response (${res.status}).`);
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
        await checkUserSetup(user);
    } else {
        currentUser = null;
        googleAccessToken = null;
        switchView('view-login');
    }
});

document.getElementById('logout-btn').addEventListener('click', () => {
    auth.signOut();
});

// --- 2. SETUP FLOW ---
async function checkUserSetup(user) {
    try {
        // Check Firestore for profile
        const userRef = doc(db, "users", user.email);
        const snap = await getDoc(userRef);

        if (snap.exists() && snap.data().notionKey) {
            // User has setup Notion -> Go to Dashboard
            switchView('view-dashboard');
        } else {
            // No setup -> Go to Setup Screen
            switchView('view-setup');
        }
    } catch (err) {
        console.error("Profile Load Error:", err);
        switchView('view-setup');
    }
}

document.getElementById('save-setup-btn').addEventListener('click', async () => {
    const key = document.getElementById('setup-key').value;
    const dbId = document.getElementById('setup-db').value;
    if (!key || !dbId) return alert("Please fill both fields");

    const saveBtn = document.getElementById('save-setup-btn');
    const originalText = saveBtn.innerText;
    saveBtn.innerText = "Securing...";
    saveBtn.disabled = true;

    try {
        const token = await ensureGoogleAccessToken();

        // Send raw key to backend to be encrypted and saved securely
        const res = await fetch('/setupNotion', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                token,
                notionKey: key,
                notionDbId: dbId
            })
        });

        if (!res.ok) throw new Error("Failed to secure keys.");

        // Optimistic switch
        switchView('view-dashboard');
    } catch (err) {
        console.error("Failed to save Notion settings:", err);
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
document.getElementById('open-guide').addEventListener('click', () => modal.classList.remove('hidden'));
document.getElementById('close-guide').addEventListener('click', () => modal.classList.add('hidden'));

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

// File Handler with Compression & HEIC Support
const handleFile = async (file) => {
    if (!file) return;

    // Handle HEIC/HEIF conversion
    if (file.type === "image/heic" || file.type === "image/heif" || file.name.toLowerCase().endsWith('.heic')) {
        console.log("HEIC detected. Converting...");
        try {
            const blob = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.8 });
            // heic2any returns a blob or blob array. Handle single file.
            const convertedBlob = Array.isArray(blob) ? blob[0] : blob;
            file = new File([convertedBlob], file.name.replace(/\.heic$/i, ".jpg"), { type: "image/jpeg" });
        } catch (e) {
            console.error("HEIC Conversion failed:", e);
            alert("Could not convert HEIC image. Please use JPG.");
            return;
        }
    }

    if (file.type.startsWith('image/')) {
        // Security: 20MB Limit
        if (file.size > 20 * 1024 * 1024) {
            alert("File is too large. Please upload an image smaller than 20MB.");
            return;
        }

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

                // Compress to JPEG 70%
                fileAsBase64 = canvas.toDataURL('image/jpeg', 0.7);

                dashPreview.src = fileAsBase64;
                dashPreview.classList.remove('hidden');
                uploadUi.classList.add('hidden');
                updateDashButtons(true);
                console.log(`Original: ${(file.size / 1024).toFixed(2)}KB, Compressed: ${(fileAsBase64.length / 1024).toFixed(2)}KB`);
            };
            img.src = ev.target.result;
        };
        reader.readAsDataURL(file);
    } else {
        alert("Please upload an image file.");
    }
};

// Click Upload
fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));

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

function highlight(e) { dropZone.classList.add('bg-blue-50', 'border-blue-400'); }
function unhighlight(e) { dropZone.classList.remove('bg-blue-50', 'border-blue-400'); }

dropZone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    handleFile(files[0]);
});

window.triggerSync = async (syncType) => {
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
        // Ensure a fresh/in-memory token when needed (no browser storage persistence)
        const token = await ensureGoogleAccessToken();

        // Primary route uses Hosting rewrite. Fallback hits function directly.
        const PRIMARY_API_URL = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
            ? "http://127.0.0.1:5001/ai-planner-project-467800/us-central1/syncPlanner"
            : "/syncPlanner";
        const FALLBACK_API_URL = "https://syncplanner-xeh5qbnxga-uc.a.run.app";

        const payload = {
            token: token,
            imageData: fileAsBase64,
            syncType
        };

        // Note: We no longer send Notion keys in the payload for security.
        // The backend automatically retrieves them securely from Firestore.

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 minutes Frontend Timeout

        let res;
        let data;
        try {
            res = await fetch(PRIMARY_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            data = await parseJsonResponse(res);
        } catch (primaryErr) {
            console.warn("Primary API route failed, retrying direct function URL.", primaryErr);
            res = await fetch(FALLBACK_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            data = await parseJsonResponse(res);
        }

        clearTimeout(timeoutId);
        timers.forEach(t => clearTimeout(t)); // Stop simulated progress

        if (res.ok) {
            statusArea.classList.remove('text-red-600', 'bg-red-50', 'text-blue-600', 'bg-blue-50');
            statusArea.classList.add('text-green-600', 'bg-green-50');
            statusArea.textContent = `Success! ${data.text}`;
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

// --- 4. THEME LOGIC (Dropdown & Auto) ---
const themeBtn = document.getElementById('theme-btn');
const themeMenu = document.getElementById('theme-dropdown');

// Toggle Dropdown
window.toggleMenu = () => {
    themeMenu.classList.toggle('active');
};

// Close when clicking outside
document.addEventListener('click', (e) => {
    if (themeBtn && themeMenu && !themeBtn.contains(e.target) && !themeMenu.contains(e.target)) {
        themeMenu.classList.remove('active');
    }
});

window.selectTheme = (mode) => {
    localStorage.setItem('theme', mode); // Save preference
    applyTheme(mode);
    themeMenu.classList.remove('active'); // Close menu
};

function applyTheme(mode) {
    const html = document.documentElement;
    const items = document.querySelectorAll('.theme-item');
    let effect = mode;

    // Resolve Auto
    if (mode === 'auto') {
        const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        effect = systemDark ? 'dark' : 'light';
    }

    // Apply Classes
    html.classList.remove('dark-mode', 'oled-mode');
    if (effect === 'dark') html.classList.add('dark-mode');
    if (effect === 'oled') html.classList.add('oled-mode');

    // Update Icon
    if (!themeBtn) return;

    if (mode === 'auto') themeBtn.textContent = '⚙️';
    else if (mode === 'light') themeBtn.textContent = '☀️';
    else if (mode === 'dark') themeBtn.textContent = '🌙';
    else if (mode === 'oled') themeBtn.textContent = '🖤';

    // Highlight Selection
    items.forEach(el => {
        el.classList.remove('selected');
        if (el.textContent.toLowerCase().includes(mode)) el.classList.add('selected');
    });
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

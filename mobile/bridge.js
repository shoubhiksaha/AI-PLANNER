// Pure helpers for the native <-> WebView bridge (contract C7).
// No React Native imports here so the logic can be unit-tested with `node --test`.

export const PROD_ORIGIN = 'https://planner.analogdigital.tech';
export const STAGING_ORIGIN = 'https://staging-planner.analogdigital.tech';
export const APP_ORIGINS = [PROD_ORIGIN, STAGING_ORIGIN];

// Pages that are not part of the signed-in app shell. They never define the
// login bridge, so they open in the system browser sheet instead of the WebView.
const EXTERNAL_PAGE_PATHS = [
  '/pricing-policy', '/pricing-policy.html',
  '/refund-policy', '/refund-policy.html',
  '/planner', '/planner.html',
  '/gear', '/gear.html',
  '/privacy', '/privacy.html',
];

// Schemes handed to the OS (UPI apps, dialer, mail...). Anything not listed and
// not http(s) is still offered to the OS; only these are known to be blocked.
const BLOCKED_SCHEMES = ['javascript:', 'file:', 'content:'];

// Regex-based parser: React Native's URL polyfill only implements part of the spec.
export function parseUrl(url) {
  const empty = { protocol: '', host: '', origin: '', pathname: '' };
  if (typeof url !== 'string' || !url) return empty;
  const schemeMatch = url.match(/^([a-zA-Z][a-zA-Z\d+\-.]*):/);
  if (!schemeMatch) return empty;
  const protocol = schemeMatch[1].toLowerCase() + ':';
  if (protocol !== 'http:' && protocol !== 'https:') {
    return { ...empty, protocol };
  }
  const m = url.match(/^[a-zA-Z]+:\/\/(?:[^@/?#]*@)?([^:/?#]+)(:\d+)?([^?#]*)/);
  if (!m) return { ...empty, protocol };
  const host = m[1].toLowerCase();
  const port = m[2] || '';
  const defaultPort = (protocol === 'https:' && port === ':443') || (protocol === 'http:' && port === ':80');
  return {
    protocol,
    host,
    origin: `${protocol}//${host}${defaultPort ? '' : port}`,
    pathname: m[3] || '/',
  };
}

// Only the two known app origins may be used as the WebView base URL.
export function resolveWebBaseUrl(configured) {
  const { origin } = parseUrl(configured);
  return APP_ORIGINS.includes(origin) ? origin : PROD_ORIGIN;
}

export function isAllowedAppOrigin(url, allowedOrigins = APP_ORIGINS) {
  return allowedOrigins.includes(parseUrl(url).origin);
}

export function isLoginPath(pathname) {
  return pathname === '/' || pathname === '/index.html';
}

export function isExternalPagePath(pathname) {
  return EXTERNAL_PAGE_PATHS.includes((pathname || '').toLowerCase());
}

export function isCashfreeHost(host) {
  return host === 'cashfree.com' || host.endsWith('.cashfree.com');
}

/**
 * Decide what to do with a WebView navigation request.
 * @returns {'allow'|'browser'|'linking'|'block'}
 *   allow   - load inside the WebView
 *   browser - open in WebBrowser (in-app browser sheet), cancel in WebView
 *   linking - hand to the OS via Linking.openURL (UPI, intent, mailto, tel...)
 *   block   - cancel and do nothing
 */
export function classifyNavigation(request, appOrigin) {
  const url = request && request.url;
  if (!url || typeof url !== 'string') return 'block';
  const lower = url.toLowerCase();
  if (lower.startsWith('about:') || lower.startsWith('data:') || lower.startsWith('blob:')) {
    return 'allow';
  }

  const { protocol, host, origin, pathname } = parseUrl(url);
  if (!protocol || BLOCKED_SCHEMES.includes(protocol)) return 'block';
  if (protocol !== 'http:' && protocol !== 'https:') return 'linking';

  // Sub-frames (Cashfree checkout modal, 3-D Secure bank pages) stay in place.
  if (request.isTopFrame === false) return 'allow';

  if (isCashfreeHost(host)) return 'allow';

  if (origin === appOrigin) {
    if (isExternalPagePath(pathname) || pathname.toLowerCase().endsWith('.pdf')) return 'browser';
    return 'allow';
  }

  return 'browser';
}

const originGuard = (allowedOrigins) => `
  var ALLOWED_ORIGINS = ${JSON.stringify(allowedOrigins)};
  if (ALLOWED_ORIGINS.indexOf(window.location.origin) === -1) { return; }`;

/** Script that hands the access token to the page via window.mobileUpdateAccessToken. */
export function buildTokenUpdateScript(accessToken, allowedOrigins = APP_ORIGINS) {
  return `
(function() {${originGuard(allowedOrigins)}
  if (typeof window.mobileUpdateAccessToken !== 'function') { return; }
  try {
    window.mobileUpdateAccessToken(${JSON.stringify(accessToken ?? null)});
  } catch (e) {}
})();
true;
`;
}

/** Login + native UI glue script. Runs only on the app shell (/ or /index.html) of an app origin. */
export function buildLoginScript({ idToken, accessToken }, allowedOrigins = APP_ORIGINS) {
  return `
(function() {${originGuard(allowedOrigins)}
  var path = window.location.pathname;
  if (path !== '/' && path !== '/index.html') { return; }

  var retryCount = 0;
  var maxRetries = 20;

  function postNative(type, payload) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: type, payload: payload || {} }));
  }

  function failBridge(message) {
    postNative('MOBILE_LOGIN_ERROR', { message: message });
  }

  // Last resort when window.mobileLogin never appears: a stale service worker may be
  // serving an old bundle, so unregister it once and reload. Normal loads keep the SW.
  function reloadWithoutServiceWorker() {
    var nextUrl = new URL(window.location.href);
    if (nextUrl.searchParams.get('mobileBridgeReload') === '1') {
      failBridge('Mobile login bridge was unavailable after a clean reload.');
      return;
    }
    nextUrl.searchParams.set('mobileBridgeReload', '1');
    var go = function() { window.location.replace(nextUrl.toString()); };
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(function(registrations) {
        return Promise.all(registrations.map(function(r) { return r.unregister(); }));
      }).then(go, go);
    } else {
      go();
    }
  }

  function tryLogin() {
    if (window.__AI_PLANNER_NATIVE_LOGIN_COMPLETE || window.__AI_PLANNER_NATIVE_LOGIN_PENDING) {
      setupUI();
      return;
    }

    if (typeof window.mobileLogin === 'function') {
      window.__AI_PLANNER_NATIVE_LOGIN_PENDING = true;
      Promise.resolve(window.mobileLogin(${JSON.stringify(idToken ?? null)}, ${JSON.stringify(accessToken ?? null)}))
        .then(function() {
          window.__AI_PLANNER_NATIVE_LOGIN_COMPLETE = true;
          window.__AI_PLANNER_NATIVE_LOGIN_PENDING = false;
          setupUI();
        })
        .catch(function(error) {
          window.__AI_PLANNER_NATIVE_LOGIN_PENDING = false;
          if (!window.__AI_PLANNER_NATIVE_LOGIN_ERROR_POSTED) {
            failBridge(error && error.message ? error.message : 'Mobile login bridge failed.');
          }
        });
    } else if (retryCount < maxRetries) {
      retryCount++;
      setTimeout(tryLogin, 500);
    } else {
      reloadWithoutServiceWorker();
    }
  }

  function setupUI() {
    if (window.__AI_PLANNER_NATIVE_UI_READY) { return; }
    window.__AI_PLANNER_NATIVE_UI_READY = true;

    document.addEventListener('click', function(e) {
      var logoutTarget = e.target.closest('[data-drawer="logout"], #btn-logout');
      if (logoutTarget) {
        window.ReactNativeWebView.postMessage('SIGNOUT');
        return;
      }
      var target = e.target.closest('button, a, input[type="submit"], .dash-btn');
      if (target) {
        var isHeavy = (target.innerText || '').toLowerCase().includes('sync');
        window.ReactNativeWebView.postMessage(isHeavy ? 'HAPTIC_HEAVY' : 'HAPTIC_LIGHT');
      }
    }, true);

    // The app colours its status bar, navigation bar and edges like the page: light or dark
    // (class) and the style pack (data-style), read from the page's own background.
    var lastTheme = '';
    function reportTheme() {
      requestAnimationFrame(function() {
        var cl = document.documentElement.classList;
        var theme = {
          dark: cl.contains('dark-mode') || cl.contains('oled-mode'),
          background: getComputedStyle(document.body).backgroundColor
        };
        var key = JSON.stringify(theme);
        if (key === lastTheme) { return; }
        lastTheme = key;
        postNative('THEME', theme);
      });
    }
    new MutationObserver(reportTheme)
      .observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-style'] });
    reportTheme();
  }

  tryLogin();
})();
true;
`;
}

/**
 * Android Back: asks the page to close whatever is on top (window.handleNativeBack in
 * public/app.js) and reports BACK_RESULT { handled }. Pages without the handler report false.
 */
export function buildBackScript(allowedOrigins = APP_ORIGINS) {
  return `
(function() {${originGuard(allowedOrigins)}
  var handled = false;
  try {
    handled = typeof window.handleNativeBack === 'function' && window.handleNativeBack() === true;
  } catch (e) {}
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BACK_RESULT', payload: { handled: handled } }));
})();
true;
`;
}

/**
 * Tells the page whether Android granted the camera (window.__aiPlannerCameraAllowed, read by
 * public/app.js). With reopen, the camera input the person tapped is opened again.
 */
export function buildCameraStateScript(allowed, { reopen = false } = {}, allowedOrigins = APP_ORIGINS) {
  return `
(function() {${originGuard(allowedOrigins)}
  window.__aiPlannerCameraAllowed = ${allowed ? 'true' : 'false'};
  var pending = window.__aiPlannerPendingCamera;
  window.__aiPlannerPendingCamera = null;
  if (${reopen && allowed ? 'true' : 'false'} && pending && document.contains(pending)) {
    try { pending.click(); } catch (e) {}
  }
})();
true;
`;
}

// Screens the app can open from an icon shortcut or a reminder (aiplanner://scan and so on).
export const APP_LINK_TARGETS = ['scan', 'history', 'reports'];

/** The screen an aiplanner:// link asks for, or null. Accepts aiplanner://scan and aiplanner:///scan. */
export function parseAppLink(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/^aiplanner:\/\/\/?([a-z]+)\/?(?:[?#].*)?$/i);
  const target = m && m[1].toLowerCase();
  return APP_LINK_TARGETS.includes(target) ? target : null;
}

/**
 * Tells the page what the app can do (window.__aiPlannerApp, read by public/app.js):
 * { scanner: boolean, reminders: { morning: { on, time }, evening: { on, time } } | null }.
 */
export function buildAppStateScript(state, allowedOrigins = APP_ORIGINS) {
  return `
(function() {${originGuard(allowedOrigins)}
  window.__aiPlannerApp = ${JSON.stringify(state ?? {})};
  try { if (typeof window.aiPlannerAppStateChanged === 'function') { window.aiPlannerAppStateChanged(); } } catch (e) {}
})();
true;
`;
}

/** Opens a screen in the page (window.aiPlannerOpen in public/app.js). */
export function buildOpenScript(target, allowedOrigins = APP_ORIGINS) {
  if (!APP_LINK_TARGETS.includes(target)) return null;
  return `
(function() {${originGuard(allowedOrigins)}
  try { if (typeof window.aiPlannerOpen === 'function') { window.aiPlannerOpen(${JSON.stringify(target)}); } } catch (e) {}
})();
true;
`;
}

/**
 * Hands photos to the page (window.aiPlannerAddImages in public/app.js) as if they were picked
 * there: [{ name, mimeType, base64 }].
 */
export function buildAddImagesScript(images, allowedOrigins = APP_ORIGINS) {
  return `
(function() {${originGuard(allowedOrigins)}
  try { if (typeof window.aiPlannerAddImages === 'function') { window.aiPlannerAddImages(${JSON.stringify(images)}); } } catch (e) {}
})();
true;
`;
}

/** Shows "Preparing your photos…" in the page while the app gets scanned pages ready. */
export function buildPreparingImagesScript(allowedOrigins = APP_ORIGINS) {
  return `
(function() {${originGuard(allowedOrigins)}
  try { if (typeof window.aiPlannerPreparingImages === 'function') { window.aiPlannerPreparingImages(); } } catch (e) {}
})();
true;
`;
}

/** Most pages one scan may return (the page asks for what fits the plan, SCAN_PAGES). */
export const MAX_SCAN_PAGES = 20;

export function clampScanPages(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_SCAN_PAGES);
}

/** "file:/data/..." (Java's File.toURI, used by expo-sharing for shared files) as "file:///data/...". */
export function normalizeFileUri(uri) {
  return typeof uri === 'string' ? uri.replace(/^file:\/(?!\/)/, 'file:///') : uri;
}

/** Size that fits within max on its longer side, keeping the aspect ratio; null when it already fits. */
export function fitWithin(width, height, max) {
  if (!(width > 0) || !(height > 0) || Math.max(width, height) <= max) return null;
  return width >= height
    ? { width: max, height: Math.round((height * max) / width) }
    : { width: Math.round((width * max) / height), height: max };
}

export const DEFAULT_REMINDERS = {
  morning: { on: false, time: '08:00' },
  evening: { on: false, time: '21:00' },
};

/** "HH:MM" (24-hour) to { hour, minute }, or null. */
export function parseTime(value) {
  const m = typeof value === 'string' && value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

/** Reminder settings from the page or storage, with anything invalid replaced by the default. */
export function normalizeReminders(input) {
  const out = {};
  for (const key of Object.keys(DEFAULT_REMINDERS)) {
    const value = input && typeof input === 'object' ? input[key] : null;
    out[key] = {
      on: value?.on === true,
      time: parseTime(value?.time) ? value.time : DEFAULT_REMINDERS[key].time,
    };
  }
  return out;
}

/** A CSS colour the page reported (THEME) that is safe to use as a native background. */
export function isSafeCssColor(value) {
  return typeof value === 'string'
    && /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\))$/i.test(value.trim());
}

/** Fully transparent colours (rgba(..., 0)) can't paint the edges; the native default is used instead. */
export function isOpaqueCssColor(value) {
  if (!isSafeCssColor(value)) return false;
  const alpha = value.match(/rgba\([^)]*,\s*([\d.]+)\s*\)/i);
  return !alpha || Number(alpha[1]) > 0;
}

/** File name for a file the page asks the app to save (SAVE_FILE): plain characters, one extension. */
export function safeFileName(name, fallback = 'ai-planner-export.json') {
  if (typeof name !== 'string') return fallback;
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '').slice(0, 100);
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9]{1,8}$/.test(cleaned) ? cleaned : fallback;
}

/** NetInfo state that means there is no connection (unknown reachability counts as online). */
export function isOfflineState(state) {
  if (!state) return false;
  return state.isConnected === false || state.isInternetReachable === false;
}

/** True when the error means the Google account must sign in interactively again. */
export function isSignInRequiredError(error, signInRequiredCode) {
  if (!error) return false;
  if (error.signInRequired === true) return true;
  return signInRequiredCode != null && error.code === signInRequiredCode;
}

/** Exponential backoff: base * 2^attempt, capped at max. */
export function backoffDelayMs(attempt, baseMs, maxMs) {
  const n = Math.max(0, attempt | 0);
  return Math.min(maxMs, baseMs * Math.pow(2, n));
}

# CSP Migration Plan

> **Status: ✅ COMPLETE** — All 3 phases implemented and deployed.

## Previous blockers (now resolved)
- ~~Inline scripts in `public/index.html`~~ → Extracted to `public/app.js`
- ~~Inline styles in `public/index.html`~~ → Extracted to `public/styles.css`
- ~~Runtime Tailwind via `https://cdn.tailwindcss.com`~~ → Replaced with prebuilt `public/tailwind.css`
- External font/style/script CDNs → Whitelisted in CSP header

## Phase 1: Prepare ✅
1. ✅ Moved inline JavaScript to `public/app.js` (ES module).
2. ✅ Moved inline CSS to `public/styles.css`.
3. ✅ Replaced Tailwind CDN with prebuilt CSS (`npx tailwindcss -i src/input.css -o public/tailwind.css --minify`).
4. ✅ Third-party hosts explicitly whitelisted: `gstatic.com`, `googleapis.com`, `jsdelivr.net`.

## Phase 2: Enforce CSP ✅
Active CSP policy in `firebase.json` hosting headers:
```
default-src 'self';
script-src 'self' https://www.gstatic.com https://cdn.jsdelivr.net 'sha256-...';
style-src 'self' https://fonts.googleapis.com;
font-src 'self' https://fonts.gstatic.com;
img-src 'self' data: https:;
connect-src 'self' https://*.googleapis.com https://*.firebaseio.com https://*.run.app wss://*.firebaseio.com;
frame-src https://ai-planner-project-467800.firebaseapp.com;
object-src 'none';
base-uri 'self';
frame-ancestors 'none';
upgrade-insecure-requests
```

## Phase 3: Harden ✅
1. ✅ Inline SW registration script whitelisted via SHA-256 hash.
2. ✅ `upgrade-insecure-requests` enabled.
3. ⬜ Reporting endpoint (future: add `report-to` directive for production monitoring).

## Validation checklist
- ✅ Login popup/redirect works.
- ✅ `setupNotion` and `syncPlanner` calls succeed.
- ✅ Service worker registers.
- ✅ Theme switching and file upload still work.
- ✅ Zero CSP violations confirmed via browser DevTools.

## Rebuild Note
After any HTML class changes, regenerate Tailwind CSS:
```bash
npx tailwindcss -i src/input.css -o public/tailwind.css --minify
```

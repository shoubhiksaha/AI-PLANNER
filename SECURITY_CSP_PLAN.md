# CSP Migration Plan

## Current blockers to strict CSP
- Inline scripts in `public/index.html`.
- Inline styles in `public/index.html`.
- Runtime Tailwind via `https://cdn.tailwindcss.com`.
- External font/style/script CDNs.

## Phase 1: Prepare (no behavior change)
1. Move inline JavaScript from `public/index.html` to `public/app.js` (module).
2. Move inline CSS to `public/styles.css`.
3. Replace Tailwind CDN runtime with prebuilt CSS committed to repo.
4. Keep third-party hosts explicit: `gstatic.com`, `googleapis.com`, `jsdelivr.net`, font hosts.

## Phase 2: Enforce moderate CSP
Use a temporary policy in Hosting headers (example):
- `default-src 'self'`
- `script-src 'self' https://www.gstatic.com https://cdn.jsdelivr.net`
- `style-src 'self' https://fonts.googleapis.com`
- `font-src 'self' https://fonts.gstatic.com`
- `img-src 'self' data: https:`
- `connect-src 'self' https://www.googleapis.com https://*.googleapis.com https://*.run.app`
- `object-src 'none'`
- `base-uri 'self'`
- `frame-ancestors 'none'`

## Phase 3: Harden to strict CSP
1. Remove remaining third-party script CDNs.
2. Add nonces/hashes if any inline script must remain.
3. Turn on `upgrade-insecure-requests`.
4. Add reporting endpoint and monitor violations.

## Validation checklist
- Login popup works.
- `setupNotion` and `syncPlanner` calls succeed.
- Service worker registers.
- Theme switching and file upload still work.
- No CSP violations for normal user flow.

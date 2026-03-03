# Project Change Log and Current Architecture

## Scope and method
This document summarizes changes up to commit `8f388e8` (current `main`) and the code currently deployed in:
- `functions/index.js`
- `public/index.html`
- `firebase.json`
- `firestore.rules`

The comparison uses:
- Git history (`d1ae171` -> `22627da` -> `1db6faa` -> `8f388e8`)
- Current runtime behavior in backend + frontend code.

## Change timeline (high-level)
1. `d1ae171` Security cleanup:
- Removed exposed credential artifacts and tightened ignore patterns.

2. `1db6faa` UX/theme improvements:
- Added dynamic theming (light/dark/OLED), license, and docs updates.

3. `22627da` reliability/security guards:
- Added image size limits on client and server.
- Improved error handling and cleanup.

4. `8f388e8` architecture/security hardening:
- Added dedicated Notion setup endpoint.
- Added app-level encryption for Notion key storage.
- Hardened CORS, request validation, hosting headers, and Firestore write policy.
- Added documentation and commented references.

## Before vs now (what changed and why)

### 1) Notion key lifecycle
Before:
- Keys could be passed from frontend in sync flow.
- Storage model was weaker and less explicit.

Now:
- Dedicated setup endpoint `setupNotion` persists keys after validation (`functions/index.js:197`).
- Encrypted-at-rest model with versioned AES-GCM + legacy migration (`functions/index.js:46`, `functions/index.js:80`, `functions/index.js:180`).
- Sync flow reads/decrypts server-side only (`functions/index.js:286`, `functions/index.js:405`).

Why:
- Reduce client exposure and keep integration secrets server-controlled.

### 2) API boundary hardening
Before:
- Broad CORS and weaker request-shape enforcement.

Now:
- Allowed-origin allowlist (`functions/index.js:22`).
- Explicit method and content-type checks (`functions/index.js:203`, `functions/index.js:241`).
- Strict sync type and image data URL validation (`functions/index.js:131`, `functions/index.js:136`, `functions/index.js:250`, `functions/index.js:255`).

Why:
- Lower abuse surface and reject malformed traffic earlier.

### 3) Firestore trust model
Before:
- Client could read and write own `/users/{email}` doc.

Now:
- Client read only; writes denied in rules (`firestore.rules:5`, `firestore.rules:7`).
- User profile writes moved to Admin SDK paths in functions (`functions/index.js:225`).

Why:
- Prevent direct client tampering of sensitive user integration fields.

### 4) Frontend token + endpoint behavior
Before:
- Access token persisted in browser session storage.
- API assumed rewrite success and parsed response directly as JSON.

Now:
- In-memory token only (`public/index.html:479`, `public/index.html:499`).
- Robust non-JSON detection + fallback to direct function URL (`public/index.html:511`, `public/index.html:774`, `public/index.html:777`, `public/index.html:793`).

Why:
- Reduce token persistence risk and avoid runtime failures when hosting rewrites are missing/misrouted.

### 5) Hosting + browser security headers
Before:
- Fewer defensive headers and no explicit function rewrites in hosting config.

Now:
- Added hardening headers and HTML no-store caching (`firebase.json:23`).
- Added explicit rewrites for `/syncPlanner` and `/setupNotion` (`firebase.json:55`).

Why:
- Better browser-side defense baseline and predictable API routing.

### 6) Operational/documentation upgrades
Before:
- Architecture and security decisions were distributed and partially implicit.

Now:
- Added `DESIGN_AND_DECISIONS.md`, `SECURITY_CSP_PLAN.md`, `public/index_commented.html`, and `functions/planner_v3_draft.js`.

Why:
- Improve maintainability, onboarding, and future hardening roadmap.

## Current system architecture (present project)

```mermaid
graph TD
    A[User Browser PWA<br/>public/index.html] --> B[Firebase Auth Popup]
    B --> A

    A -->|POST /setupNotion<br/>token + notionKey + notionDbId| C[setupNotion Function<br/>functions/index.js]
    A -->|POST /syncPlanner<br/>token + imageData + syncType| D[syncPlanner Function<br/>functions/index.js]
    A -->|Fallback on non-JSON| E[Cloud Run URL<br/>syncplanner-...run.app]
    E --> D

    C -->|OAuth userinfo validate| F[Google OAuth APIs]
    D -->|OAuth userinfo validate| F

    C -->|encrypt key + store| G[Firestore users/{email}]
    D -->|read user config| G
    D -->|decrypt + migrate legacy format| G

    D -->|image parse + prompt| H[Gemini API]
    H -->|structured JSON| D

    D -->|morning| I[Google Calendar]
    D -->|morning/evening| J[Google Tasks]
    D -->|evening| K[Google Sheets]
    D -->|journal/evening file upload| L[Notion API]
    L --> M[Notion Workspace Storage]

    N[Firebase Hosting<br/>firebase.json] -->|rewrites /setupNotion /syncPlanner| C
    N -->|rewrites /setupNotion /syncPlanner| D
    N -->|security headers| A

    O[Firestore Rules] -->|allow read own doc| A
    O -->|deny client writes| A
```

## Notes on current constraints
- Runtime remains Node 20 in `functions/package.json`; upgrade is pending deprecation timeline.
- `GEMINI_API_KEY` currently uses `defineString` in code (`functions/index.js:16`), while `NOTION_ENCRYPTION_KEY` uses Secret Manager (`functions/index.js:17`).
- CSP hardening is planned but not fully enforced yet; see `SECURITY_CSP_PLAN.md`.

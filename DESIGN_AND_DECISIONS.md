# Design Decisions & Project Documentation

This document records the architectural choices, design philosophy, and security engineering behind the AI Planner project. Updated to reflect the current deployed state.

## 1. Core Philosophy: "Zero Storage" Architecture

### Decision
The project avoids storing user data (images, analyzed text, planner contents) in its own persistent database.

### Rationale
- **Privacy First**: Data flows *through* our server, not *into* it. We cannot access user journals even if compelled.
- **Cost Efficiency**: No cloud storage bills for user images.
- **Compliance**: Simplifies GDPR/CCPA. We are the **data controller** (we decide what to collect), but minimize data liability by storing almost nothing. Google and Notion are our **processors**. The only data we persist is the user's email and their encrypted Notion keys in Firestore.

### Implementation
- Images are received via HTTP, held in memory (RAM), processed by AI, sent to external services (Notion/Google), and immediately discarded.
- We use `firebase-functions` with 1GiB memory to handle transient heavy payloads without writing to disk.

---

## 2. Serverless Backend (Firebase Functions Gen 2)

### Decision
All backend logic runs on Firebase Cloud Functions (Gen 2), deployed as Cloud Run services.

### Rationale
- **Scale-to-Zero**: Costs nothing when not in use; scales up automatically during morning/evening usage bursts.
- **Native Integration**: Firebase Admin SDK and Google Cloud APIs are first-class citizens.

### Key Optimizations
- **Lazy Loading**: Heavy modules (`googleapis`, `@notionhq/client`) are `require()`-ed inside function scope, reducing cold start times.
- **Custom Timeout**: 300s (5 min) because AI processing + multi-service syncing can be slow.
- **Manual CORS**: Custom origin allowlist with explicit `OPTIONS` handling.

### Endpoints
| Endpoint | Purpose | Auth |
|----------|---------|------|
| `POST /syncPlanner` | Process planner image, sync to Google + Notion | OAuth token |
| `POST /setupNotion` | Encrypt and store Notion integration keys | OAuth token |

---

## 3. AI Integration (Google Gemini)

### Decision
Google Gemini models for handwriting recognition and structured data extraction.

### Model Strategy
- **Primary**: `gemini-2.5-flash-lite-preview-06-17` (fastest, cheapest)
- **Fallback 1**: `gemini-2.5-flash-preview-04-17` (more capable)
- **Fallback 2**: `gemini-2.0-flash-lite` (stable, proven)

### Resilience
- **Retry Logic**: Exponential backoff (1s, 2s, 4s...) on HTTP 429 rate limits.
- **Model Cascade**: If primary fails, automatically tries next model.
- **JSON Enforcement**: `responseMimeType: "application/json"` ensures parseable output.

---

## 4. Performance & Parallelism

### Decision
Process independent tasks concurrently using `Promise.allSettled`.

### Implementation
| Sync Type | Parallel Tasks |
|-----------|---------------|
| Morning | Calendar Events + Google Tasks |
| Evening | Sheets (Expenses/Health) + Notion (Brain Dump) + Task Completion |
| Journal | Notion Image Upload + AI Date Extraction |

Using `allSettled` instead of `all` allows partial success (e.g., if Notion fails, Calendar events still get created).

---

## 5. Daily Workflows

### Morning Sync
- Parse schedule and To-Dos from handwritten planner image.
- Create Calendar Events (with reminders).
- Create Google Tasks (due today).
- Does **NOT** mark tasks complete (users plan in the morning, not review).

### Evening Sync
- Mark tasks as completed in Google Tasks based on checkmarks.
- Parse expenses, health metrics, and brain dump text.
- Log financials to Google Sheets ("Expenses" tab).
- Log health stats to Google Sheets ("Health" tab).
- Upload planner image + brain dump to Notion.

### Journal Sync
- Upload high-res journal image to Notion.
- AI extracts the date for the page title.

---

## 6. Security Architecture

### Notion Key Encryption (AES-256-CBC)
- User's Notion API key is encrypted server-side before storage in Firestore.
- Encryption key lives in Google Cloud Secret Manager (`NOTION_ENCRYPTION_KEY`).
- Keys are decrypted in-memory only during sync, never stored in plaintext.
- Frontend sends raw key to `/setupNotion` over HTTPS; backend encrypts immediately.

### Content Security Policy (CSP)
All inline CSS and JS extracted to external files. Strict CSP header enforced via `firebase.json`:
- `script-src 'self'` + SHA-256 hash for the only remaining inline script (SW registration).
- `object-src 'none'`, `frame-ancestors 'none'`, `upgrade-insecure-requests`.
- Full policy documented in `SECURITY_CSP_PLAN.md`.

### Firestore Rules
- Client: **read-only** access to own `/users/{email}` document.
- All writes go through Admin SDK in Cloud Functions (prevents client tampering).

### Auth Flow
- **Desktop**: `signInWithPopup` with `signInWithRedirect` fallback for popup blockers (Brave, Safari).
- **Mobile**: `signInWithRedirect` by default for native-feeling experience.
- OAuth tokens kept in-memory only (not persisted to `sessionStorage` or `localStorage`).

### API Hardening
- Origin allowlist for CORS.
- Strict content-type and payload shape validation.
- Image size limit (20MB) to prevent memory exhaustion.
- Generic error messages to client; detailed logs server-side.

---

## 7. Frontend Architecture

### File Structure (Post-CSP Migration)
```
public/
├── index.html         # Pure HTML structure (~250 lines)
├── app.js             # Application logic (ES module)
├── styles.css         # Custom CSS (themes, glass, animations)
├── tailwind.css       # Prebuilt Tailwind utilities
├── sw.js              # Service Worker (offline caching)
├── manifest.json      # PWA manifest
├── privacy.html       # Privacy policy
├── planner.html       # Planner PDF viewer
└── gear.html          # Gear recommendations
```

### Design Language
- **Glassmorphism**: Frosted-glass cards with `backdrop-filter: blur()`.
- **Dynamic Theming**: Light / Dark / OLED / Auto (system-aware).
- **Tailwind CSS**: Prebuilt at deploy time (not runtime CDN).

---

## 8. External Integrations

### Google Ecosystem
| Service | Usage | Sync Type |
|---------|-------|-----------|
| Calendar | Create events with reminders | Morning |
| Tasks | Create/complete tasks | Morning/Evening |
| Sheets | Log expenses + health data | Evening |

### Notion
- **Protocol**: Two-step Direct File Upload (Init → PUT binary → Link `file_id` to page).
- **Zero Storage Compliance**: Images flow from user browser → server RAM → Notion. Never persisted on our infrastructure.

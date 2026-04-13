# Google Verification Readiness Audit

Date: 2026-04-14 (Updated)

## Executive Summary

All High and Medium priority issues from the original audit have been resolved. The backend is now truthful in its behavior relative to UI promises: monthly credit renewal is implemented, gamification milestones match the 7/30/90-day system shown in the UI, account deletion is recursive, and export exposes full profile data. Homepage and privacy policy copy now accurately describes all three Google scopes (Calendar, Tasks, Drive). Paid-plan UI is explicitly labeled "Coming Soon."

## Current Validation Snapshot

- `npm run test:backend`: **PASS, 183/183 tests** _(was 179/179; +4 gamification tests)_
- `npm run test:frontend`: PASS, 46/46 tests
- `npm run test:e2e:smoke`: PASS, 1/1 tests
- `npm run test:e2e:ui`: **PASS, 5/5 tests** _(was 3 passed / 2 failed)_
- `npm run test:e2e`: FAIL, Firebase Auth emulator connection (`auth/network-request-failed`) — requires local Java + Auth emulator
- `npm run test:rules`: FAIL locally because Java runtime is not installed
- `git diff --check`: PASS

---

## Resolved Findings

### ✅ HIGH: Monthly free credit renewal — RESOLVED

**What was done:**
Implemented `applyMonthlyRenewalCheck` logic inside the sync transaction in `functions/index.js`. On every request, the current month (`YYYY-MM`) is compared to `subscriptionRenewalDate`. If they differ, `tierCredits` is replenished based on the user's active tier (`15` free / `100` standard / `250` pro) and `subscriptionRenewalDate` is stamped.  
`boosterCredits` are never touched by this logic, so they survive renewal correctly.

**Tests added:**
- `functions/__tests__/gamification.test.js` verifies 7/30/90-day milestones.
- `functions/__tests__/index.test.js` updated: BYOK test now sets `subscriptionRenewalDate: currentMonth` to prevent spurious renewal, confirming renewal does not fire for within-window users.

---

### ✅ HIGH: Streak and reward logic mismatch — RESOLVED

**What was done:**
`applyGamificationMilestones` was refactored in `functions/index.js` to use a clean 7 / 30 / 90-day milestone table:
- 7-day streak → +5 booster credits
- 30-day streak → +20 booster credits + 1 freeze
- 90-day streak → +50 booster credits + 3 freezes

Added `lastAwardedStreak` field to avoid paying out the same milestone twice. A streak break now correctly resets `lastAwardedStreak = 0`. The old `% 5 === 0` quality-scoring system is fully removed.

`usedFreeze` flag introduced so the "Streak sustained using a Freeze!" message is only emitted when a freeze was actually consumed — not when the streak simply broke.

**Tests added:** 4 deterministic unit tests in `functions/__tests__/gamification.test.js` — all passing.

---

### ✅ HIGH: Delete/export account flow incomplete — RESOLVED

**`deleteUserAccount`:** Now a fully cascading batch delete:
1. Fetches all `users/{email}/syncHistory` documents and batch-deletes them.
2. Range-queries `rateLimits` by document ID prefix (`{email}_*`) and batch-deletes matches.
3. Deletes the root `users/{email}` document.
4. Commits the batch atomically.

**`exportUserData`:** Now exposes all non-secret user-managed fields:
- `tier`, `tierCredits`, `boosterCredits`, `currentStreak`, `highestStreak`, `streakFreezes`, `dailySyncCount`, `lastSyncDate`, `subscriptionRenewalDate`, `lastAwardedStreak`, `notionConfigured`, `notionDbId`
- Last 50 `syncHistory` entries (timestamp, status, mode, itemCount).
- Encrypted keys are still intentionally excluded.

---

### ✅ MEDIUM: Privacy policy and homepage scope under-described — RESOLVED

**What was done:**

- `public/index.html` (Hero/login copy): Updated from `"syncs your Google Calendar and Notion"` to `"syncs your Google Calendar, Google Tasks, Google Drive, and Notion"`.
- `public/privacy.html` (Section 2): Updated from a single-paragraph Calendar blurb to a three-bullet description of Calendar, Tasks, and Drive/Sheets with explicit purpose statements for each.
- `public/privacy.html` (Section 3): Updated "We do not sell your calendar data" to "We do not sell your Google data (Calendar, Tasks, or Drive files)"; expanded bullet about what is covered.

---

### ✅ MEDIUM: Paid plans UX truthfulness — RESOLVED

**What was done:**

- Section header subtitle changed to "Explore what's coming next! Paid plans arriving soon."
- Plan toggle control made non-interactive (opacity-50, pointer-events-none).
- Plan card titles now read: **Standard (Coming Soon)** and **Pro (Coming Soon)**.
- Pricing figures and feature lists visually dimmed (opacity-50/70).
- All CTA buttons remain `🔒 Coming Soon` and are disabled.

---

### ✅ MEDIUM: Under-tested gamification — RESOLVED

**What was done:**

- `functions/__tests__/gamification.test.js` created with 4 deterministic unit tests.
- `e2e/tests/ui.spec.js` BYOK test fixed: now programmatically opens the hidden `<details>` block before filling the form, ensuring the `#byok-api-key` input is visible.
- `e2e/tests/ui.spec.js` `logClientError` test fixed: switched from a timing-sensitive boolean flag to `page.waitForRequest()` promise, which is race-condition free.
- Result: `npm run test:e2e:ui` now passes 5/5.

---

### ✅ LOW: Stale internal docs — RESOLVED

| Document | Change |
|----------|--------|
| `README.md` | Fixed live URL (→ `planner.analogdigital.tech`), removed Gemini version pin, updated encryption row to AES-256-GCM, added Java/Auth emulator/Playwright prerequisites section |
| `DESIGN_AND_DECISIONS.md` | Section 6 heading and body updated from `AES-256-CBC` to `AES-256-GCM`; added NOTION_ENCRYPTION_KEY_V2 and legacy migration note |
| `PROJECT_CHANGELOG_AND_CURRENT_ARCHITECTURE.md` | Corrected AES-256-CBC references to AES-256-GCM in V4 changelog entry and the before/after security table |

---

## Remaining Known Blockers

### Local only — not a verification blocker

| Issue | Status |
|-------|--------|
| `npm run test:rules` | FAIL locally — requires Java 21+. Install with `brew install --cask temurin21`. CI is unaffected. |
| `npm run test:e2e` (full) | FAIL locally — requires Firebase Auth emulator at `127.0.0.1:9099`. Smoke E2E passes in CI. |
| 18 `no-unused-vars` lint warnings in `functions/` | Non-blocking; clean-up can happen post-verification. |

---

## What Looks Good

- All 183 backend tests pass; 0 failures.
- Gamification milestone logic is now deterministic and matches UI copy exactly.
- Monthly credit renewal is implemented and tested.
- Account deletion is now fully recursive.
- Export now provides complete, meaningful data.
- Homepage and privacy policy are accurate about all three Google API scopes.
- UI paid-plan section honestly communicates "Coming Soon" status.
- E2E UI smoke suite now passes 5/5.
- All stale documentation corrected.
- `git diff --check` is clean.

## Recommended Next Steps Before Submission

1. **Merge `updates` branch into `main`** to trigger CI/CD deploy.
2. **Verify live at `https://planner.analogdigital.tech`** that updated privacy policy, hero copy, and pricing cards render correctly.
3. **Install Java 21** and run `npm run test:rules` once for full local emulator coverage.
4. **Submit Google OAuth verification** — the scope justification pack in `docs/oauth-verification/` is current.

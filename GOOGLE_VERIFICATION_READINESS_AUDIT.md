# Google Verification Readiness Audit

Date: 2026-04-13

## Executive Summary

The core app is in much better shape than a few passes ago: backend tests are green, frontend unit tests are green, and the Playwright smoke path passes. The main remaining risks before Google verification are not the basic sync pipeline. They are product-truthfulness and policy consistency issues:

1. the free-plan monthly 15-credit renewal is not implemented,
2. the backend streak/reward logic does not match the UI promise,
3. the delete/export data path is incomplete relative to current user-facing and verification-facing claims,
4. privacy/homepage/docs still under-describe the actual Google data usage.

If you submit as-is, the most likely reviewer friction is around scope explanation, user data handling accuracy, and unfinished monetization/gamification behavior surfacing in the product.

## Current Validation Snapshot

- `npm run test:backend`: PASS, 179/179 tests
- `npm run test:frontend`: PASS, 46/46 tests
- `npm run test:e2e:smoke`: PASS, 1/1 tests
- `npm run test:e2e:ui`: FAIL, 3 passed / 2 failed
- `npm run test:e2e`: FAIL, Firebase Auth emulator connection (`auth/network-request-failed`)
- `npm run test:rules`: FAIL locally because Java runtime is not installed
- `git diff --check`: PASS

## Findings

### High: Monthly free credit renewal is not implemented

Evidence:
- `functions/index.js:87-113` initializes `tierCredits: 15` and `subscriptionRenewalDate: null`.
- `functions/index.js:564-607` re-applies the same defaults transactionally during sync.
- `subscriptionRenewalDate` appears nowhere else in the repository.

Why this matters:
- The code currently grants the initial 15 free credits only when the user profile is first created or backfilled.
- There is no monthly reset or renewal job, no on-read renewal check, and no billing-cycle reconciliation.
- So the answer to "is renew of 15 credit monthly done correctly?" is no; it is not implemented at all.

Recommended fix:
- Decide the source of truth for renewal:
  - simple free-tier monthly renewal on access, or
  - subscription-backed renewal by plan cycle.
- Add one shared function that:
  - compares `subscriptionRenewalDate` with the current billing period,
  - restores the plan allocation (`15`, `100`, `250`, etc.),
  - advances the renewal date exactly once per period,
  - never overwrites booster credits.
- Call it before `checkFeaturesAndCredits(...)` inside the sync transaction.

Tests missing:
- first renewal after 30/31 days,
- same-month repeat request does not double-credit,
- booster credits survive renewal,
- BYOK users do not accidentally consume or renew paid credits incorrectly,
- standard/pro renewal amounts.

### High: Streak and reward logic does not match the UI contract

Evidence:
- Backend logic in `functions/index.js:139-243` rewards every 5th streak day, then varies rewards based on minimum daily sync count across the last 5 days.
- UI copy in `public/index.html:434-443` promises:
  - 7-day streak -> `+5 bonus credits`
  - 30-day streak -> `+20 bonus credits + 1 freeze`
  - 90-day streak -> `+50 bonus credits + 3 freezes`

Why this matters:
- Users and reviewers see one reward model, but the server enforces another.
- This is not a cosmetic mismatch; it changes when rewards fire and what users receive.
- Because the backend is authoritative, the UI is currently misleading.

Recommended fix:
- Pick one rule set and use it everywhere.
- Best path before verification: simplify to a small explicit milestone table shared by backend and UI copy.
- If you want the 7/30/90 system, replace the current `% 5 === 0` reward branch entirely.
- If you want the "activity quality" model, rewrite the UI explanation so it honestly describes the 5-day cadence and daily minimum thresholds.

Tests missing:
- no direct tests cover `applyGamificationMilestones(...)`,
- no milestone reward tests,
- no freeze consumption tests,
- no same-day vs next-day vs missed-day tests,
- no regression test that UI reward copy matches backend milestone config.

### High: Delete/export account flow is incomplete relative to current claims

Evidence:
- `functions/index.js:406-444` deletes only `users/{email}` with `await userRef.delete()`.
- Sync history is stored separately in `functions/index.js:902-910` under `users/{email}/syncHistory`.
- Rate-limit records are stored under `rateLimits/{email}_{endpoint}` in `functions/services/rateLimit.js:4-28`.
- `functions/index.js:381-395` exports only a tiny subset of account data (`notionConfigured`, `notionDbId`).
- The app and verification docs currently imply users can delete account-linked data:
  - `public/privacy.html:57-58`
  - `docs/oauth-verification/scope-justification.md:54-58`
  - `docs/oauth-verification/demo-video-script.md:58-64`

Why this matters:
- Deleting the root doc does not guarantee deletion of `syncHistory`.
- Rate-limit docs also remain.
- Export is too minimal to back up the current "export your data" posture with confidence.

Recommended fix:
- Make delete recursive:
  - delete `users/{email}`,
  - delete `users/{email}/syncHistory`,
  - delete matching `rateLimits/{email}_*`.
- Expand export to include all user-managed or user-visible fields that are safe to disclose:
  - tier/credits/streak fields,
  - Notion setup state,
  - recent sync history,
  - usage counters,
  - BYOK metadata without secrets.
- Update UI confirmation text so it matches what actually gets deleted.

Tests missing:
- recursive delete behavior,
- export includes all intended non-secret account data,
- delete removes history and rate-limit artifacts,
- deletion remains idempotent.

### Medium: Privacy policy and homepage copy do not fully match actual Google scope usage

Evidence:
- App requests:
  - `calendar.events`
  - `tasks`
  - `drive.file`
  in `public/app.js:106-123`
- Homepage login copy says only: `syncs your Google Calendar and Notion` in `public/index.html:86-89`
- Privacy policy section title and text say `Google Calendar and Notion Data` and describe reading events / writing tasks, but omit Google Tasks and Drive/Sheets in `public/privacy.html:42-46`
- Actual product behavior includes Google Tasks and Drive/Sheets via `functions/services/googleSync.js:51-169`

Why this matters:
- Reviewers compare requested scopes against public-facing explanations.
- The privacy policy is currently under-specific and partly inaccurate:
  - it omits Drive/Sheets,
  - it omits Google Tasks as a named product area,
  - it claims reading existing events, while the implementation shown here creates Calendar events and lists Google Tasks.

Recommended fix:
- Update homepage copy to name the real Google surfaces: Calendar, Tasks, and Drive/Sheets.
- Update privacy policy to describe each Google data use plainly and minimally.
- Keep Notion separate from Google scope explanation so the reviewer sees a clean mapping.

### Medium: Paid plans and credit UX are still unfinished, but they are visible in production-facing UI

Evidence:
- Pricing cards promise monthly plans and credits in `public/index.html:580-679`.
- Paywall promises `100 credits/mo` in `public/index.html:698-704`.
- Buttons are disabled as `Coming Soon`.
- `public/app.js:1113-1121` still uses a Cashfree simulation alert.
- There is no subscription provisioning logic in backend code.

Why this matters:
- This is separate from Google OAuth scope verification, but it affects trust.
- Reviewers and users can see monetization surfaces that imply plan mechanics which the backend does not actually enforce end-to-end.
- Combined with the missing renewal logic, the pricing model reads ahead of implementation.

Recommended fix:
- Before verification, either:
  - hide subscription UI entirely, or
  - relabel it as beta/coming soon with no active plan promises.
- Do not promise monthly credit mechanics until the backend renewal path exists.

### Medium: Gamification and verification-critical behaviors are still under-tested

Evidence:
- Search over tests shows credit-deduction tests, but no direct tests for:
  - `applyGamificationMilestones`
  - `initializeGamificationProfile`
  - `subscriptionRenewalDate`
  - streak freeze consumption
  - reward milestones
- `npm run test:e2e:ui` still fails on:
  - `e2e/tests/ui.spec.js:71-88` because the BYOK input exists inside collapsed advanced-settings UI and is not visible,
  - `e2e/tests/ui.spec.js:90-103` because `logClientError` is not observed as expected.
- `npm run test:e2e` still fails because the Auth emulator is unreachable.

Why this matters:
- The tests that now pass are strong on parsing, backend routing, and basic app load.
- The least-covered area is exactly the area you asked about: streaks, rewards, and credits.

Recommended fix:
- Add a dedicated gamification test file with deterministic date mocking.
- Add one backend test suite for monthly renewal.
- Adjust the UI smoke BYOK test to open the relevant `<details>` block before filling the field, or make the setup view auto-expand the advanced section when navigated directly.
- Make the full E2E test spin up or require the Auth emulator explicitly in the developer instructions.

### Low: Internal docs are stale in a few places

Evidence:
- `README.md:3,6,16-17` still references Gemini 2.0 Flash, the old `web.app` live URL, and stale test-count badges.
- `PROJECT_CHANGELOG_AND_CURRENT_ARCHITECTURE.md:21,35,38,148` still refers to AES-CBC, 30MB limits, and stale test totals/coverage claims.
- `DESIGN_AND_DECISIONS.md:99-103` still titles the encryption section as AES-256-CBC while newer docs/code describe AES-256-GCM plus legacy fallback.

Why this matters:
- Not a direct verification blocker, but stale engineering docs reduce reviewer confidence and make support harder.

Recommended fix:
- Normalize all docs to the current domain, current model cascade, current encryption wording, and current test numbers.

### Low: Local test prerequisites should be documented more explicitly

Evidence:
- `npm run test:rules` requires Java locally.
- `npm run test:e2e` requires the Firebase Auth emulator on `127.0.0.1:9099`.
- These prerequisites are not clearly called out in the main README test instructions.

Recommended fix:
- Add a short "local verification prerequisites" section to the README:
  - Java for Firestore emulator,
  - Firebase emulator/auth setup for full E2E,
  - Playwright browser install.

## What Looks Good

- Backend Jest suite is green and materially improved.
- Frontend unit tests are green.
- Smoke E2E passes and confirms the production-facing app loads without crashing.
- OAuth verification doc pack has a good structure and the requested scope list is internally consistent.
- `git diff --check` is clean.

## Recommended Pre-Verification Order

1. Fix monthly credit renewal logic.
2. Align streak/reward rules between backend and UI.
3. Fix delete/export completeness.
4. Rewrite privacy policy and homepage scope explanation to match actual Google data usage.
5. Hide or soften unfinished paid-plan UI until billing and renewals are real.
6. Add backend tests for credits/streaks/rewards.
7. Clean stale README/architecture wording.
8. Close the remaining two Playwright UI failures.

## Bottom Line

The app looks close on core functionality, but not yet clean enough on truthfulness and edge-policy handling to feel comfortable for Google verification. The main blockers are not glamorous bugs. They are the places where user-visible promises, verification docs, and backend behavior still disagree.

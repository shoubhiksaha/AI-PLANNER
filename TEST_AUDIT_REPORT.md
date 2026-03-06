# Test Audit Report (Living Document)

Last updated: March 6, 2026

## Current Status (Most Recent Recheck)
- Repository: `/Users/domgeshworld/Desktop/AI PLANNER`
- Commands re-run: `npm test`, `npm run test:rules`
- `npm test`: **PASS**
  - Backend: **136 passed**
  - Frontend: **41 passed**
  - Total (backend + frontend): **177 tests passed**
- Backend coverage (latest):
  - Statements: **89.35%**
  - Branches: **79.48%**
  - Functions: **93.87%**
  - Lines: **91.54%**
- `npm run test:rules`: **FAIL locally (environment blocker)**
  - Missing Java runtime (`java -version` fails)
  - Network/DNS issue to `firebase-public.firebaseio.com` (MOTD fetch warning)
  - Local firebase-tools configstore permission warning under `~/.config`

## Open Gaps (Current)
1. Local Firestore rules tests are not reliably runnable on this machine due Java + local Firebase CLI environment constraints.
2. Inner Gemini retry/log handling still directly reads `error.message` in `functions/index.js` (`callGeminiWithFallback` catch path), which is less robust for atypical thrown values.
3. Coverage artifacts under `functions/coverage/` keep changing in git status; policy is still unclear (commit vs ignore).

## Change History (Newest First)

### 2026-03-06 (Most Recent Recheck, Current Workspace)
- Backend moved to **136 passing tests** (from 135).
- Added backend test: `handles non-Error throw (string) without secondary crash`.
- `syncPlanner` outer catch hardened with:
  - `const errMsg = error?.message || String(error || "Unknown error")`
- README test-count lines aligned with current suite totals (`177` total / `136` backend / `41` frontend).
- Rules test still blocked locally by environment prerequisites.

### 2026-03-06 (Previous Recheck)
- Backend at **135 passing tests**.
- Frontend at **41 passing tests**.
- App/helper drift issue addressed by importing real production helper modules in tests (`app-helpers.js`, `sw-constants.js`).
- Rules test remained environment-blocked locally.

### 2026-03-06 (Audit Snapshot, Commit `a40d2ff`)
- Backend at **130 passing tests**.
- Frontend at **41 passing tests**.
- Backend coverage snapshot: **87.61 / 78.24 / 91.83 / 89.56**.
- Local rules execution blocker (Java/emulator prerequisites) documented.
- Service worker drift concern still listed at this stage.

### 2026-03-06 (Audit Snapshot, Commit `151acf6`)
- Backend at **130 passing tests**.
- Frontend at **41 passing tests**.
- Root `test:rules` script availability documented as resolved.
- App helper drift marked resolved; service worker drift still listed at that stage.

### 2026-03-05 (Audit Snapshot, Commit `4a228c6`)
- Backend: **130 passed**.
- Frontend suites passed when run via local Jest binary (`./functions/node_modules/.bin/jest --config public/jest.config.js`).
- `npm run test:frontend` was flagged as environment-fragile in that snapshot due `npx` + offline resolution behavior.
- Key persistent findings at that stage: mirrored frontend logic drift risk, rules prerequisites, coverage artifact churn.

### 2026-03-04 (Audit Snapshot, Commit `433704c`)
- Backend tests: **95 passed** (utilities only).
- `functions/index.js` effectively untested in coverage snapshot (**0%** in that report).
- Frontend tests and CI workflow were flagged missing at this early stage.
- This was the baseline before major integration/coverage improvements.

## Cumulative Resolved Items
1. Root test command reliability (`npm test`) is stable.
2. Frontend helper/constant drift risks were addressed via shared production modules.
3. Backend robustness improved with explicit non-Error throw coverage.
4. README test-count documentation is now synchronized with actual totals.

## Recommended Next Actions
1. Install Java 21+ and fix local Firebase CLI configstore permissions to unblock local rules testing.
2. Harden `callGeminiWithFallback` inner catch by normalizing error message before `.includes(...)` and logging.
3. Decide coverage artifact policy (`functions/coverage/` committed or gitignored) and enforce it.

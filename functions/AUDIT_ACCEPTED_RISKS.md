# NPM Audit — Accepted Risks

Last audited: 2026-10-17 (functions), 2026-05-02 (root, mobile)

## Root (`AI_PLANNER/`) — ✅ 0 vulnerabilities

---

## functions/ — production dependencies: ✅ 0 vulnerabilities

Last audited: 2026-10-17 (`npm audit --omit=dev` → 0).

Remediation (audit finding S-10 / I-07):
- `firebase-admin` bumped to `^14.5.0` (fixes the ≤13.10 advisories incl. node-forge) and moved
  to `dependencies` (it is required at runtime).
- `npm audit fix` (no `--force`) applied — resolved websocket-driver (critical), protobufjs,
  @grpc/grpc-js in the runtime tree, uuid and others.
- Removed unused `@google/generative-ai` and `firebase-functions-test`; pinned
  `notion-multipart-uploader` to `2.1.4`. The `cookie` package is no longer used (stateless BYOK).
- firebase-admin 14 loads `jose` (ESM-only) through `require(esm)`; this needs Node ≥ 22.12,
  which the Cloud Functions Node 22 runtime provides. Verify on staging before production.

### Dev-only advisories (ACCEPTED — never deployed)

`npm audit` still lists ~24 advisories (moderate/high) that exist only in the dev toolchain:
- `jest` → `babel-plugin-istanbul` → `@istanbuljs/load-nyc-config` → `js-yaml` / `argparse` / `sprintf-js`
- `@firebase/rules-unit-testing` → `firebase` (client SDK) → `@firebase/firestore` → `@grpc/grpc-js`

**Why safe:** these packages run only on developer machines/CI against local test fixtures and the
Firestore emulator; they are excluded from the deployed function (`npm audit --omit=dev` is clean).
`npm audit fix --force` would downgrade jest / rules-unit-testing to breaking majors — NOT VIABLE.
Re-check when jest 30.x / rules-unit-testing publish patched ranges.

---

## mobile/ — 18 moderate vulnerabilities

### Status: ACCEPTED — Upstream Expo SDK chain

All 18 are transitive dependencies of `expo@52+` via the
`@expo/config-plugins` → `xcode` → `uuid` and `@expo/metro-config` → `postcss` chains.

**`npm audit fix --force` would downgrade `expo` to v49.0.23 (breaking). NOT VIABLE.**

#### postcss < 8.5.10 (Moderate) — GHSA-qx2v-qp2m-jg93
- **Path:** expo → @expo/cli → @expo/metro-config → postcss
- **Why safe:** This is a build-time CSS stringification XSS. Our app doesn't process untrusted CSS
  at build time. The vulnerability requires injecting `</style>` into CSS source — not applicable to
  our Metro bundler usage which only processes our own trusted stylesheets.

#### uuid < 14.0.0 (Moderate × 17) — GHSA-w5hq-g745-h8pq
- **Path:** expo → @expo/config-plugins → xcode → uuid
- **Why safe:** Same as functions — requires custom `buf` parameter to uuid.v3/v5/v6.
  Expo SDK calls uuid without custom buffers. Unexploitable.

---

## Resolution Plan

Monitor upstream releases:
```bash
# Functions — production tree must stay at 0
cd functions && npm audit --omit=dev

# Mobile — check when Expo bumps uuid/postcss
cd ../mobile && npx expo install --check && npm audit
```

# NPM Audit — Accepted Risks

Last audited: 2026-05-02

## Root (`AI_PLANNER/`) — ✅ 0 vulnerabilities

---

## functions/ — 11 vulnerabilities (2 low, 9 moderate)

### Status: ACCEPTED — Upstream Firebase/Google Cloud SDK chain

All 11 are transitive dependencies of `firebase-admin@13.7.0` via the
`@google-cloud/*` → `google-gax` → `teeny-request` → `uuid` chain.

**`npm audit fix --force` would downgrade `firebase-admin` to v10.1.0 (breaking). NOT VIABLE.**

#### @tootallnate/once (Low × 2) — GHSA-vpq2-c234-7xj6
- **Path:** firebase-admin → @google-cloud/storage → teeny-request → http-proxy-agent → @tootallnate/once
- **Why safe:** Cloud Functions don't use HTTP proxies. The vulnerable code path is never executed.

#### uuid < 14.0.0 (Moderate × 9) — GHSA-w5hq-g745-h8pq
- **Path:** firebase-admin → @google-cloud/* → google-gax/gaxios/teeny-request → uuid
- **Why safe:** Vulnerability requires passing a custom `buf` parameter to uuid.v3/v5/v6.
  Firebase SDK only calls `uuid.v4()` without custom buffers. Unexploitable in our codebase.

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
# Functions — check when Google bumps uuid in their SDK
cd functions && npm update firebase-admin && npm audit

# Mobile — check when Expo bumps uuid/postcss
cd ../mobile && npx expo install --check && npm audit
```

# AI Planner security remediation notes

This document describes the security fixes implemented in code and the manual operational work that must happen before a production rollout.

Status for this working session:

- Code changes were implemented locally.
- Unit/integration tests were run locally.
- No deployment was run.
- No production migration was run.

## What changed

- Gemini API key moved from plain string config to Firebase Secret Manager.
- Cashfree integration now uses explicit environment config, real secret parameters, signed webhook verification, gateway order verification, idempotent fulfillment, amount/currency checks, and minimal stored payment details.
- BYOK setup and stateless BYOK headers now validate provider/model/API key format and block custom URLs unless explicitly enabled.
- Custom BYOK outbound calls now block redirects, pin to validated public DNS addresses, time out, and cap response size.
- Image uploads now accept only JPEG/PNG/WebP after checking decoded bytes and magic signatures; request/image limits are kept below Cloud Functions request limits.
- Notion setup validates the token/database before storing credentials.
- GDPR export/delete now use revoked-token verification, include payment summaries, export full sync history, and delete Firestore data before deleting the Firebase Auth user.
- Client error logging no longer trusts a caller-supplied email and strips/sanitizes noisy fields.
- App Check enforcement was added behind a feature flag so it can be enabled only after the client is wired and verified.
- Rate-limit documents now include `expiresAt` for Firestore TTL.

## Secrets and params to configure before deploy

Set secrets per Firebase project:

```bash
firebase functions:secrets:set GEMINI_API_KEY
firebase functions:secrets:set CASHFREE_APP_ID
firebase functions:secrets:set CASHFREE_SECRET_KEY
firebase functions:secrets:set NOTION_ENCRYPTION_KEY_V2
```

Keep or rotate these existing secrets as appropriate:

```bash
firebase functions:secrets:set NOTION_ENCRYPTION_KEY
```

Set non-secret params using the environment file/process you use for Firebase Functions Gen 2 parameterized config:

```bash
CASHFREE_ENVIRONMENT=sandbox
CASHFREE_NOTIFY_URL=https://<your-domain>/cashfreeWebhook
PAYMENTS_ENABLED=false
ALLOW_CUSTOM_BYOK_URLS=false
REQUIRE_APP_CHECK=false
```

Recommended rollout order:

1. Deploy with `PAYMENTS_ENABLED=false`.
2. Configure Cashfree sandbox credentials and webhook URL.
3. Verify sandbox payment flow.
4. Run the migration dry-run and review output.
5. Enable `PAYMENTS_ENABLED=true` only after sandbox verification.
6. Switch `CASHFREE_ENVIRONMENT=production` only with production Cashfree credentials.
7. Enable `REQUIRE_APP_CHECK=true` only after the web/native clients send valid App Check tokens to every protected endpoint.

## Migration helper

The migration helper lives at:

```bash
functions/scripts/security_migration.js
```

Dry-run only:

```bash
cd functions
npm run migrate:security:dry-run
```

Apply mode is intentionally guarded:

```bash
cd functions
npm run migrate:security:apply
```

The apply script requires `--apply --confirm=SECURITY-MIGRATION-2026-06-21` in the npm script and will:

- encrypt plaintext/legacy Notion keys when a Notion encryption secret is present in the script environment;
- flag corrupted Notion keys for user reset;
- flag legacy plaintext BYOK credentials for reset;
- flag custom BYOK URLs for review;
- minimize old verbose Cashfree `paymentDetails` into summary fields;
- backfill payment `price`, `amountPaise`, and `currency` where safely inferable;
- backfill rate-limit `expiresAt` for TTL.

Do not run apply mode until the dry-run output has been reviewed.

## Firestore TTL

After deploy, enable Firestore TTL on:

```text
rateLimits.expiresAt
```

The code now writes this field for new rate-limit entries. The migration helper can backfill old entries.

## Cashfree webhook settings

In Cashfree, configure the webhook endpoint to:

```text
https://<your-domain>/cashfreeWebhook
```

Require Cashfree to send:

- `x-webhook-signature`
- `x-webhook-timestamp`
- `x-webhook-version`

The backend accepts webhook versions `2023-08-01` and `2025-01-01`.

## Local credential hygiene

The audit found local ignored credential files. They were not edited by this remediation. Before production rollout:

- rotate any credential that may have been exposed locally;
- keep `.env`, service account JSON, OAuth client secrets, and Cashfree secrets out of git;
- restrict local file permissions, for example `chmod 600` on local secret files;
- prefer Firebase Secret Manager for deployed functions.

## Known manual follow-ups

- Wire Firebase App Check into web and native clients before setting `REQUIRE_APP_CHECK=true`.
- Consider removing `unsafe-inline` from CSP in a separate UI hardening pass; this codebase still uses inline style/event patterns that need careful UI testing.
- Re-onboard users with legacy plaintext BYOK credentials instead of attempting to silently reuse old plaintext data.

## October 2026 audit remediation — owner actions outside the repo

The code side of the October 2026 audit (finding IDs S-*, B-*, U-*, M-*, I-*, Q-*) is on branch
`fix/audit-remediation`. These steps can't be done from the repo:

1. **Revoke the Gemini API key leaked in git history** (commit `bdd433a`, `test_gemini.js`, key
   prefix `AIzaSyA663`). GCP Console → APIs & Services → Credentials → delete or regenerate it.
   The repo is public, so assume the key is compromised. Optional: purge history with
   `git filter-repo` and force-push.
2. **Run `scripts/setup-repo-governance.sh`** (staging branch, environments, branch protection,
   merge-commit-only). See [RELEASE_FLOW.md](RELEASE_FLOW.md).
3. **Switch deploys to Workload Identity** with `scripts/setup-gcp-oidc.sh` for both projects, set
   `WIF_PROVIDER`/`SA_EMAIL` as environment variables, then delete the repo-level `FIREBASE_TOKEN`
   and the unused `GEMINI_API_KEY` repo secret, and revoke the CLI token.
4. **Delete the local `functions/.env`** (holds old secrets; `firebase deploy` would upload it).
   `scripts/guard-deploy.sh` now refuses to deploy while it exists.
5. **Firebase Auth:** keep Google as the only sign-in provider, or require verified email for any
   other provider. Rules and functions now reject unverified emails.
6. **Cashfree dashboard:** enable refund and dispute webhooks to the existing notify URL.
7. **Staging lives in the production project** (database `staging`, functions `asia-south1`, site
   `ai-planner-staging`). The Hosting site and Auth authorized domains are already set up; the
   `staging` database is created by the first staging deploy (it needs an open billing account).
8. Keep `REQUIRE_APP_CHECK=false` until the web client sends App Check tokens.
9. Users whose Notion key was encrypted with the retired v1 key will be asked to reconnect Notion.

### Mobile dependency advisories (accepted, October 2026)

After upgrading to Expo SDK 58 and running `npm audit fix`, `npm audit --omit=dev` in `mobile/`
still reports 16 high / 8 moderate advisories (no critical). All are in build and dev-server
tooling bundled with Expo and React Native (`@expo/cli`, `metro*`, `braces`, `micromatch`,
`node-forge` via code-signing tooling, `uuid`). npm's suggested "fix" is a downgrade to Expo 44 /
React Native 0.72, which is not viable. None of these packages ship inside the app binary.
Re-check after each Expo SDK release.

### Round 2 (October 2026) — owner steps after the first deploy

1. **Bind stored keys to their owner.** Saved Notion and BYOK keys are now encrypted with the
   user's email as authenticated data (`v3:`), so a ciphertext copied to another account can't be
   decrypted. Old keys migrate on their next use; to migrate everyone at once:
   ```bash
   node functions/scripts/migrate_key_binding.js --project=ai-planner-project-467800 --database=staging            # dry run
   node functions/scripts/migrate_key_binding.js --project=ai-planner-project-467800 --database=staging --apply --confirm=BIND-KEYS-V3
   ```
   Then repeat with `--database="(default)"` for production. Needs `NOTION_ENCRYPTION_KEY_V2` and `KMS_KEY_NAME` set.
2. **Deploy the Firestore index** for interrupted-sync refunds (`firestore.indexes.json`, collection
   group `syncHistory`: status ↑, startedAt ↑). The normal deploy does this; the scheduled
   `reconcileStuckSyncs` job refunds syncs stuck in "processing" for more than 15 minutes.
3. **Turn on App Check (staging first).**
   - Firebase Console → App Check → register the web app with reCAPTCHA Enterprise, and add both
     hosting domains to the reCAPTCHA key.
   - Set the GitHub environment variable `APP_CHECK_SITE_KEY` on `staging`, deploy, and confirm in the
     App Check console that requests are verified.
   - Set `REQUIRE_APP_CHECK=true` in `functions/.env.staging`, ship it through staging, and
     watch for 401s. Then repeat for production.
   - The mobile app loads the same site inside its WebView, so it uses the same reCAPTCHA provider.
4. **Native builds** now use Expo SDK 58 (React Native 0.88). Run `npx expo prebuild --clean` before local
   native builds, and test Google sign-in, UPI payment links and token refresh after 60+ minutes on a real
   iPhone and Android phone. No Android emulator was available here.

# AI Planner - Production Release Checklist

Before merging into `main` and initiating a live production push, strictly follow this checklist to ensure stability, security, and observability confidence.

## 1. Test Matrices
- [ ] **Frontend Suite:** Run `npm run test:frontend` locally. Ensure all React hooks, helpers, and Jest modules execute successfully.
- [ ] **Backend Suite:** Run `cd functions && npm test` locally. Ensure the extensive matrix (including mocked Gemini integration flows) executes gracefully.
- [ ] **E2E Smoke Tests:** Ensure the `playwright-smoke.yml` action passed cleanly. **NEVER** bypass this github gate. You can test locally via `BASE_URL=http://localhost:3000 npm run test:e2e:local` if needed.
- [ ] **Payload Sanitization:** Verify that new inputs properly default inside `index.js` (e.g. `body.timeZone` via `Intl.supportedValuesOf`).

## 2. Security Checks
- [ ] **Dependencies:** Run `npm audit` across both the root directory and `functions/` to scan for major vulnerabilities. Note: Vite and frontend tooling deprecations can be generally bypassed, but backend Cloud Function packages must resolve clearly.
- [ ] **Data Scopes:** Verify that the `public/app.js` OAuth requests accurately match the declarations in `public/privacy.html`. Verify no unused scopes remain.
- [ ] **Cross-Site Protection:** Verify no new CDN scripts are injected bypassing the strict Content Security Policy defined in `firebase.json` headers.

## 3. Deployment Runbook
1. Merge the PR directly into `main`. The `firebase-hosting-merge.yml` will automatically deploy the frontend.
2. For backend modifications, explicitly run `cd functions && firebase deploy --only functions` from local CLI.
3. Once deployed, verify `https://<PROJECT_URL>/` loads correctly in an incognito window without cache staleness.
4. Execute `npm run test:all` against the live production endpoint. Check the `walkthrough.md` for historical CLI references.

## 4. Rollback Procedures
If post-deployment analytics trigger P1 5xx alarms or Playwright checks fail on the production instance:

**Frontend Reversion**
1. Access the Firebase Console > Hosting.
2. Identify the active domain targeting production.
3. Click "View History" and pinpoint the immediately preceding stable release tag. 
4. Select "Rollback" to instantly revert the static bundles.

**Backend Reversion**
1. In Cloud Console, revert the `functions/index.js` payload file locally via `git checkout origin/main~1`.
2. Push the reverted state natively to Firebase via `firebase deploy --only functions`. 
3. Verify the P1 5xx charts drop cleanly against the Request ID logs. 

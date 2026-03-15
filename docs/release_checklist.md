# AI Planner - Production Release Checklist

Use this before every merge/deploy to keep releases stable and reviewer-ready.

## 1) Pre-Merge Gate (Required)

- [ ] Run repo integrity check: `npm run check:conflicts`
- [ ] Run frontend tests: `npm run test:frontend`
- [ ] Run backend tests: `npm run test:backend`
- [ ] Run Firestore rules tests: `npm run test:rules`
- [ ] Run Playwright smoke locally (optional but recommended): `npm run test:e2e:smoke`
- [ ] Confirm PR branch is up to date with `main` and has zero unresolved conflicts

## 2) GitHub Branch Protection (Required)

Enable branch protection on `main` with:

1. Require pull request reviews before merging
2. Require status checks to pass before merging
3. Include these required checks:
   - `Frontend Tests`
   - `Backend Tests & Coverage`
   - `Firestore Rules Tests`
   - `E2E Smoke (Playwright)`
   - `Lint Enforcer / lint`
4. Restrict direct pushes to `main`

## 3) Deployment Gate

1. Merge PR into `main`
2. Wait for `CI/CD Pipeline` to pass all jobs
3. Verify deploy job completed:
   - Workflow: `.github/workflows/main.yml`
   - Job: `Deploy to Firebase`
4. Record deployed commit SHA in release notes/changelog

## 4) Post-Deploy Validation (Incognito)

1. Open production URL in a fresh incognito tab
2. Verify top-left build badge shows expected `build v...`
3. Validate critical user path:
   - Login
   - Notion Setup -> `Skip for now`
   - Dashboard appears with no stacked Notion view
4. Run one Morning/Night sync smoke with test-safe data
5. Confirm no new 5xx spikes or latency alerts in GCP Monitoring

## 5) Rollback Plan

If release is bad:

1. Rollback Hosting from Firebase Console -> Hosting -> Release History
2. Revert backend commit and redeploy functions:
   - `git revert <bad_sha>`
   - `firebase deploy --only functions --project ai-planner-project-467800`
3. Re-run smoke flow and confirm alerts return to baseline

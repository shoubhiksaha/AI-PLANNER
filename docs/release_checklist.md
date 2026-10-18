# Release checklist

The flow itself is described in [RELEASE_FLOW.md](RELEASE_FLOW.md). This is the per-release checklist.

## 1. Before opening the staging PR

- [ ] Branch was cut from `main` (`git checkout -b feature/x origin/main`)
- [ ] `npm run check:conflicts`, `npm run test:frontend`, `npm run test:backend`, `npm run test:mobile`
- [ ] UI change? `npm run build:css` and commit `public/tailwind.css`

## 2. Staging

- [ ] PR `feature/x → staging` is green and merged with a **merge commit**
- [ ] Approved the `staging` deployment in Actions
- [ ] "Post-Deploy Verification (Staging)" passed
- [ ] Manual check on https://ai-planner-staging.web.app in a private window:
      login → dashboard → Morning sync with a test page → History shows it

## 3. Production

- [ ] `npm run promote` from the same feature branch (opens `feature/x → main`)
- [ ] "Branch Policy" passed (every commit already on staging, no staging merges)
- [ ] Merged with a merge commit and approved the `production` deployment
- [ ] "Post-Deploy Verification (Production)" passed
- [ ] Quick check on https://planner.analogdigital.tech; no new 5xx or payment alerts in Cloud Monitoring

## Rollback

1. Firebase Console → Hosting → Release history → roll back (immediate).
2. `git revert -m 1 <merge-sha>` on a new branch, then ship it through staging → main as usual.
3. Functions roll forward with the revert. Never run `firebase deploy` from a laptop; `scripts/guard-deploy.sh` blocks it.

# Branch protection

Branch protection, environments and merge settings are applied by a script, so they stay in
sync with the workflows:

```bash
scripts/setup-repo-governance.sh --dry-run
scripts/setup-repo-governance.sh
```

It configures:

- **`main` and `staging`**: PR required, 1 approving review from a code owner (`.github/CODEOWNERS`),
  stale reviews dismissed, conversations resolved, no force-push or deletion.
- **Required checks** (from `.github/workflows/pr-check.yml`): `Branch Policy`, plus
  `Quality / Conflict Marker Check`, `Quality / Code Linting`, `Quality / Dependency Audit`,
  `Quality / Frontend Tests`, `Quality / Backend Tests & Coverage`, `Quality / Firestore Rules Tests`,
  `Quality / Mobile Lint & Tests`, `Quality / E2E Tests`.
- **Up-to-date branches**: required on `main` only. On `staging` it is off on purpose: catching up
  with staging would mean merging staging into the feature, which would then be refused by main.
- **Merge method**: merge commits only. The provenance check needs each feature's commits to exist on staging.
- **Environments** `staging` (branch `staging`) and `production` (branch `main`), each with the owner
  as required reviewer.

See [RELEASE_FLOW.md](RELEASE_FLOW.md) for the full flow.

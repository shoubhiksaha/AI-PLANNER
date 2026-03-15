# Branch Protection Setup (GitHub)

Configure this once to prevent broken releases.

## Target Branch

- `main`

## Required Settings

1. Settings -> Branches -> Add rule
2. Branch name pattern: `main`
3. Enable `Require a pull request before merging`
4. Enable `Require approvals` (minimum 1)
5. Enable `Dismiss stale pull request approvals when new commits are pushed`
6. Enable `Require status checks to pass before merging`
7. Select required checks:
   - `Frontend Tests`
   - `Backend Tests & Coverage`
   - `Firestore Rules Tests`
   - `E2E Smoke (Playwright)`
   - `Lint Enforcer / lint`
8. Enable `Require branches to be up to date before merging`
9. Enable `Do not allow bypassing the above settings`
10. Enable `Restrict pushes that create files larger than 100 MB` (if available)

## Optional but Recommended

1. Enable `Require conversation resolution before merging`
2. Enable `Require signed commits`
3. Enable `Lock branch`

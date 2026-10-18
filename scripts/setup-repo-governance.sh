#!/usr/bin/env bash
# ==============================================================================
# AI Planner — one-time GitHub repository governance setup (run by the repo owner).
#
# Creates the `staging` branch, the `staging` and `production` environments with the
# owner as required approver, branch protection for `main` and `staging`, and the
# merge-commit-only setting the release-flow checks rely on.
#
# Usage:   scripts/setup-repo-governance.sh [--dry-run]
# Needs:   gh CLI logged in as a repo admin (gh auth status), jq.
# Re-runnable: every call is an idempotent PUT/PATCH.
# ==============================================================================
set -euo pipefail

REPO="${REPO:-shoubhiksaha/AI-PLANNER}"
OWNER_LOGIN="${OWNER_LOGIN:-shoubhiksaha}"
DRY_RUN=false
[ "${1:-}" = "--dry-run" ] && DRY_RUN=true

# Required status checks. Names match the jobs in .github/workflows/pr-check.yml
# (reusable-workflow jobs are reported as "<caller name> / <job name>").
QUALITY_CHECKS=(
    "Quality / Conflict Marker Check"
    "Quality / Code Linting"
    "Quality / Dependency Audit"
    "Quality / Frontend Tests"
    "Quality / Backend Tests & Coverage"
    "Quality / Firestore Rules Tests"
    "Quality / Mobile Lint & Tests"
    "Quality / E2E Tests"
    "Quality / Emulator E2E (Chromium, Firefox, WebKit)"
)

run() {
    if $DRY_RUN; then
        echo "DRY-RUN: $*"
    else
        "$@"
    fi
}

api() {
    # api METHOD PATH [json-body]
    local method="$1" path="$2" body="${3:-}"
    if $DRY_RUN; then
        echo "DRY-RUN: gh api -X $method $path ${body:+<<< $body}"
        return 0
    fi
    if [ -n "$body" ]; then
        gh api -X "$method" "$path" -H "Accept: application/vnd.github+json" --input - <<<"$body" >/dev/null
    else
        gh api -X "$method" "$path" -H "Accept: application/vnd.github+json" >/dev/null
    fi
}

command -v gh >/dev/null || { echo "gh CLI is required"; exit 1; }
command -v jq >/dev/null || { echo "jq is required"; exit 1; }

OWNER_ID="$(gh api "users/$OWNER_LOGIN" -q .id)"
echo "Repo: $REPO   Approver: $OWNER_LOGIN (id $OWNER_ID)   Dry run: $DRY_RUN"

# ── 1. staging branch ────────────────────────────────────────────────────────
if gh api "repos/$REPO/branches/staging" >/dev/null 2>&1; then
    echo "[1/5] staging branch exists"
else
    MAIN_SHA="$(gh api "repos/$REPO/git/ref/heads/main" -q .object.sha)"
    echo "[1/5] Creating staging from main @ ${MAIN_SHA:0:10}"
    api POST "repos/$REPO/git/refs" "{\"ref\":\"refs/heads/staging\",\"sha\":\"$MAIN_SHA\"}"
fi

# ── 2. merge settings: merge commits only (provenance checks need real commits) ─
echo "[2/5] Repo merge settings: merge commits only, delete merged branches off"
api PATCH "repos/$REPO" '{
  "allow_merge_commit": true,
  "allow_squash_merge": false,
  "allow_rebase_merge": false,
  "delete_branch_on_merge": false
}'

# ── 3. environments with required reviewer ───────────────────────────────────
for ENV_NAME in staging production; do
    BRANCH="$([ "$ENV_NAME" = staging ] && echo staging || echo main)"
    echo "[3/5] Environment '$ENV_NAME': approver $OWNER_LOGIN, deployable only from '$BRANCH'"
    api PUT "repos/$REPO/environments/$ENV_NAME" "{
      \"wait_timer\": 0,
      \"prevent_self_review\": false,
      \"reviewers\": [{\"type\": \"User\", \"id\": $OWNER_ID}],
      \"deployment_branch_policy\": {\"protected_branches\": false, \"custom_branch_policies\": true}
    }"
    if ! $DRY_RUN; then
        EXISTING="$(gh api "repos/$REPO/environments/$ENV_NAME/deployment-branch-policies" -q '.branch_policies[].name' || true)"
        for name in $EXISTING; do
            if [ "$name" != "$BRANCH" ]; then
                ID="$(gh api "repos/$REPO/environments/$ENV_NAME/deployment-branch-policies" -q ".branch_policies[] | select(.name==\"$name\") | .id")"
                api DELETE "repos/$REPO/environments/$ENV_NAME/deployment-branch-policies/$ID"
            fi
        done
        if ! grep -qx "$BRANCH" <<<"$EXISTING"; then
            api POST "repos/$REPO/environments/$ENV_NAME/deployment-branch-policies" "{\"name\":\"$BRANCH\",\"type\":\"branch\"}"
        fi
    fi
done

# ── 4. branch protection ─────────────────────────────────────────────────────
checks_json() {
    local extra="${1:-}"
    {
        for c in "${QUALITY_CHECKS[@]}"; do printf '%s\n' "$c"; done
        [ -n "$extra" ] && printf '%s\n' "$extra"
    } | jq -R . | jq -s 'map({context: ., app_id: -1})'
}

protect() {
    local branch="$1" checks="$2" strict="$3"
    echo "[4/5] Protecting '$branch' (require up-to-date branch: $strict)"
    api PUT "repos/$REPO/branches/$branch/protection" "{
      \"required_status_checks\": {\"strict\": $strict, \"checks\": $checks},
      \"enforce_admins\": false,
      \"required_pull_request_reviews\": {
        \"required_approving_review_count\": 1,
        \"require_code_owner_reviews\": true,
        \"dismiss_stale_reviews\": true
      },
      \"restrictions\": null,
      \"required_linear_history\": false,
      \"allow_force_pushes\": false,
      \"allow_deletions\": false,
      \"required_conversation_resolution\": true
    }"
}

# staging: not "strict" — a feature must never merge staging into itself to catch up,
# or it could no longer be promoted to main.
protect staging "$(checks_json "Branch Policy")" false
# main: "strict" is safe — catching up means merging main into the feature branch.
protect main "$(checks_json "Branch Policy")" true

# ── 5. remove secrets that are no longer used ────────────────────────────────
echo "[5/5] Repository secrets currently set:"
gh secret list --repo "$REPO" || true
cat <<'EOF'

Next steps (manual):
  • Move FIREBASE_TOKEN from repository secrets into each environment only if Workload
    Identity isn't configured yet:  gh secret set FIREBASE_TOKEN --env staging / --env production
    Then delete the repo-level copy:  gh secret delete FIREBASE_TOKEN
  • Prefer keyless deploys: scripts/setup-gcp-oidc.sh staging
                            scripts/setup-gcp-oidc.sh production
    and set WIF_PROVIDER / SA_EMAIL as *environment* variables it prints.
  • Delete the unused repo secret GEMINI_API_KEY:  gh secret delete GEMINI_API_KEY
  • Solo-owner note: GitHub never lets you approve your own PR. As an admin you can still
    merge with "Merge without waiting for requirements"; the deploy itself always waits for
    your approval on the environment. PRs from anyone else need your review.
EOF
echo "✅ Governance applied."

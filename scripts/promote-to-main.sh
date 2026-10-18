#!/usr/bin/env bash
# ==============================================================================
# AI Planner — promote a staging-verified feature branch to main (run locally).
#
# Usage: scripts/promote-to-main.sh [feature-branch]   (defaults to current branch)
#
# Checks the same rules CI enforces (scripts/ci/branch-policy.sh), pushes the
# feature branch, and opens a PR feature → main. Staging itself is never merged
# into main.
# ==============================================================================
set -euo pipefail

BRANCH="${1:-$(git rev-parse --abbrev-ref HEAD)}"

case "$BRANCH" in
    main|staging|HEAD)
        echo "❌ Run this with a feature branch, not '$BRANCH'." >&2
        exit 1
        ;;
esac

if [ -n "$(git status --porcelain)" ]; then
    echo "❌ Working tree has uncommitted changes. Commit or stash them first." >&2
    exit 1
fi

git fetch --no-tags origin main staging
HEAD_SHA="$(git rev-parse "$BRANCH")"

echo "Checking '$BRANCH' against the release policy…"
bash "$(dirname "$0")/ci/branch-policy.sh" pr main "$BRANCH" "$HEAD_SHA"

git push -u origin "$BRANCH"

if command -v gh >/dev/null 2>&1; then
    EXISTING="$(gh pr list --head "$BRANCH" --base main --state open --json url -q '.[0].url')"
    if [ -n "$EXISTING" ]; then
        echo "ℹ️  A PR from $BRANCH into main already exists: $EXISTING"
    else
        gh pr create --base main --head "$BRANCH" --title "Promote $BRANCH to production" \
            --body "Promotes \`$BRANCH\` to production. Already merged and verified on staging."
    fi
else
    echo "Open a PR: $BRANCH → main on GitHub (gh CLI not installed)."
fi

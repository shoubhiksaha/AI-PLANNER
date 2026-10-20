#!/usr/bin/env bash
# ==============================================================================
# AI Planner — release branch policy
#
# Flow:  feature/* ──PR──▶ staging   (deploys the staging environment after owner approval)
#        feature/* ──PR──▶ main      (same feature branch, pushed separately from a
#                                     local machine; deploys to production after approval)
#        staging   ──X──▶ main      (never allowed)
#
# Usage:
#   branch-policy.sh pr   <base_ref> <head_ref> <head_sha>
#   branch-policy.sh push <before_sha> <after_sha>          (push to main)
#
# Rules enforced for anything entering main:
#   1. The head branch is not `staging`.
#   2. It carries no staging merge commit (i.e. nobody merged staging into the feature).
#   3. Every non-merge commit already exists on origin/staging (verified there first).
#
# Requires full history (actions/checkout with fetch-depth: 0).
# ==============================================================================
set -euo pipefail

fail() {
    echo "::error title=Branch policy::$1"
    echo ""
    echo "❌ $1"
    echo ""
    echo "Release flow: branch from main → PR into staging (merge commit) → verify on staging →"
    echo "open a separate PR from the SAME feature branch into main. See docs/RELEASE_FLOW.md."
    exit 1
}

git fetch --no-tags --quiet origin main staging 2>/dev/null || true

check_into_main() {
    local head_sha="$1"
    local base="origin/main"

    git rev-parse --verify --quiet origin/staging >/dev/null \
        || fail "origin/staging does not exist. Create it with scripts/setup-repo-governance.sh first."

    # Rule 2: no staging merge commits. Merge commits on staging's first-parent line
    # are the "PR merged into staging" commits; a feature must never contain one.
    local m
    for m in $(git rev-list --merges --first-parent "$base..origin/staging"); do
        if git merge-base --is-ancestor "$m" "$head_sha"; then
            fail "This change contains staging merge commit ${m:0:10} ($(git log -1 --format=%s "$m")). Staging must never flow into main — open the PR from the original feature branch."
        fi
    done

    # Rule 3: every real commit must already be on staging.
    local missing=()
    local c
    for c in $(git rev-list --no-merges "$base..$head_sha"); do
        if ! git merge-base --is-ancestor "$c" origin/staging; then
            missing+=("$c")
        fi
    done
    if [ "${#missing[@]}" -gt 0 ]; then
        echo "Commits not yet on staging:"
        for c in "${missing[@]}"; do
            echo "  ${c:0:10}  $(git log -1 --format=%s "$c")"
        done
        fail "${#missing[@]} commit(s) have not been merged to staging yet. Merge this branch into staging (with a merge commit, not squash/rebase), verify it there, then retry."
    fi

    echo "✅ Every commit is already verified on staging and no staging merges are included."
}

mode="${1:-}"
case "$mode" in
    pr)
        base_ref="${2:?base ref required}"
        head_ref="${3:?head ref required}"
        head_sha="${4:?head sha required}"
        case "$base_ref" in
            main)
                [ "$head_ref" = "staging" ] && fail "Pull requests from staging into main are not allowed."
                check_into_main "$head_sha"
                ;;
            staging)
                echo "✅ PR into staging from '$head_ref' is allowed. Deployment waits for owner approval."
                ;;
            *)
                echo "ℹ️  No branch policy for base '$base_ref'."
                ;;
        esac
        ;;
    push)
        before="${2:?before sha required}"
        after="${3:?after sha required}"
        if [ -z "${before//0/}" ]; then
            echo "ℹ️  New branch push; checking full history against staging is skipped."
            exit 0
        fi
        # Compare against what main was before this push.
        base_override="$before"
        git rev-parse --verify --quiet origin/staging >/dev/null \
            || fail "origin/staging does not exist."
        for m in $(git rev-list --merges --first-parent "$base_override..origin/staging"); do
            if git merge-base --is-ancestor "$m" "$after"; then
                fail "Push to main contains staging merge commit ${m:0:10}. Revert it; staging must never flow into main."
            fi
        done
        missing=0
        for c in $(git rev-list --no-merges "$before..$after"); do
            if ! git merge-base --is-ancestor "$c" origin/staging; then
                echo "  not on staging: ${c:0:10}  $(git log -1 --format=%s "$c")"
                missing=$((missing + 1))
            fi
        done
        [ "$missing" -gt 0 ] && fail "$missing commit(s) reached main without being verified on staging. Production deploy is blocked."
        echo "✅ Push to main contains only staging-verified commits."
        ;;
    *)
        echo "Usage: $0 pr <base_ref> <head_ref> <head_sha> | push <before> <after>"
        exit 2
        ;;
esac

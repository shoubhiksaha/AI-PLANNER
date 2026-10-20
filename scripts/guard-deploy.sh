#!/usr/bin/env bash
# ==============================================================================
# AI Planner — firebase predeploy guard (wired into firebase.json "predeploy").
#
# - Staging and production deploy only from GitHub Actions, after the owner
#   approves the run in the matching GitHub environment. Use the emulators locally.
# - Refuses to deploy while functions/.env exists: the Firebase CLI would upload
#   it as plaintext environment variables. Secrets belong in Secret Manager.
# Firebase sets GCLOUD_PROJECT for predeploy hooks.
# ==============================================================================
set -euo pipefail

PROJECT="${GCLOUD_PROJECT:-}"
ROOT="${PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"

if [ "${GITHUB_ACTIONS:-}" != "true" ]; then
    echo "❌ Deploys to ${PROJECT:-any project} run only from GitHub Actions after owner approval." >&2
    echo "   Open a PR into staging (or, once verified there, into main). See docs/RELEASE_FLOW.md." >&2
    echo "   For local testing use: firebase emulators:start" >&2
    exit 1
fi

if [ -f "$ROOT/functions/.env" ] || [ -f "$ROOT/functions/.env.local" ]; then
    echo "❌ functions/.env (or .env.local) exists. Firebase would deploy it as plaintext env vars." >&2
    echo "   Move secrets to Secret Manager (scripts/provision-secrets.sh) and delete the file." >&2
    exit 1
fi

echo "✅ predeploy guard passed for ${PROJECT:-unknown project}"

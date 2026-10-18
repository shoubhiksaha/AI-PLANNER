#!/usr/bin/env bash
# ==============================================================================
# AI Planner — full-stack end-to-end tests on the Firebase emulators.
#
#   npm run test:e2e:emulator                    # all browsers
#   npm run test:e2e:emulator -- --project=desktop-chromium   # extra args go to Playwright
#
# Starts Hosting + Auth + Firestore + Functions emulators for the demo-ai-planner project
# (no real Google resources), with the backend's fake Gemini/Google/Notion/KMS clients,
# runs e2e/tests/emulator/*.spec.js in Chromium, Firefox and WebKit (desktop + mobile),
# and removes every generated file afterwards. Needs Java 21+ for the Firestore emulator.
# ==============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if ! java -version >/dev/null 2>&1; then
    echo "❌ Java 21+ is required for the Firestore emulator (e.g. brew install --cask temurin@21)." >&2
    exit 1
fi

FIREBASE="${FIREBASE_BIN:-firebase}"
command -v "$FIREBASE" >/dev/null || FIREBASE="npx -y firebase-tools@15.30.1"

[ -d functions/node_modules ] || (cd functions && npm ci)
[ -d e2e/node_modules ] || (cd e2e && npm ci)

cleanup() { node scripts/e2e/prepare-emulator-env.js --clean >/dev/null 2>&1 || true; }
trap cleanup EXIT

node scripts/e2e/prepare-emulator-env.js

PW_ARGS=$(printf ' %q' "$@")
$FIREBASE emulators:exec \
    --config firebase.e2e.json \
    --project demo-ai-planner \
    --only auth,firestore,functions,hosting \
    "cd e2e && npx playwright test --config playwright.emulator.config.js${PW_ARGS}"

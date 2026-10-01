#!/usr/bin/env bash
set -euo pipefail

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Error: this script must run inside a git repository."
  exit 2
fi

echo "Checking repository for unresolved merge conflict markers..."

CONFLICT_MARKERS="$(
  git grep -nE '^(<<<<<<< .+|=======$|>>>>>>> .+)$' -- \
    . \
    ':(exclude)**/package-lock.json' \
    ':(exclude)**/node_modules/**' \
    ':(exclude)e2e/playwright-report/**' \
    ':(exclude)e2e/test-results/**' \
    || true
)"

if [[ -n "${CONFLICT_MARKERS}" ]]; then
  echo "Found unresolved conflict markers:"
  echo "${CONFLICT_MARKERS}"
  echo
  echo "Resolve these files before merging/deploying."
  exit 1
fi

echo "No unresolved conflict markers found."

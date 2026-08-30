#!/usr/bin/env bash
# ==============================================================================
# AI Planner — Secret Manager Provisioning Helper Script
# Sets up required secrets in Google Cloud Secret Manager for Staging or Prod
# ==============================================================================

set -euo pipefail

usage() {
    echo "Usage: $0 [staging|production]"
    echo "Examples:"
    echo "  $0 staging"
    echo "  $0 production"
    exit 1
}

if [ "$#" -lt 1 ]; then
    usage
fi

TARGET_ENV="$1"

if [ "$TARGET_ENV" = "staging" ]; then
    PROJECT_ID="ai-planner-staging"
elif [ "$TARGET_ENV" = "production" ]; then
    PROJECT_ID="ai-planner-project-467800"
else
    echo "Invalid environment: $TARGET_ENV"
    usage
fi

echo "=============================================================================="
echo "Provisioning Google Cloud Secret Manager secrets for: $PROJECT_ID"
echo "=============================================================================="

SECRETS=(
    "GEMINI_API_KEY"
    "CASHFREE_APP_ID"
    "CASHFREE_SECRET_KEY"
    "NOTION_ENCRYPTION_KEY"
    "NOTION_ENCRYPTION_KEY_V2"
    "CREDITS_GRANT_TOKEN"
)

echo "The following secrets will be configured in project: $PROJECT_ID"
for s in "${SECRETS[@]}"; do
    echo "  • $s"
done
echo ""

for SECRET in "${SECRETS[@]}"; do
    echo "--- Setting secret: $SECRET ---"
    firebase functions:secrets:set "$SECRET" --project="$PROJECT_ID"
done

echo ""
echo "=============================================================================="
echo "✅ All secrets configured for $PROJECT_ID!"
echo "=============================================================================="

#!/usr/bin/env bash
# ==============================================================================
# AI Planner — GCP Workload Identity Federation (OIDC) Setup Script
# Sets up keyless GitHub Actions deployments to Firebase projects
# ==============================================================================

set -euo pipefail

GITHUB_REPO="shoubhiksaha/AI-PLANNER"
SA_NAME="github-deploy"
POOL_NAME="github-pool"
PROVIDER_NAME="github-provider"

usage() {
    echo "Usage: $0 [staging|production] <GCP_PROJECT_ID>"
    echo "Examples:"
    echo "  $0 staging ai-planner-staging"
    echo "  $0 production ai-planner-project-467800"
    exit 1
}

if [ "$#" -lt 2 ]; then
    usage
fi

ENV_TYPE="$1"
PROJECT_ID="$2"

echo "=== Configuring OIDC Workload Identity for [$ENV_TYPE] (Project: $PROJECT_ID) ==="

# 1. Enable required GCP APIs
echo "[1/5] Enabling IAM and Resource Manager APIs..."
gcloud services enable \
    iamcredentials.googleapis.com \
    cloudresourcemanager.googleapis.com \
    sts.googleapis.com \
    secretmanager.googleapis.com \
    cloudkms.googleapis.com \
    --project="$PROJECT_ID"

# 2. Create Service Account for GitHub Actions
echo "[2/5] Creating service account: $SA_NAME@$PROJECT_ID.iam.gserviceaccount.com..."
if ! gcloud iam service-accounts describe "$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com" --project="$PROJECT_ID" >/dev/null 2>&1; then
    gcloud iam service-accounts create "$SA_NAME" \
        --project="$PROJECT_ID" \
        --display-name="GitHub Actions Deploy ($ENV_TYPE)"
else
    echo "  Service account already exists."
fi

# 3. Grant necessary roles for Firebase & Cloud Functions deployment
echo "[3/5] Assigning deployment roles..."
ROLES=(
    "roles/firebase.admin"
    "roles/cloudfunctions.admin"
    "roles/run.admin"
    "roles/iam.serviceAccountUser"
    "roles/secretmanager.secretAccessor"
)

for ROLE in "${ROLES[@]}"; do
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member="serviceAccount:$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com" \
        --role="$ROLE" \
        --condition=None \
        --quiet >/dev/null
done

# 4. Create Workload Identity Pool
echo "[4/5] Setting up Workload Identity Pool..."
if ! gcloud iam workload-identity-pools describe "$POOL_NAME" --project="$PROJECT_ID" --location="global" >/dev/null 2>&1; then
    gcloud iam workload-identity-pools create "$POOL_NAME" \
        --project="$PROJECT_ID" \
        --location="global" \
        --display-name="GitHub Actions Pool ($ENV_TYPE)"
else
    echo "  Workload identity pool already exists."
fi

# 5. Create OIDC Provider
echo "[5/5] Creating OIDC Provider for repository: $GITHUB_REPO..."
if ! gcloud iam workload-identity-pools providers describe "$PROVIDER_NAME" \
    --project="$PROJECT_ID" \
    --location="global" \
    --workload-identity-pool="$POOL_NAME" >/dev/null 2>&1; then
    gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_NAME" \
        --project="$PROJECT_ID" \
        --location="global" \
        --workload-identity-pool="$POOL_NAME" \
        --display-name="GitHub Provider ($ENV_TYPE)" \
        --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
        --issuer-uri="https://token.actions.githubusercontent.com"
else
    echo "  OIDC provider already exists."
fi

# 6. Bind Service Account to GitHub Repo via Workload Identity
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)")
WIF_PROVIDER_RESOURCE="projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL_NAME/providers/$PROVIDER_NAME"

gcloud iam service-accounts add-iam-policy-binding "$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com" \
    --project="$PROJECT_ID" \
    --role="roles/iam.workloadIdentityUser" \
    --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL_NAME/attribute.repository/$GITHUB_REPO" \
    --quiet >/dev/null

echo "=============================================================================="
echo "✅ OIDC Setup Complete for $PROJECT_ID!"
echo ""
echo "Add these variables to your GitHub Repository ($ENV_TYPE environment):"
echo "  WIF_PROVIDER: $WIF_PROVIDER_RESOURCE"
echo "  SA_EMAIL:     $SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"
echo "=============================================================================="

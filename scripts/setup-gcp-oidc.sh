#!/usr/bin/env bash
# ==============================================================================
# AI Planner — GCP Workload Identity Federation (OIDC) Setup Script
# Sets up keyless GitHub Actions deployments to Firebase projects
# ==============================================================================

set -euo pipefail

GITHUB_REPO="shoubhiksaha/AI-PLANNER"
# One deploy account per GitHub environment (both in the same project).
POOL_NAME="github-pool"
PROVIDER_NAME="github-provider"

usage() {
    echo "Usage: $0 [staging|production] [GCP_PROJECT_ID]"
    echo "Both environments live in ai-planner-project-467800 (staging uses Firestore database 'staging')."
    echo "Examples:"
    echo "  $0 staging"
    echo "  $0 production"
    exit 1
}

if [ "$#" -lt 1 ]; then
    usage
fi

ENV_TYPE="$1"
PROJECT_ID="${2:-ai-planner-project-467800}"

case "$ENV_TYPE" in
    staging|production) ;;
    *) usage ;;
esac
if [ "$PROJECT_ID" != "ai-planner-project-467800" ]; then
    echo "❌ Both environments deploy to ai-planner-project-467800 (got $PROJECT_ID)."
    exit 1
fi
SA_NAME="github-deploy-${ENV_TYPE}"

# Only workflow jobs running in this GitHub environment may impersonate the deploy account.
# The environment itself only accepts its branch (staging → staging, production → main) and
# requires the owner's approval (scripts/setup-repo-governance.sh).
OIDC_SUBJECT="repo:${GITHUB_REPO}:environment:${ENV_TYPE}"

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
# secretmanager.viewer lets `firebase deploy` confirm the functions' secret bindings without
# being able to read secret values. serviceAccountUser is granted only on the runtime
# service accounts below (Gen2 functions run as the compute account; the CLI also checks
# actAs on the App Engine default account), not project-wide.
# artifactregistry.admin: the CLI sets a cleanup policy on the gcf-artifacts repository;
# cloudscheduler.admin: scheduled functions (reconcileStuckSyncs) create Scheduler jobs;
# serviceusage.serviceUsageViewer: the CLI checks that required APIs are enabled.
ROLES=(
    "roles/firebase.admin"
    "roles/cloudfunctions.admin"
    "roles/run.admin"
    "roles/secretmanager.viewer"
    "roles/artifactregistry.admin"
    "roles/cloudscheduler.admin"
    "roles/serviceusage.serviceUsageViewer"
)

for ROLE in "${ROLES[@]}"; do
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member="serviceAccount:$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com" \
        --role="$ROLE" \
        --condition=None \
        --quiet >/dev/null
done

PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)")
for RUNTIME_SA in "${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" "${PROJECT_ID}@appspot.gserviceaccount.com"; do
    echo "  Granting serviceAccountUser on runtime account $RUNTIME_SA"
    gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
        --project="$PROJECT_ID" \
        --member="serviceAccount:$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com" \
        --role="roles/iam.serviceAccountUser" \
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
        --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.environment=assertion.environment,attribute.ref=assertion.ref" \
        --attribute-condition="assertion.repository=='${GITHUB_REPO}'" \
        --issuer-uri="https://token.actions.githubusercontent.com"
else
    echo "  OIDC provider exists — enforcing repository condition and mapping."
    gcloud iam workload-identity-pools providers update-oidc "$PROVIDER_NAME" \
        --project="$PROJECT_ID" \
        --location="global" \
        --workload-identity-pool="$POOL_NAME" \
        --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.environment=assertion.environment,attribute.ref=assertion.ref" \
        --attribute-condition="assertion.repository=='${GITHUB_REPO}'" \
        --quiet >/dev/null
fi

# 6. Bind the deploy account to this repo's <environment> jobs only
WIF_PROVIDER_RESOURCE="projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL_NAME/providers/$PROVIDER_NAME"

gcloud iam service-accounts add-iam-policy-binding "$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com" \
    --project="$PROJECT_ID" \
    --role="roles/iam.workloadIdentityUser" \
    --member="principal://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL_NAME/subject/$OIDC_SUBJECT" \
    --quiet >/dev/null

# Remove the old repo-wide binding (any branch/workflow could deploy) if a previous run added it
# to the legacy shared account.
gcloud iam service-accounts remove-iam-policy-binding "github-deploy@$PROJECT_ID.iam.gserviceaccount.com" \
    --project="$PROJECT_ID" \
    --role="roles/iam.workloadIdentityUser" \
    --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL_NAME/attribute.repository/$GITHUB_REPO" \
    --quiet >/dev/null 2>&1 || true
for OLD_ROLE in roles/secretmanager.secretAccessor roles/iam.serviceAccountUser; do
    gcloud projects remove-iam-policy-binding "$PROJECT_ID" \
        --member="serviceAccount:$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com" \
        --role="$OLD_ROLE" --condition=None --quiet >/dev/null 2>&1 || true
done

echo "=============================================================================="
echo "✅ OIDC Setup Complete for $PROJECT_ID!"
echo ""
echo "Add these as *environment* variables on the GitHub '$ENV_TYPE' environment:"
echo "  gh variable set WIF_PROVIDER --env $ENV_TYPE --body \"$WIF_PROVIDER_RESOURCE\""
echo "  gh variable set SA_EMAIL --env $ENV_TYPE --body \"$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com\""
echo "Then delete FIREBASE_TOKEN:  gh secret delete FIREBASE_TOKEN  (and revoke "Firebase CLI" access at https://myaccount.google.com/permissions)"
echo "  WIF_PROVIDER: $WIF_PROVIDER_RESOURCE"
echo "  SA_EMAIL:     $SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"
echo "=============================================================================="

#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   PROJECT_ID="your-gcp-project" ./ops/observability/setup_gcp_alerts.sh
#
# Optional environment variables:
#   REGION="us-central1"
#   SERVICE_REGEX="syncplanner.*"
#   EMAIL_ADDRESS="alerts@example.com"
#   NOTIFICATION_CHANNELS="projects/<id>/notificationChannels/123,projects/<id>/notificationChannels/456"
#
# Notes:
# - This script creates/updates log-based metrics and alerting policies.
# - If EMAIL_ADDRESS is provided, the script will create (or reuse) an email notification channel.
# - If NOTIFICATION_CHANNELS is provided, those channels are attached as well.

PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-us-central1}"
SERVICE_REGEX="${SERVICE_REGEX:-syncplanner.*}"
EMAIL_ADDRESS="${EMAIL_ADDRESS:-}"
SLACK_CHANNEL_ID="${SLACK_CHANNEL_ID:-}"
SLACK_AUTH_TOKEN="${SLACK_AUTH_TOKEN:-}"
NOTIFICATION_CHANNELS="${NOTIFICATION_CHANNELS:-}"

if [[ -z "${PROJECT_ID}" ]]; then
    echo "ERROR: PROJECT_ID is required."
    echo "Example: PROJECT_ID=\"ai-planner-project-467800\" ./ops/observability/setup_gcp_alerts.sh"
    exit 1
fi

if ! command -v gcloud >/dev/null 2>&1; then
    echo "ERROR: gcloud CLI is required."
    exit 1
fi

echo "Project: ${PROJECT_ID}"
echo "Region: ${REGION}"
echo "Service regex: ${SERVICE_REGEX}"

declare -a CHANNEL_IDS=()

if [[ -n "${NOTIFICATION_CHANNELS}" ]]; then
    IFS=',' read -r -a raw_channels <<< "${NOTIFICATION_CHANNELS}"
    for ch in "${raw_channels[@]}"; do
        trimmed="$(echo "${ch}" | xargs)"
        [[ -n "${trimmed}" ]] && CHANNEL_IDS+=("${trimmed}")
    done
fi

if [[ -n "${EMAIL_ADDRESS}" ]]; then
    echo "Ensuring email notification channel for ${EMAIL_ADDRESS}..."
    existing_email_channel="$(gcloud monitoring channels list \
        --project "${PROJECT_ID}" \
        --filter "type=\"email\" AND labels.email_address=\"${EMAIL_ADDRESS}\"" \
        --format "value(name)" | head -n1 || true)"

    if [[ -z "${existing_email_channel}" ]]; then
        existing_email_channel="$(gcloud monitoring channels create \
            --project "${PROJECT_ID}" \
            --display-name "AI Planner Alerts Email (${EMAIL_ADDRESS})" \
            --type email \
            --channel-labels "email_address=${EMAIL_ADDRESS}" \
            --format "value(name)")"
        echo "Created email channel: ${existing_email_channel}"
    else
        echo "Reusing existing email channel: ${existing_email_channel}"
    fi
    CHANNEL_IDS+=("${existing_email_channel}")
fi

if [[ -n "${SLACK_CHANNEL_ID}" && -n "${SLACK_AUTH_TOKEN}" ]]; then
    echo "Ensuring Slack notification channel for ${SLACK_CHANNEL_ID}..."
    existing_slack_channel="$(gcloud monitoring channels list \
        --project "${PROJECT_ID}" \
        --filter "type=\"slack\" AND labels.channel_name=\"${SLACK_CHANNEL_ID}\"" \
        --format "value(name)" | head -n1 || true)"

    if [[ -z "${existing_slack_channel}" ]]; then
        existing_slack_channel="$(gcloud monitoring channels create \
            --project "${PROJECT_ID}" \
            --display-name "AI Planner Alerts Slack (${SLACK_CHANNEL_ID})" \
            --type slack \
            --channel-labels "channel_name=${SLACK_CHANNEL_ID},auth_token=${SLACK_AUTH_TOKEN}" \
            --format "value(name)")"
        echo "Created Slack channel: ${existing_slack_channel}"
    else
        echo "Reusing existing Slack channel: ${existing_slack_channel}"
    fi
    CHANNEL_IDS+=("${existing_slack_channel}")
fi

CHANNEL_JSON="[]"
if (( ${#CHANNEL_IDS[@]} > 0 )); then
    quoted="$(printf '"%s",' "${CHANNEL_IDS[@]}")"
    CHANNEL_JSON="[${quoted%,}]"
fi

echo "Notification channels: ${CHANNEL_JSON}"

ensure_log_metric() {
    local name="$1"
    local description="$2"
    local filter="$3"

    if gcloud logging metrics describe "${name}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
        gcloud logging metrics update "${name}" \
            --project "${PROJECT_ID}" \
            --description "${description}" \
            --log-filter "${filter}" >/dev/null
        echo "Updated log metric: ${name}"
    else
        gcloud logging metrics create "${name}" \
            --project "${PROJECT_ID}" \
            --description "${description}" \
            --log-filter "${filter}" >/dev/null
        echo "Created log metric: ${name}"
    fi
}

upsert_policy() {
    local display_name="$1"
    local json_path="$2"
    local existing_id

    existing_id="$(gcloud monitoring policies list \
        --project "${PROJECT_ID}" \
        --filter "displayName=\"${display_name}\"" \
        --format "value(name)" | head -n1 || true)"

    if [[ -n "${existing_id}" ]]; then
        gcloud monitoring policies delete "${existing_id}" \
            --project "${PROJECT_ID}" \
            --quiet >/dev/null
        echo "Deleted existing policy: ${display_name}"
    fi

    gcloud monitoring policies create \
        --project "${PROJECT_ID}" \
        --policy-from-file "${json_path}" >/dev/null
    echo "Created policy: ${display_name}"
}

gemini_filter="(resource.type=\"cloud_run_revision\" OR resource.type=\"cloud_function\") AND \
(resource.labels.service_name=~\"${SERVICE_REGEX}\" OR resource.labels.function_name=\"syncPlanner\") AND \
(textPayload=~\"Model gemini.*failed\" OR textPayload:\"RATE_LIMIT\" OR jsonPayload.message=~\"Model gemini.*failed\" OR jsonPayload.message:\"RATE_LIMIT\")"

notion_filter="(resource.type=\"cloud_run_revision\" OR resource.type=\"cloud_function\") AND \
(resource.labels.service_name=~\"${SERVICE_REGEX}\" OR resource.labels.function_name=\"syncPlanner\") AND \
(textPayload:\"Notion Sync Error\" OR textPayload:\"Notion Direct Upload Error\" OR jsonPayload.message:\"Notion Sync Error\" OR jsonPayload.message:\"Notion Direct Upload Error\")"

ensure_log_metric \
    "ai_planner_gemini_failures_count" \
    "Count of syncPlanner logs indicating Gemini failures/rate limiting." \
    "${gemini_filter}"

ensure_log_metric \
    "ai_planner_notion_failures_count" \
    "Count of syncPlanner logs indicating Notion sync/upload failures." \
    "${notion_filter}"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

cat > "${tmp_dir}/p1_5xx_spike.json" <<EOF
{
  "displayName": "AI Planner P1 - syncPlanner 5xx spike",
  "documentation": {
    "content": "P1 alert: syncPlanner is returning elevated 5xx errors. Check deployment health, external API dependencies, and recent rollout changes.",
    "mimeType": "text/markdown"
  },
  "combiner": "OR",
  "enabled": true,
  "notificationChannels": ${CHANNEL_JSON},
  "alertStrategy": {
    "autoClose": "1800s"
  },
  "conditions": [
    {
      "displayName": "5xx rate > 5 requests/min for 5 minutes",
      "conditionThreshold": {
        "filter": "metric.type=\\"run.googleapis.com/request_count\\" resource.type=\\"cloud_run_revision\\" resource.label.\\"location\\"=\\"${REGION}\\" resource.label.\\"service_name\\"=monitoring.regex.full_match(\\"${SERVICE_REGEX}\\") metric.label.\\"response_code_class\\"=\\"5xx\\"",
        "aggregations": [
          {
            "alignmentPeriod": "60s",
            "perSeriesAligner": "ALIGN_RATE",
            "crossSeriesReducer": "REDUCE_SUM",
            "groupByFields": []
          }
        ],
        "comparison": "COMPARISON_GT",
        "thresholdValue": 0.0833333,
        "duration": "300s",
        "trigger": {
          "count": 1
        }
      }
    }
  ]
}
EOF

cat > "${tmp_dir}/p2_gemini_failures.json" <<EOF
{
  "displayName": "AI Planner P2 - Gemini failure burst",
  "documentation": {
    "content": "P2 alert: Gemini failures are elevated. Validate Gemini API availability, quota/rate-limit trends, and fallback model behavior.",
    "mimeType": "text/markdown"
  },
  "combiner": "OR",
  "enabled": true,
  "notificationChannels": ${CHANNEL_JSON},
  "alertStrategy": {
    "autoClose": "1800s"
  },
  "conditions": [
    {
      "displayName": "Gemini failure count > 10 in 5 minutes",
      "conditionThreshold": {
        "filter": "metric.type=\\"logging.googleapis.com/user/ai_planner_gemini_failures_count\\"",
        "aggregations": [
          {
            "alignmentPeriod": "300s",
            "perSeriesAligner": "ALIGN_SUM",
            "crossSeriesReducer": "REDUCE_SUM",
            "groupByFields": []
          }
        ],
        "comparison": "COMPARISON_GT",
        "thresholdValue": 10,
        "duration": "0s",
        "trigger": {
          "count": 1
        }
      }
    }
  ]
}
EOF

cat > "${tmp_dir}/p2_notion_failures.json" <<EOF
{
  "displayName": "AI Planner P2 - Notion failure burst",
  "documentation": {
    "content": "P2 alert: Notion sync/upload failures are elevated. Validate Notion API health, token validity, and upload endpoint behavior.",
    "mimeType": "text/markdown"
  },
  "combiner": "OR",
  "enabled": true,
  "notificationChannels": ${CHANNEL_JSON},
  "alertStrategy": {
    "autoClose": "1800s"
  },
  "conditions": [
    {
      "displayName": "Notion failure count > 6 in 5 minutes",
      "conditionThreshold": {
        "filter": "metric.type=\\"logging.googleapis.com/user/ai_planner_notion_failures_count\\"",
        "aggregations": [
          {
            "alignmentPeriod": "300s",
            "perSeriesAligner": "ALIGN_SUM",
            "crossSeriesReducer": "REDUCE_SUM",
            "groupByFields": []
          }
        ],
        "comparison": "COMPARISON_GT",
        "thresholdValue": 6,
        "duration": "0s",
        "trigger": {
          "count": 1
        }
      }
    }
  ]
}
EOF

cat > "${tmp_dir}/p2_latency.json" <<EOF
{
  "displayName": "AI Planner P2 - syncPlanner p95 latency high",
  "documentation": {
    "content": "P2 alert: syncPlanner p95 latency is elevated. Inspect upstream API latency, retries, and high payload volume.",
    "mimeType": "text/markdown"
  },
  "combiner": "OR",
  "enabled": true,
  "notificationChannels": ${CHANNEL_JSON},
  "alertStrategy": {
    "autoClose": "1800s"
  },
  "conditions": [
    {
      "displayName": "p95 request latency > 60s for 10 minutes",
      "conditionThreshold": {
        "filter": "metric.type=\\"run.googleapis.com/request_latencies\\" resource.type=\\"cloud_run_revision\\" resource.label.\\"location\\"=\\"${REGION}\\" resource.label.\\"service_name\\"=monitoring.regex.full_match(\\"${SERVICE_REGEX}\\")",
        "aggregations": [
          {
            "alignmentPeriod": "300s",
            "perSeriesAligner": "ALIGN_PERCENTILE_95",
            "crossSeriesReducer": "REDUCE_MAX",
            "groupByFields": []
          }
        ],
        "comparison": "COMPARISON_GT",
        "thresholdValue": 60000,
        "duration": "600s",
        "trigger": {
          "count": 1
        }
      }
    }
  ]
}
EOF

upsert_policy "AI Planner P1 - syncPlanner 5xx spike" "${tmp_dir}/p1_5xx_spike.json"
upsert_policy "AI Planner P2 - Gemini failure burst" "${tmp_dir}/p2_gemini_failures.json"
upsert_policy "AI Planner P2 - Notion failure burst" "${tmp_dir}/p2_notion_failures.json"
upsert_policy "AI Planner P2 - syncPlanner p95 latency high" "${tmp_dir}/p2_latency.json"

echo ""
echo "Done. Created/updated:"
echo "- log metric: ai_planner_gemini_failures_count"
echo "- log metric: ai_planner_notion_failures_count"
echo "- policy: AI Planner P1 - syncPlanner 5xx spike"
echo "- policy: AI Planner P2 - Gemini failure burst"
echo "- policy: AI Planner P2 - Notion failure burst"
echo "- policy: AI Planner P2 - syncPlanner p95 latency high"
echo ""
echo "Tip: If your Cloud Run service name differs, rerun with SERVICE_REGEX."
echo "Example: SERVICE_REGEX=\"syncplanner-.*\" PROJECT_ID=\"${PROJECT_ID}\" ./ops/observability/setup_gcp_alerts.sh"

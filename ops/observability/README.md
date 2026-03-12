# Observability Bootstrap (GCP)

This folder provides baseline monitoring for AI Planner:

- `P1`: syncPlanner 5xx spike
- `P2`: Gemini failure burst
- `P2`: Notion failure burst
- `P2`: syncPlanner p95 latency high

It also creates/updates log-based counters used by alert policies:

- `logging.googleapis.com/user/ai_planner_gemini_failures_count`
- `logging.googleapis.com/user/ai_planner_notion_failures_count`

## Recommended Notification Strategy

Use both channels:

1. Email (required baseline)
2. Slack/Webhook (recommended for fast triage)

Suggested routing:

1. P1 alerts: email + Slack immediately
2. P2 alerts: Slack immediately, email optionally batched/digested

## Prerequisites

1. `gcloud` installed and authenticated
2. IAM roles that can create logging metrics and monitoring policies/channels
3. Cloud Functions Gen2/Cloud Run metrics enabled in project

## One-Time Setup

From repository root:

```bash
chmod +x ops/observability/setup_gcp_alerts.sh
PROJECT_ID="ai-planner-project-467800" \
REGION="us-central1" \
SERVICE_REGEX="syncplanner.*" \
EMAIL_ADDRESS="alerts@yourdomain.com" \
./ops/observability/setup_gcp_alerts.sh
```

If you already have notification channels, pass them directly:

```bash
PROJECT_ID="ai-planner-project-467800" \
NOTIFICATION_CHANNELS="projects/ai-planner-project-467800/notificationChannels/123,projects/ai-planner-project-467800/notificationChannels/456" \
./ops/observability/setup_gcp_alerts.sh
```

## Default Thresholds (in script)

1. `P1 5xx spike`: sustained > 5 errors/min for 5 min
2. `P2 Gemini`: > 10 failure logs in 5 min
3. `P2 Notion`: > 6 failure logs in 5 min
4. `P2 Latency`: p95 > 60s for 10 min

These are initial values. Tune after collecting baseline production traffic for 1-2 weeks.

## Post-Setup Verification

```bash
gcloud logging metrics list --project "ai-planner-project-467800" | rg ai_planner_
gcloud monitoring policies list --project "ai-planner-project-467800" --format="table(displayName,enabled)"
```

## Notes

1. Service name patterns vary by deployment; if policies never fire, adjust `SERVICE_REGEX`.
2. Gemini/Notion failure alerts depend on existing log text patterns in backend logs.
3. Keep alert docs and thresholds in git so on-call behavior stays consistent.

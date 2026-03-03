# Breach Response Plan

> **Status**: Documented process. Automated detection is a future enhancement.

## 1. What Constitutes a Breach

A breach is any unauthorized access to user data stored in Firestore:
- **Stored data at risk**: Email addresses, encrypted Notion API keys, Notion database IDs.
- **NOT at risk**: Planner images, journal text, calendar data (Zero Storage — never persisted).

## 2. Detection Methods

### Current (Manual)
- Monitor Firebase Console for unusual Firestore read/write patterns.
- Check Cloud Function logs for unexpected `resolveUserEmailFromGoogleToken` failures (may indicate token theft).
- Review GCP Audit Logs periodically: `console.cloud.google.com` → IAM & Admin → Audit Logs.

### Future (Automated)
- Set up Cloud Monitoring alerts for:
  - Firestore reads > 100/hour (unusual for a beta app).
  - Cloud Function error rate > 10%.
  - Failed auth attempts spike.
- Enable Firestore Audit Logging for data access events.

## 3. Response Timeline (GDPR Art. 33)

| Time | Action |
|------|--------|
| **0–1 hour** | Confirm breach scope. Rotate `NOTION_ENCRYPTION_KEY` in Secret Manager. |
| **1–6 hours** | Revoke all Firebase Auth sessions. Deploy new encryption key. |
| **6–24 hours** | Assess impacted users. Prepare notification. |
| **24–72 hours** | Notify affected users via email. Report to supervisory authority if required. |

## 4. User Notification Template

```
Subject: Security Notice — AI Planner

Dear [User],

We detected unauthorized access to our database on [DATE]. 

What was exposed:
- Your email address
- Your encrypted Notion API key (encrypted with AES-256-CBC — not readable without our encryption key)

What was NOT exposed:
- Your planner images, journal entries, calendar data, or tasks (we never store these)

What we did:
- Rotated all encryption keys
- Revoked all active sessions
- Patched the vulnerability

What you should do:
- Regenerate your Notion Integration Key at notion.so/my-integrations
- Re-enter it in the AI Planner app

We sincerely apologize for this incident.

— AI Planner Team
```

## 5. Remediation Checklist

- [ ] Rotate `NOTION_ENCRYPTION_KEY` in Secret Manager
- [ ] Redeploy all Cloud Functions
- [ ] Force re-encryption of all stored Notion keys
- [ ] Review and patch the attack vector
- [ ] Update `privacy.html` with breach disclosure
- [ ] Document incident in `PROJECT_CHANGELOG_AND_CURRENT_ARCHITECTURE.md`

## 6. Key Rotation Process

```bash
# 1. Generate new key
openssl rand -base64 32

# 2. Update Secret Manager
firebase functions:secrets:set NOTION_ENCRYPTION_KEY

# 3. Redeploy functions
firebase deploy --only functions

# 4. Re-encrypt all existing keys (run once after rotation)
# Note: This requires a migration script that reads each user doc,
# decrypts with old key, re-encrypts with new key, and saves.
```

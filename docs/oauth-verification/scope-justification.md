# Scope Justification (Reviewer Copy)

Use this text in the Google OAuth verification form.

## App summary

AI Planner is a productivity app that converts planner images into actionable items and syncs them to Google services selected by the user.

The app does not request full Drive or full Calendar account access. It uses the minimum scopes required to perform the user-initiated sync actions.

## Requested scopes and why each is needed

### 1) `https://www.googleapis.com/auth/calendar.events`

Purpose:
- Create events/reminders in the user's primary Google Calendar during Morning Sync.

How it is used:
- Insert calendar events parsed from the planner page.

Why this scope:
- We only need event-level write access.
- We do not request broader Calendar scopes.

### 2) `https://www.googleapis.com/auth/tasks`

Purpose:
- Create and update Google Tasks from planner to-do items.

How it is used:
- Morning Sync: create tasks.
- Evening Sync: mark matching tasks as completed.

Why this scope:
- The app syncs task status and task creation directly to the user's task list.
- We do not request unrelated Gmail/Drive or broader account scopes for this feature.

### 3) `https://www.googleapis.com/auth/drive.file`

Purpose:
- Create and update a spreadsheet used by Evening Sync for expenses and health tracking.

How it is used:
- If no spreadsheet exists for the user, the app creates one.
- The app writes expense/health rows to this app-created file.

Why this scope:
- `drive.file` is least-privilege for file creation and management of app-created/opened files.
- It avoids full-drive access (`drive`) and is safer for users.
- Sheets-only scope can edit sheet content, but Drive access is required for reliable file creation and app file-level permissions.

## User control and data minimization

- Access is requested only to deliver explicit user-triggered sync actions.
- OAuth tokens are kept in memory and not persisted in browser storage.
- Users can revoke access from Google Account permissions at any time.
- Users can delete account-linked app data from within the app.

## Verification notes for reviewer

- Consent screen, homepage, and privacy policy are available on the same verified domain.
- Demo video shows:
  - OAuth consent flow and scopes
  - Morning Sync creating Calendar events and Tasks
  - Evening Sync creating/updating spreadsheet data
  - Account data delete/revoke path


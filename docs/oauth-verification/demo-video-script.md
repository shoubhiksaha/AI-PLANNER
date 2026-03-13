# End-to-End Demo Video Script (OAuth Verification)

Goal: Record one clean video (3-6 minutes) that proves exactly how scopes are used.

## Recording setup

- Use production domain (not localhost).
- Use a fresh browser profile/incognito so consent screen is shown.
- Keep zoom readable (125% if needed).
- Record full screen with URL bar visible.
- Speak or add captions for each step.

## Suggested timeline

### 00:00 - Show public pages on verified domain

1. Open homepage on your verified domain.
2. Open privacy policy from homepage.
3. Show both URLs are on the same verified domain.

Narration:
"This is the public homepage and privacy policy on our verified domain."

### 00:30 - Start sign-in and show consent screen

1. Click "Continue with Google".
2. On consent screen, pause so reviewer can read:
   - App name
   - Support email
   - Requested scopes
3. Continue sign-in.

Narration:
"Now I am showing the OAuth consent screen and requested scopes."

### 01:10 - Morning Sync (Calendar + Tasks)

1. Upload a sample planner image.
2. Click Morning Sync.
3. After success, open Google Calendar and show created event(s).
4. Open Google Tasks and show created task(s).

Narration:
"Morning Sync uses `calendar.events` and `tasks` to create user items."

### 02:20 - Evening Sync (Drive file + Sheets update)

1. Upload evening planner image.
2. Click Evening Sync.
3. Open Google Drive:
   - Show the spreadsheet created by the app (if first run).
4. Open that spreadsheet:
   - Show appended expense/health rows.

Narration:
"Evening Sync uses `drive.file` to create/manage the app spreadsheet and write rows."

### 03:30 - User control and revocation path

1. Show in-app Delete Account button/location.
2. Show Google permissions page and where user can revoke app access.

Narration:
"Users can delete app-linked data and revoke Google access anytime."

## What reviewer must clearly see

- Verified domain in URL bar.
- Consent screen and scope list.
- Real app flow after sign-in.
- Concrete effect of each scope:
  - Calendar events created
  - Tasks created/updated
  - Spreadsheet created/updated in Drive

## Export recommendation

- MP4, 1080p.
- Keep under 200 MB if possible.
- Name file: `ai-planner-oauth-verification-demo-YYYY-MM-DD.mp4`.


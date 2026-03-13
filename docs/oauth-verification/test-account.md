# Test Account Package (For OAuth Reviewers)

Use this template to prepare and hand off a stable test account.

Important: Do not commit real credentials to git. Keep final credentials in your secure password manager, then paste into the Google verification form.

## Reviewer account details (fill before submit)

- Login URL: `https://<your-verified-domain>/`
- Test email: `<reviewer-test-account@yourdomain.com>`
- Test password: `<set-password>`
- 2FA: `Disabled` or `Enabled with backup codes shared in form`
- Account recovery lockouts: `Disabled for review window`

## Preconfigured data checklist

- Account can sign in without owner approval prompts.
- Test account has access to:
  - Google Calendar
  - Google Tasks
  - Google Drive/Sheets
- App is already allowed on OAuth consent if needed for fast retest, but at least one fresh account is available to show consent screen.
- Optional: Add 1-2 sample planner images in test environment docs for consistent demo.

## Reviewer instructions (copy to form)

1. Open the app URL and sign in with the provided Google test account.
2. Upload provided sample planner image and run Morning Sync.
3. Verify created items in Calendar and Tasks.
4. Upload evening sample and run Evening Sync.
5. Verify spreadsheet is created/updated in Google Drive.

## Support contact for reviewer

- Support email: `<support@yourdomain.com>`
- Backup contact (optional): `<second-contact@yourdomain.com>`
- Response SLA during review period: `<e.g., within 24 hours>`

## Review window

- Start date: `<YYYY-MM-DD>`
- End date: `<YYYY-MM-DD>`
- Notes: Keep credentials valid and unchanged for the full review period.


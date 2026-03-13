# OAuth Verification Submission Checklist

Mark every item before submitting.

## A) Domain and public pages

- [ ] All OAuth authorized domains are verified in Google Search Console.
- [ ] Public homepage is live on verified domain.
- [ ] Public privacy policy is live on the same verified domain.
- [ ] Homepage links to privacy policy.
- [ ] OAuth consent screen links to the same privacy policy URL.

## B) Consent screen correctness

- [ ] App name matches branding used in product and docs.
- [ ] Support email is valid and monitored.
- [ ] Developer contact email is valid.
- [ ] Logo and app info are final (no temporary assets).
- [ ] Only necessary scopes are requested.

## C) Scope justification package

- [ ] Scope list exactly matches implementation:
  - `calendar.events`
  - `tasks`
  - `drive.file`
- [ ] Each scope has clear "why needed" text.
- [ ] Least-privilege rationale is included.
- [ ] Data handling and user revocation flow are documented.

## D) Demo video package

- [ ] Video shows verified domain URL.
- [ ] Video shows OAuth consent screen with requested scopes.
- [ ] Video shows Morning Sync effects in Calendar + Tasks.
- [ ] Video shows Evening Sync creating/updating Drive spreadsheet.
- [ ] Video shows account deletion/revocation path.
- [ ] Video link is publicly accessible to reviewers.

## E) Test account package

- [ ] Credentials are valid and tested.
- [ ] Account does not require manual owner intervention.
- [ ] Access to Calendar, Tasks, Drive is confirmed.
- [ ] Review support contact is included in form.
- [ ] Credentials will remain valid for full review timeline.

## F) Final quality gate

- [ ] Backend/frontend tests passing.
- [ ] No placeholder text remains in submitted docs/form.
- [ ] All links in submission open correctly without login barriers.


# Privacy Policy History

This folder archives every known version of the project's public privacy policy from git history.

Current live source:
- [`public/privacy.html`](../../public/privacy.html)

Notes:
- Snapshot filenames use the commit date plus commit hash.
- The `Last Updated` date shown inside a snapshot can differ from the commit date.
- Each HTML file is the exact policy content from that commit's `public/privacy.html`.

## Snapshot Index

| Commit Date | Displayed `Last Updated` | Commit | Snapshot | Notes |
| --- | --- | --- | --- | --- |
| 2026-01-27 | January 19, 2026 | `bdd433a` | [`2026-01-27-bdd433a.html`](./2026-01-27-bdd433a.html) | Initial privacy policy. |
| 2026-01-27 | January 19, 2026 | `089ccca` | [`2026-01-27-089ccca.html`](./2026-01-27-089ccca.html) | Added GDPR section. |
| 2026-03-03 | March 3, 2026 | `62e6476` | [`2026-03-03-62e6476.html`](./2026-03-03-62e6476.html) | Expanded security, added persisted-data and self-service rights details. |
| 2026-03-04 | March 3, 2026 | `433704c` | [`2026-03-04-433704c.html`](./2026-03-04-433704c.html) | Switched access/erasure language to in-app export and delete flows. |
| 2026-03-12 | March 3, 2026 | `941dbc6` | [`2026-03-12-941dbc6.html`](./2026-03-12-941dbc6.html) | Added Drive/Sheets coverage and updated encryption wording to AES-256-GCM. |
| 2026-03-24 | March 24, 2026 | `0afdaba` | [`2026-03-24-0afdaba.html`](./2026-03-24-0afdaba.html) | Date refresh. |
| 2026-03-24 | March 24, 2026 | `6b3b23c` | [`2026-03-24-6b3b23c.html`](./2026-03-24-6b3b23c.html) | Added BYOK provider and storage-mode disclosures. |
| 2026-04-13 | April 12, 2026 | `840edff` | [`2026-04-13-840edff.html`](./2026-04-13-840edff.html) | Rewritten into a shorter legal-style policy with definitions and retention language. |
| 2026-04-14 | April 12, 2026 | `ce3f710` | [`2026-04-14-ce3f710.html`](./2026-04-14-ce3f710.html) | Current version; explicitly lists Calendar, Tasks, and Drive usage. |

## Rebuild

To regenerate a specific snapshot from git:

```bash
git show <commit>:public/privacy.html
```

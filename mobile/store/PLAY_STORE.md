# Google Play listing and release

Everything the Play Console asks for, in the order it asks. Graphics are in this folder:

| File | Play Console field |
|---|---|
| `icon-512.png` | App icon (512 × 512) |
| `feature-graphic.png` | Feature graphic (1024 × 500) |
| `screenshots/*.png` | Phone screenshots (1080 × 2400, at least 2, up to 8). Sign-in is from the app; the others are the real page at phone size with a demo name. Add one from your phone with a real page in the tray, and one of the scanner, when you can. |

## Store listing

**App name** (30 characters at most)

> AI Planner – Paper to Calendar

**Short description** (80 characters at most)

> Photograph your paper planner. Events go to Calendar, to-dos to Google Tasks.

**Full description**

> Keep planning on paper. AI Planner reads your handwriting and puts everything where it belongs.
>
> Write your day in any planner, journal or notebook, take a photo, and AI Planner does the typing:
>
> • Morning plan: “9:00 Team call” becomes a Google Calendar event, “☐ Pay rent” becomes a Google Task.
> • Evening review: ticks off what you got done and logs spending and health to a Google Sheet.
> • Journal: saves your pages, with the text typed out, to your own Google Drive or Notion.
> • Voice notes (Pro): say a thought; it’s typed up for you.
>
> Made for phones:
> • Scan a page: Google’s document scanner finds the page, straightens it and removes shadows, so your handwriting reads clearly.
> • Share to AI Planner: send planner photos from your gallery or any app.
> • Reminders: an optional nudge in the morning and evening to photograph your page.
> • Shortcuts: long-press the icon to scan a page, see your sync history or your last 30 days.
> • Light and dark mode, in two styles.
>
> Private by design: your photos are processed and then discarded; they’re never stored on our servers. AI Planner asks for access to your Google Calendar events and Google Tasks so it can add what you wrote (and, if you choose, check that day for duplicates), and only to the files it makes in your Drive. Your data is never used to train AI models.
>
> Works with any notebook. Our free printable planner page works best.
>
> AI Planner is an offering by ADT (Analog Digital Technologies).

**App category:** Productivity. **Tags:** Planner, Calendar, Productivity.

**Contact details:** support@analogdigital.tech, website https://planner.analogdigital.tech

**Privacy policy:** https://planner.analogdigital.tech/privacy.html

## App content

**Ads:** No ads.

**App access:** Sign-in with Google is required. Give reviewers a test Google account with Calendar and Tasks, and these steps: “Tap Continue with Google, sign in, allow access. On the dashboard tap Camera to scan any handwritten page, then tap Morning plan.”

**Content rating** (IARC questionnaire): Utility/Productivity; no violence, sexual content, gambling or drugs; users don’t interact with each other; no location sharing; digital purchases (subscriptions through Cashfree). Expected rating: Everyone / PEGI 3.

**Target audience:** 18 and over (the app is not designed for children).

**Financial features:** none. **Health:** the evening review can log health notes the person writes; choose “Not a health app”.

**Government app:** No. **News app:** No.

### Data safety

Data is encrypted in transit. People can ask for deletion: in the app, Settings › Your data › Delete my account.

| Data type | Collected | Shared | Why | Optional |
|---|---|---|---|---|
| Name, email address | Yes | No | Account management, app functionality | No |
| Photos | Yes, processed, not stored | No* | App functionality (handwriting reading) | No |
| Voice or sound recordings | Yes, processed, not stored | No* | App functionality (voice notes) | Yes |
| Calendar events | Yes, processed, not stored | No | App functionality (adds events, checks for duplicates) | No |
| Purchase history | Yes | No | Account management (plan) | Yes |
| Crash logs, diagnostics | Yes | No | Analytics (fixing errors) | No |
| Other user-generated content (tasks, journal text) | Yes, processed, not stored | No* | App functionality | No |

\* Sent to the AI service that reads the page (Google Gemini, or the person’s own AI provider if they set one) only to process it; Play counts processing by a service provider on our behalf as not shared.

Not collected: location, contacts, SMS, browsing history, app activity outside AI Planner, device IDs, advertising IDs.

### Permissions (Play asks why for some)

| Permission | Why |
|---|---|
| Camera | Photograph planner pages (asked the first time someone taps Camera; the page scanner doesn’t need it). |
| Microphone | Record voice notes (asked on first recording). |
| Notifications | Optional morning and evening reminders (asked only when someone turns a reminder on). |
| Run at startup (`RECEIVE_BOOT_COMPLETED`) | Keeps reminders scheduled after the phone restarts. |
| Internet, vibrate | Load the planner; light haptic feedback on taps. |

No exact alarms, no background location, no SMS or call log, no all-files access, no overlays.

## Open before publishing: payments

The app sells Standard, Pro and Booster Packs with Cashfree inside the WebView. Google Play's payments policy requires digital plans bought in an app to use Google Play Billing (or, for users in India, Google's user choice billing program), and forbids pointing people to another way to pay. Expect the Play review to reject the app until this is decided. The owner chose (2026-11-21) to keep Cashfree for now and decide later. The options:

- **No buying in the app:** hide the upgrade buttons and the pricing sheet inside the app; people upgrade on the website and the app shows their plan.
- **Google Play Billing:** Play products, server-side receipt checks, plan syncing with Cashfree buyers; Google takes 15 %.
- **User choice billing (India):** Cashfree beside Google Play Billing, after enrolling; a reduced Google fee.

Internal testing tracks don't go through full review, so testers can use the app as it is in the meantime.

## Release steps

1. **Signing:** EAS keeps the upload key (`eas credentials`). Add the **SHA-1 of the Play app-signing key** (Play Console › Test and release › App integrity) and of the EAS upload key to the Android OAuth client in Google Cloud (project of client `195957114195-…`). Without it Google sign-in fails in store builds.
2. **Build:** `cd mobile && eas build --platform android --profile production` (an `.aab`; the version code goes up by itself).
3. **Internal testing first:** Play Console › Test and release › Internal testing › Create release, upload the `.aab`, add testers by email. Check on a real phone:
   - sign-in;
   - Camera opens the scanner and pages land in the tray;
   - a morning plan sync;
   - Share from Google Photos;
   - long-press shortcuts;
   - a reminder (set it 2 minutes ahead);
   - Back, dark mode and the Cheerful style;
   - offline, then back online;
   - a Pro upgrade with a Cashfree test card on the staging build.
4. **Closed testing:** new personal developer accounts must run a closed test with at least 12 testers for 14 days before production access.
5. **Production:** promote the tested release; start with a staged rollout (for example 20 %).

Target API level: Expo SDK 58 targets the API level Google Play currently requires; check the warning in the Play Console when uploading.

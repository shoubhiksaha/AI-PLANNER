# Mobile app

The Android and iOS app (`mobile/`, Expo) signs in natively with Google and shows the web app (`planner.analogdigital.tech`, or staging with `EXPO_PUBLIC_WEB_BASE_URL`) in a WebView. Web features reach the app without a new release. The app adds the native parts:

| Part | Where |
|---|---|
| Sign-in screen, "Opening your planner…", offline and load-error screens | `mobile/screens.js` |
| Colours (ADT tokens, Space Grotesk) | `mobile/theme.js`, `mobile/assets/fonts/` |
| Scripts injected into the page and checks on what the page sends | `mobile/bridge.js` (unit-tested in `bridge.test.mjs`) |
| Everything else: session, WebView, Back, camera, saving files, wiring the parts below | `mobile/App.js` |
| Page scanner (Google's ML Kit document scanner, a local Expo module) | `mobile/modules/document-scanner/` |
| Shared and scanned photos made ready for the page (JPEG, 2400 px at most) | `mobile/images.js` |
| Morning and evening reminders (local notifications) | `mobile/reminders.js` |
| Long-press icon shortcuts (config plugin) | `mobile/plugins/withAppShortcuts.js` |
| Play Store listing, data safety, graphics, release steps | `mobile/store/` |

`android/` and `ios/` are generated: change `app.json` and run `npx expo prebuild`, never edit them by hand.

## How the app and the page talk

The page posts JSON `{ type, payload }` with `window.ReactNativeWebView.postMessage`. The app ignores messages from any origin other than the two app origins.

| Message | From | What happens |
|---|---|---|
| `MOBILE_LOGIN_SUCCESS`, `MOBILE_APP_READY` | page | The app hides "Opening your planner…". |
| `MOBILE_LOGIN_ERROR` | page | Offline: the offline screen, then a reload when the connection is back. Otherwise: back to sign-in. |
| `GOOGLE_TOKEN_REFRESH_REQUEST` | page | The app fetches a fresh Google token and hands it over (`window.mobileUpdateAccessToken`). |
| `SIGNOUT` | page | The app signs out of Google too. |
| `THEME { dark, background }` | injected script | The status bar, navigation bar and edges take the page's colours (both styles, light and dark). |
| `BACK_RESULT { handled }` | injected script | Android Back: `window.handleNativeBack()` in `public/app.js` closes the theme menu, the top dialog or a sub-screen. When nothing was open, the WebView goes back or the app closes. |
| `REQUEST_CAMERA` | page | Android only. The WebView silently ignores a camera input without the CAMERA permission, so the page asks first (`window.__aiPlannerCameraAllowed === false`). The app asks Android, then reopens the camera input. If the permission was refused for good, it offers to open Settings. |
| `SAVE_FILE { fileName, mimeType, text }` | page | "Export my data". The WebView can't save `blob:` links, so the app writes the file to its cache and opens the share sheet. |
| `HAPTIC_LIGHT`, `HAPTIC_HEAVY` | injected script | A short vibration on taps. |
| `SCAN_PAGES { maxPages }` | page | Camera, when the app has the scanner (`window.__aiPlannerApp.scanner`). The app opens Google's document scanner for at most the pages that still fit the plan, then hands the pages over. If the scanner can't open, the app turns it off and the page uses its camera input again. |
| `SET_REMINDERS { morning, evening }` | page | Settings › Reminders (shown only in the app). Each is `{ on, time: "HH:MM" }`. The app asks for the notification permission when one is turned on, schedules them and reports back in `remindersResult`. |

The app calls into the page (only on the two app origins, after the signed-in page has shown a screen):

| Call | When |
|---|---|
| `window.__aiPlannerApp = { scanner, reminders, remindersResult? }`, then `window.aiPlannerAppStateChanged()` | Once per page load, and when something changes. |
| `window.aiPlannerPreparingImages()`, then `window.aiPlannerAddImages([{ name, mimeType, base64 }])` | Scanned pages, and photos shared to the app from any other app. They go into the tray like photos picked in the page. |
| `window.aiPlannerOpen('scan' \| 'history' \| 'reports')` | An icon shortcut or a reminder (links `aiplanner://scan` and so on). Before sign-in the app keeps it and opens it afterwards. |

Changes on the web side ship separately from app releases, so both sides must cope with the other being older:
- The page only uses a bridge feature when the app has signalled it. For example, the camera flag is `undefined` in older apps.
- The app falls back when the page doesn't answer. For example, Back goes back natively after 600 ms.

## Permissions (Android)

| Permission | Why |
|---|---|
| `CAMERA` | Asked the first time someone taps Camera, not at start-up. |
| `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS` | Voice notes. The WebView asks the first time someone records. |
| `POST_NOTIFICATIONS` | Reminders. Asked only when someone turns a reminder on. |
| `RECEIVE_BOOT_COMPLETED` | Keeps reminders scheduled after a restart (added by expo-notifications). Reminders use inexact alarms, so no exact-alarm permission. |
| `INTERNET`, `VIBRATE` | — |
| `SYSTEM_ALERT_WINDOW` | Blocked: the app draws no overlays. |

The page scanner runs inside Google Play services and needs no permission. Share to AI Planner accepts images only (`image/*`, one or several).

## Building and testing

- `cd mobile && npm run lint && npm test`: the bridge and theme unit tests (also in CI).
- The page side of the bridge is covered by tests in two places:
  - `e2e/tests/ui.spec.js`, "In the mobile app": Back, camera, scanner, shared photos, shortcuts and reminders.
  - `e2e/tests/emulator/account-and-security.spec.js`: export.
- Local Android build. It needs JDK 17+ and the Android SDK:
  ```
  cd mobile && npx expo prebuild --platform android
  cd android && EXPO_PUBLIC_WEB_BASE_URL=https://staging-planner.analogdigital.tech ./gradlew assembleRelease
  adb install -r app/build/outputs/apk/release/app-release.apk
  ```
  This build is signed with the debug key, so it is for testing only.
- Try the native extras on a device or emulator without signing in: they wait until the page is ready, so the app must not crash.
  ```
  adb shell am start -a android.intent.action.VIEW -d aiplanner://history com.analogdigital.aiplanner
  adb shell dumpsys shortcut | grep -o "id=[a-z]*"     # scan, history, reports
  ```
  The scanner and reminders open from the signed-in page, so they need a build whose sign-in works.
- Store builds: `eas build --platform android --profile production`. This needs the owner's Expo account. Everything else for Google Play is in `mobile/store/PLAY_STORE.md`.
- Google sign-in only works in builds signed with a key registered in the Google Cloud OAuth client: the EAS keys, or the debug key if it is added there. A local test build without it stops at the Google account picker.

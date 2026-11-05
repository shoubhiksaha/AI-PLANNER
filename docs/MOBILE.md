# Mobile app

The Android and iOS app (`mobile/`, Expo) signs in natively with Google and shows the web app (`planner.analogdigital.tech`, or staging with `EXPO_PUBLIC_WEB_BASE_URL`) in a WebView. Web features reach the app without a new release. The app adds the native parts:

| Part | Where |
|---|---|
| Sign-in screen, "Opening your planner…", offline and load-error screens | `mobile/screens.js` |
| Colours (ADT tokens, Space Grotesk) | `mobile/theme.js`, `mobile/assets/fonts/` |
| Scripts injected into the page and checks on what the page sends | `mobile/bridge.js` (unit-tested in `bridge.test.mjs`) |
| Everything else: session, WebView, Back, camera, saving files | `mobile/App.js` |

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

Changes on the web side ship separately from app releases, so both sides must cope with the other being older:
- The page only uses a bridge feature when the app has signalled it. For example, the camera flag is `undefined` in older apps.
- The app falls back when the page doesn't answer. For example, Back goes back natively after 600 ms.

## Permissions (Android)

| Permission | Why |
|---|---|
| `CAMERA` | Asked the first time someone taps Camera, not at start-up. |
| `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS` | Voice notes. The WebView asks the first time someone records. |
| `INTERNET`, `VIBRATE` | — |
| `POST_NOTIFICATIONS`, `SYSTEM_ALERT_WINDOW` | Blocked: the app sends no notifications and draws no overlays. |

## Building and testing

- `cd mobile && npm run lint && npm test`: the bridge and theme unit tests (also in CI).
- The page side of the bridge is covered by tests in two places:
  - `e2e/tests/ui.spec.js`, "In the mobile app": Back and camera.
  - `e2e/tests/emulator/account-and-security.spec.js`: export.
- Local Android build. It needs JDK 17+ and the Android SDK:
  ```
  cd mobile && npx expo prebuild --platform android
  cd android && EXPO_PUBLIC_WEB_BASE_URL=https://staging-planner.analogdigital.tech ./gradlew assembleRelease
  adb install -r app/build/outputs/apk/release/app-release.apk
  ```
  This build is signed with the debug key, so it is for testing only.
- Store builds: `eas build --platform android --profile production`. This needs the owner's Expo account.
- Google sign-in only works in builds signed with a key registered in the Google Cloud OAuth client: the EAS keys, or the debug key if it is added there. A local test build without it stops at the Google account picker.

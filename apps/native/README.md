# TBBT Field (native)

True React Native / Expo shell for the assigned-job **Today** read flow and explicit **Start job** / **Complete job** / **Stop job time** / **Start travel** / **Stop travel** / **Start material pickup** / **Stop material pickup** / **pickup item record** / Cleaning **visit outcome** / crew **checklist** (local draft + explicit sync) / offline **start/stop time intents** (local draft + explicit sync) / own **time-card correction request** actions.

This app does **not** embed the TBBT website in a WebView. It talks to the Bearer field API in `src/app/api/native/v1`.

## Run

```bash
cp .env.example .env
# Set EXPO_PUBLIC_TBBT_API_URL to the TBBT origin, e.g. http://localhost:43217
npm install
npx expo start
```

Sign in with a real TBBT account. The server issues a session token; this app stores only that token in SecureStore. Passwords are never written to disk.

A MEMBER sees only jobs assigned to them. An OWNER/ADMIN using this app also sees only their own assigned jobs — never owner Today or invoices.

## Android test build (UNVERIFIED without an Android SDK/device)

This environment has not assembled an APK and has not run the app on a device. Not Play submission. No production/submit EAS profile and no store credentials.

What the recipes actually produce:

- `bash scripts/android-debug-apk.sh` / `npm run android:debug-apk`: Expo prebuild + Gradle `assembleDebug`. That is a **debug native shell**. It still needs Metro for JS unless you separately export and embed a bundle. `expo prebuild` rewrites the `android` / `ios` scripts in `apps/native/package.json`; the wrapper copies that tracked file aside and restores it after prebuild so the tree stays clean.
- `eas.json` `preview`: an **internal release-type APK** (`buildType: apk`). Expo SDK 54 release manifests do not honor `usesCleartextTraffic`, so `EXPO_PUBLIC_TBBT_API_URL` must be **https**. The committed value is the reachable TBBT origin `https://www.collproreno.com`. Do not commit Apple or Play credentials.

`app.json` does not enable cleartext HTTP. The emulator loopback rewrite (`localhost` → `10.0.2.2`) is only for Android debug/dev against a host machine; it does not make a release APK accept HTTP.

Sign-out revokes the device token with both a JSON body and `x-tbbt-device-token` so a dropped DELETE body still signs the Android device out.

## iOS test build (UNVERIFIED without Xcode / a device)

This environment cannot sign or install an iOS build (`xcodebuild` is absent). Not App Store submission. No Apple credentials, provisioning profiles, or `submit` EAS profile.

What the recipes actually produce:

- `bash scripts/ios-simulator-build.sh --prebuild-only` / `npm run ios:prebuild`: Expo prebuild for `com.tbbt.field` with `ios.buildNumber` **1**. `--no-install` skips CocoaPods so Linux can inspect the generated project. The wrapper restores tracked `apps/native/package.json`.
- `bash scripts/ios-simulator-build.sh` / `npm run ios:simulator`: requires `xcodebuild` and `pod` **before** the slow prebuild (exit 2 UNVERIFIED if either is missing). Then Expo prebuild, `pod install` in `ios/`, and `xcodebuild -workspace` for the iOS **simulator** with `CODE_SIGNING_ALLOWED=NO`. A bare `.xcodeproj` build is not used: the generated project has a CocoaPods `[CP] Check Pods Manifest.lock` phase. On Linux this exits 2 and does not install anything.
- `eas.json` `preview` iOS: `distribution: internal` + `simulator: true`, same https `EXPO_PUBLIC_TBBT_API_URL`. No store submission.
- Generated `Info.plist` keeps Expo's default `NSAllowsLocalNetworking` **true** (local Metro) and `NSAllowsArbitraryLoads` **false**. The iOS `buildNumber` must increase monotonically for each uploaded build.

Do not claim a device or simulator walkthrough succeeded unless that signed/simulator build was installed. This recipe is UNVERIFIED here.

## Limits

Today + job detail, plus Start job, Complete job, Stop job time, assigned-job travel and material pickup time, purchase-list pickup item recording, Cleaning visit outcome, crew checklist local drafts with explicit sync, assigned-job photo capture/review, and a Time cards screen for the assigned worker's own recorded time. The worker can request a correction and see its recorded status. OWNER accept/decline stays on the existing owner Time Cards surface. Native does not edit approved time or payroll. Optional job alerts are opted in on Today. A notice is informational only and never starts time or accepts an appointment. Device tokens are registered per active membership and revoked on sign-out. Opt-in prefers an Expo push token from `expo-notifications`. The server sends through Expo Push when `EXPO_ACCESS_TOKEN` is set in the TBBT environment (never commit that value). Real-device delivery is **UNVERIFIED** until a physical device is available. Development/scripts still use the fake adapter. No standalone time clock, website wrapper, bundled credentials, or store submission in this slice. Photos reuse private R2 job-photo storage and stay assignment-scoped. Travel and pickup taps reuse the canonical time-card writes and stay distinct from JOB time. Pickup item records reuse the existing purchase list and do not purchase, price, expense, or start time. Visit outcomes reuse the canonical Cleaning visit writes. Every checklist tap is local until **Sync checklist**. Sync reuses `JobCrewVisit.checklistJson` when the Job already has items and does not complete jobs, write time, or send messages. Offline start/stop intents stay on the phone until **Sync time** and never appear as approved server time.

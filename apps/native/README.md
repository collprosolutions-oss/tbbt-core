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
- `eas.json` `preview`: an **internal release-type APK** (`buildType: apk`). Expo SDK 54 release manifests do not honor `usesCleartextTraffic`, so `EXPO_PUBLIC_TBBT_API_URL` must be **https**. The committed value is a placeholder (`https://REPLACE-WITH-REACHABLE-TBBT-ORIGIN.example`). Replace it with a TBBT origin you operate before building. Do not commit a real host or secret.

`app.json` does not enable cleartext HTTP. The emulator loopback rewrite (`localhost` → `10.0.2.2`) is only for Android debug/dev against a host machine; it does not make a release APK accept HTTP.

Sign-out revokes the device token with both a JSON body and `x-tbbt-device-token` so a dropped DELETE body still signs the Android device out.

## Limits

Today + job detail, plus Start job, Complete job, Stop job time, assigned-job travel and material pickup time, purchase-list pickup item recording, Cleaning visit outcome, crew checklist local drafts with explicit sync, assigned-job photo capture/review, and a Time cards screen for the assigned worker's own recorded time. The worker can request a correction and see its recorded status. OWNER accept/decline stays on the existing owner Time Cards surface. Native does not edit approved time or payroll. Optional job alerts are opted in on Today. A notice is informational only and never starts time or accepts an appointment. Device tokens are registered per active membership and revoked on sign-out. This slice does not send real Expo, FCM, or APNs push. No standalone time clock, website wrapper, bundled credentials, or store submission in this slice. Photos reuse private R2 job-photo storage and stay assignment-scoped. Travel and pickup taps reuse the canonical time-card writes and stay distinct from JOB time. Pickup item records reuse the existing purchase list and do not purchase, price, expense, or start time. Visit outcomes reuse the canonical Cleaning visit writes. Every checklist tap is local until **Sync checklist**. Sync reuses `JobCrewVisit.checklistJson` when the Job already has items and does not complete jobs, write time, or send messages. Offline start/stop intents stay on the phone until **Sync time** and never appear as approved server time.

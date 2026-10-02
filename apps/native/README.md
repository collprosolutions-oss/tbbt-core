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

## Limits

Today + job detail, plus Start job, Complete job, Stop job time, assigned-job travel and material pickup time, purchase-list pickup item recording, Cleaning visit outcome, crew checklist local drafts with explicit sync, assigned-job photo capture/review, and a Time cards screen for the assigned worker's own recorded time. The worker can request a correction and see its recorded status. OWNER accept/decline stays on the existing owner Time Cards surface. Native does not edit approved time or payroll. No standalone time clock, website wrapper, bundled credentials, or store submission in this slice. Photos reuse private R2 job-photo storage and stay assignment-scoped. Travel and pickup taps reuse the canonical time-card writes and stay distinct from JOB time. Pickup item records reuse the existing purchase list and do not purchase, price, expense, or start time. Visit outcomes reuse the canonical Cleaning visit writes. Every checklist tap is local until **Sync checklist**. Sync reuses `JobCrewVisit.checklistJson` when the Job already has items and does not complete jobs, write time, or send messages. Offline start/stop intents stay on the phone until **Sync time** and never appear as approved server time.

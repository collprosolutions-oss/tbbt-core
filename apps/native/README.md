# TBBT Field (native)

True React Native / Expo shell for the assigned-job **Today** read flow and explicit **Start job** / **Complete job** actions.

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

Today + job detail, plus Start job, Complete job, and assigned-job photo capture/review for the assigned worker's own job. No standalone time clock, website wrapper, bundled credentials, or store submission in this slice. Photos reuse private R2 job-photo storage and stay assignment-scoped.

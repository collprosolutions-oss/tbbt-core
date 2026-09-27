# Native field app — contract and limits

Isolated subproject: `apps/native`.

This is a true React Native (Expo) shell for one signed-in **assigned-job / Today** read flow. It is not the public website, not the owner/admin Today page, and not a WebView wrapper.

## Session boundary

Web sessions stay on the httpOnly `tbbt_session` cookie (`src/lib/auth.ts`). Native clients cannot safely reuse that cookie transport, and must not copy passwords into the app binary.

The native contract:

1. `POST /api/native/v1/session` verifies email/password (and TOTP when enabled) on the server.
2. The server creates a normal `Session` row and returns the raw token **once**.
3. The app stores only that token in OS secure storage (`expo-secure-store`).
4. Later calls send `Authorization: Bearer <token>`. The server hashes the token and looks up `Session.tokenHash`.
5. Workspace comes from the caller's own active `Membership`. `X-TBBT-Workspace` is accepted only when that membership already exists.

The edge proxy lets `/api/native/` through without a cookie so Bearer auth can run. Missing or invalid tokens still receive 401 from the route.

`POST /api/native/v1/session` rejects bodies over 4 KB and stores password failures on `NativeSignInThrottle` (hashed email, five tries per 10-minute window). Concurrent wrong-password requests increment with a single `INSERT … ON CONFLICT`, so five simultaneous failures for a fresh email count as five. TOTP failures use the same durable `AuthChallenge.failedAttemptCount` as web sign-in. Neither counter is process memory.

## Field scope

`GET /api/native/v1/today`, `GET /api/native/v1/jobs/:jobId`, `POST /api/native/v1/jobs/:jobId/start`, `POST /api/native/v1/jobs/:jobId/complete`, and the assigned-job photo routes under `/api/native/v1/jobs/:jobId/photos` use the same assignment clause as Field Home: `businessId` + `assignedMembershipId` in one query.

Today is also **capped**. `listNativeAssignedJobs()` takes at most `NATIVE_TODAY_JOB_LIMIT` assigned jobs (currently 20), ordered by `scheduledAt` then `id`. If more assigned jobs exist, the payload sets `truncated: true` and `truncatedNotice`. The extra assigned rows are not returned. Cross-tenant and other workers' jobs are never part of that page. Job detail by id is unchanged: one assigned job, or 404.

Returned job data is operational only: status, schedule, customer name/phone, address, access lines, approved-scope descriptions/quantities, whether **Start job** / **Complete job** are available, the caller's running JOB time on that job, and assigned-job photos (captions, stage, and short-lived private preview URLs). It does **not** return invoices, estimate totals, unit prices, wages, customer emails, portal tokens, other members' jobs, or owner Today / management records.

MEMBER access stays field-scoped. OWNER/ADMIN using this API also only see, start, and complete jobs assigned to themselves.

Assigned-worker writes:

- **Start job.** `POST /api/native/v1/jobs/:jobId/start` locks the assigned Job, rechecks `businessId` and `assignedMembershipId` on that locked row (same assignment-change protection as native Complete job), then reuses `startJobWithRunningTimeSafetyInTransaction` — `evaluateStartJob` plus an idempotent RUNNING JOB clock-in. Already-started jobs with running JOB time are a successful no-op. A completed job, a job that is not assigned to the caller, or a job in another business is refused. Unconfirmed appointments are refused with the same Field start gate. If the assignment changes after the authorize read, the former worker is refused and no Job, time, or start-event write happens. If the timesheet week is approved, the transaction rolls back and the Job stays `SCHEDULED` with no new time.
- **Complete job.** `POST /api/native/v1/jobs/:jobId/complete` locks the assigned Job, rechecks `businessId`, `assignedMembershipId`, and status on that locked row (same assignment-change protection as Cleaning `VISIT_COMPLETED`), then reuses `completeJobWithRunningTimeSafetyInTransaction`. It does not send an invoice. Already-completed jobs are a successful no-op. A job that is not `IN_PROGRESS`, not assigned to the caller, or in another business is refused. If the assignment changes after the authorize read, the former worker is refused and no Job, time, or completion-event write happens. If approved timesheet time is still running, the transaction rolls back and the Job stays `IN_PROGRESS`.
- **Job photos.** The assigned worker captures or chooses a photo, reviews it (stage + optional caption), then the app authorizes a private R2 upload, PUTs the bytes to the signed URL, and finalizes a `JobPhoto`. Image bytes never enter the Next.js route. Another worker in the same business, or another business, cannot authorize, finalize, or read the photo. Uploads are capped at `NATIVE_JOB_PHOTO_LIMIT` photos per job (currently 12) and `FIELD_JOB_PHOTO_MAX_BYTES` (12 MB). Oversized files, unsupported types, missing storage, and the count cap return those errors to the Job screen.

After Start job, the app reloads the assigned job and shows the resulting status and running time.

## What this slice does not do

- A standalone time clock, cleaning checklist toggles, or other field mutations
- Owner/admin Today, Reports, invoices, or management console
- App Store / Play distribution, device attestation, or compiled iOS/Android binaries
- Website UI changes
- Cookie fallback on native routes
- Storing passwords or website credentials in the app

## Checks

```bash
npm run test:native-field
npm run test:native-field-photos
npx tsc --noEmit
npm run build
cd apps/native && npx tsc --noEmit && npm run build
```

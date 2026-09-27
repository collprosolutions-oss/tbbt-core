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

`GET /api/native/v1/today` and `GET /api/native/v1/jobs/:jobId` use the same assignment clause as Field Home: `businessId` + `assignedMembershipId` in one query.

Today is also **capped**. `listNativeAssignedJobs()` takes at most `NATIVE_TODAY_JOB_LIMIT` assigned jobs (currently 20), ordered by `scheduledAt` then `id`. If more assigned jobs exist, the payload sets `truncated: true` and `truncatedNotice`. The extra assigned rows are not returned. Cross-tenant and other workers' jobs are never part of that page. Job detail by id is unchanged: one assigned job, or 404.

Returned job data is operational only: status, schedule, customer name/phone, address, access lines, and approved-scope descriptions/quantities. It does **not** return invoices, estimate totals, unit prices, wages, customer emails, portal tokens, other members' jobs, or owner Today / management records.

MEMBER access stays field-scoped. OWNER/ADMIN using this API also only see jobs assigned to themselves.

## What this slice does not do

- Start/complete jobs, photos, time clock, or any field mutation
- Owner/admin Today, Reports, invoices, or management console
- App Store / Play distribution, device attestation, or compiled iOS/Android binaries
- Website UI changes
- Cookie fallback on native routes
- Storing passwords or website credentials in the app

## Checks

```bash
npm run test:native-field
npx tsc --noEmit
npm run build
cd apps/native && npx tsc --noEmit && npm run build
```

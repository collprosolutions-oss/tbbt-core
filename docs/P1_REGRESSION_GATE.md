# P1 regression gate

Aggregation seam for five P1 command contracts. It runs existing
`scripts/check-*.mjs` files. It does not contain the P1 fix tests.
Those land in separate coding PRs. Pending names in
`scripts/p1-gate-config.mjs` are placeholders, not registered scripts.

There is no CI workflow in this repo. Run the domains locally, in
order, one at a time.

## Final gate order

Static checks first, then the DB-backed domains. Run serially:

1. `npm run test:p1-migration-and-db-safety`
2. `npm run test:p1-customer-boundaries`
3. `npm run test:p1-transaction-races`
4. `npm run test:p1-timekeeping`
5. `npm run test:p1-native-active-membership`

Each command is `node scripts/run-p1-gate.mjs <domain>`.

## Environment

- A domain that lists any DB-backed script refuses to start until
  `scripts/lib/local-database-guard.mjs` accepts `DATABASE_URL` and the
  alternate Prisma/libpq variables (`DIRECT_URL`, `POSTGRES_URL`,
  `POSTGRES_PRISMA_URL`, `PGHOST`, `PGHOSTADDR`, `PGSERVICE`). That
  module is the only locality definition. The refusal happens before
  any child process. Those alternate variables are removed from the
  child environment. `TZ` stays set to `America/New_York`.
  `migration-and-db-safety` currently lists only the static migrate
  check, so it does not require `DATABASE_URL`. The guard module
  comes from the database-safety foundation (#235); this gate branch
  includes that foundation so review can run, and #235 should merge
  to main before this PR.
- Node. `package.json` runs `scripts/check-production-migrate.mjs`
  with plain `node`. Every other listed script runs with
  `node --experimental-strip-types`. The gate follows that.
- `TZ=America/New_York` is forced on every child. A DB-backed domain
  also `SET timezone = 'UTC'`, `ALTER ROLE CURRENT_USER SET timezone
  = 'UTC'`, and refuses to start unless a fresh connection reports
  `SHOW timezone` = `UTC`. That pair is Node `TZ=America/New_York`
  AND Postgres session timezone UTC (Postgres default; production).
  The gate fails fast with a clear message if `SHOW timezone` is not
  UTC after that set. Do not treat a UTC-only pass as proof that the
  helpers are session-timezone safe.
- Native sign-in throttle, Saturday same-week approval, and Field
  start proofs were matrix-verified (see below). The older
  line-number list that used to live in this bullet is stale.
  `scripts/check-appointment-confirmation.mjs` "Field start has no
  owner override" (lines 92-95) is a separate stale static assertion
  that already fails on main: it expects
  `CUSTOMER_HAS_NOT_CONFIRMED_APPOINTMENT` in
  `src/app/actions/field-job.ts`, which is no longer there. This PR
  does not touch that check.
- `scripts/check-work-order-portal.mjs`,
  `scripts/check-client-portal-excellence.mjs`, and
  `scripts/check-change-orders.mjs` start `next start`. They need a
  `.next` directory already on disk. If it is missing, that script
  fails with `requires prior next build`. The check only tests that
  the directory exists, so a stale `.next` passes.
  `scripts/check-team-onboarding.mjs` still runs when `.next` is
  missing; the gate prints a warning because that script skips its
  HTTP section.

`npm run build` runs `prisma generate`, then
`scripts/run-production-migrate.mjs` (the production migrate runs only
when `VERCEL_ENV=production`), then the R2 CORS step
(`scripts/apply-r2-browser-upload-cors.mjs`, which always runs), then
`next build`. It must never be a test prerequisite. This gate never
runs `npm run build` or `next build`.

An audit of the existing check scripts found 160 dangerous scripts and
19 with a localhost guard. The gate does not edit those scripts.
`node scripts/run-p1-gate.mjs <domain> --audit` reports the listed set.
`--strict` fails the audit when a listed script is unguarded. Default
audit is a warning report.

Each child times out after 15 minutes (`P1_GATE_CHILD_TIMEOUT_MS` overrides
that). On timeout the gate sends SIGTERM, then SIGKILL if the child is
still running. SIGINT and SIGTERM delivered to the gate are forwarded
to the running child so a killed gate does not leave that child behind.

A missing listed file fails the run. `--allow-missing` is only for
interim wiring. `--fail-fast` stops after the first script failure;
the default is to keep going.

## Registered scripts

Checked on `fc9b8955d52870bc353e98e2347f12a00c6e06b6`. Every file
exists at the name below. Nothing was renamed.

| Domain | Existing scripts, in order |
| --- | --- |
| migration-and-db-safety | `check-production-migrate.mjs` (static, no DB) |
| customer-boundaries | `check-isolation.mjs`, `check-authorization.mjs`, `check-customer-merge.mjs`, `check-customer-csv-import.mjs`, `check-work-order-portal.mjs`, `check-client-portal-excellence.mjs`, `check-customer-messaging.mjs` |
| transaction-races | `check-customer-merge.mjs`, `check-purchase-order-receipts.mjs`, `check-estimate-options.mjs`, `check-job-callback.mjs`, `check-time-cards.mjs`, `check-native-field-pickup.mjs` |
| timekeeping | `check-time-cards.mjs`, `check-time-correction-requests.mjs`, `check-payroll.mjs`, `check-native-field-api.mjs`, `check-native-field-visit.mjs`, `check-native-field-activity.mjs`, `check-native-time-cards.mjs` |
| native-active-membership | `check-native-field-api.mjs`, `check-native-field-checklist.mjs`, `check-native-field-pickup.mjs`, `check-team-onboarding.mjs` |

## What must be added after each coding PR

These files are not in the repo and are not registered. Add them to
the domain `scripts` list only after the coding PR creates them.

### migration-and-db-safety

- `scripts/check-p1-migrate-deploy-empty.mjs` — clean `prisma migrate deploy` from an empty database
- `scripts/check-p1-migrate-diff-drift.mjs` — `prisma migrate diff` drift check
- `scripts/check-p1-db-script-localhost-guard.mjs` — DB-script localhost-guard audit

### customer-boundaries

- `scripts/check-p1-portal-token-scope-expiry.mjs` — portal token scope and expiry
- `scripts/check-p1-cross-customer-access.mjs` — cross-customer access tests

### transaction-races

- `scripts/check-p1-estimate-to-job-conversion.mjs` — estimate-to-job conversion with a real barrier and separate PrismaClients
- `scripts/check-p1-payment-webhook-idempotency.mjs` — payment webhook idempotency
- `scripts/check-p1-invoice-payment-race.mjs` — invoice payment races with real barriers and separate PrismaClients

### timekeeping

- `scripts/check-p1-timekeeping-fixes.mjs` — fixes from the timekeeping PR. Replace this placeholder with the real filenames that PR adds.

### native-active-membership

- `scripts/check-p1-native-deactivate-after-token.mjs` — deactivate-after-token-issue tests across all native write routes

## Timezone matrix (verified beyond UTC-only)

Local disposable Postgres. Role timezone set with
`ALTER ROLE tbbt SET timezone = '…'` and checked with `SHOW timezone`
on a new connection. Cells are Node `TZ` × Postgres session timezone.

Suites: `check-time-cards.mjs`, `check-native-field-api.mjs`,
`check-time-correction-requests.mjs`, `check-payroll.mjs`,
`check-native-field-activity.mjs` (full 4×3).
`check-native-time-cards.mjs` on five representative cells.

### Storage probe

Prisma Client `DateTime` writes of `2026-09-20T02:00:00.000Z` into
`TIMESTAMP(3)` (no time zone) round-trip unchanged under UTC, NY, and
LA sessions (`shiftMs = 0`). The same instant written through
`$queryRaw` `${Date}` shifts by the session offset: `0` under UTC,
`-4h` under `America/New_York`, `-7h` under `America/Los_Angeles`.

### Suite cells (pass/fail counts)

`ok/fail` are `ok  -` / `FAIL -` lines. Exit 0 is a pass.

| Suite | Node TZ | PG session | Result |
| --- | --- | --- | --- |
| time-cards | any of NY, UTC, LA, Auckland | UTC | 229/0 pass |
| time-cards | any of those four | NY or LA | 94/1 fail — `Approval of the Saturday week is refused while the crossing entry remains` |
| native-field-api | any of those four | UTC | 130/0 pass |
| native-field-api | any of those four | NY or LA | 128/2 fail — the two `NativeSignInThrottle` assertions |
| time-correction | all 12 cells | all 12 | 60/0 pass |
| native-field-activity | all 12 cells | all 12 | 49/0 pass |
| native-time-cards | NY×UTC, NY×NY, UTC×NY, LA×NY, Auckland×UTC | | 57/0 pass |
| payroll | NY | UTC, NY, or LA | 60/0 pass |
| payroll | UTC or Auckland | any | exit 1 (throws `There is no time to approve for this week`) |
| payroll | LA | any | 22/1 fail — `Approved TimesheetWeek is included` |

Field start (`Unconfirmed appointment refuses Start job`) passed in
every native-field-api cell. The Saturday/throttle failures depend on
Postgres session timezone, not Node `TZ`.

### LA business / DST (Node `TZ=America/New_York`, business `America/Los_Angeles`)

JS week math is independent of Postgres and Node:

- LA Sat 2026-09-19 22:00–Sun 02:00 crosses the LA Sunday week
  (`2026-09-13T07:00:00.000Z` / `2026-09-20T07:00:00.000Z`).
- 2026-03-08 (spring-forward) 00:00 and 03:30 stay in the Mar 8 week.
- 2026-11-01 (fall-back) 00:00 and 01:30 stay in the Nov 1 week.

Prisma Client persists the LA crossing instants with `shiftMs = 0`
under UTC, NY, and LA sessions. `approveTimesheetWeek` refuses that
Saturday week under Postgres UTC. Under Postgres NY or LA it throws
`There is no time to approve for this week` because
`lockWorkerWeekTimeEntries` `$queryRaw` Date binds miss the row.

### Real application defects (not fixed here)

Production session timezone is UTC, so these do not fire in
production today. They are silent session-tz dependencies.

1. `src/lib/native-session-limits.ts:146-149` — `$queryRaw` INSERT
   binds JS `Date` values into `TIMESTAMP(3)` without time zone
   (`prisma/migrations/20260927200000_native_sign_in_throttle/migration.sql:10-11`).
   A non-UTC session stores session-local wall time. Prisma then
   reads it as UTC.
2. `src/lib/native-session-limits.ts:119` —
   `row.expiresAt <= new Date()` then treats the shifted expiry as
   already past, so five wrong passwords do not lock.
3. `src/lib/time-card-ops.ts:280-281` — `$queryRaw`
   `"startedAt" < ${end} AND ("endedAt" IS NULL OR "endedAt" > ${start})`
   binds week bounds through the same session conversion. Crossing
   Saturday entries are omitted from the lock/load set, so
   `approveTimesheetWeek` can approve (or find no rows) instead of
   refusing `WEEK_BOUNDARY_CROSSING_ERROR`.

Prisma Client writes of the same columns do not shift. Request paths
that pass a business IANA zone into `weekRange` / `startOfWeek` are
Node-TZ safe. `startOfDay` / `startOfWeek` without a timezone
(`src/lib/schedule.ts:56-58` and `:92-95`) fall back to Node local
time; production pages pass a timezone. `check-payroll.mjs:245`
calls `weekRange(new Date())` with no zone — that payroll matrix
failure is a test artifact, not a payroll production bug.


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
- `TZ=America/New_York` is forced on every child. Six known failures
  that depend on that zone are all in `scripts/check-native-field-api.mjs`
  (lines 1285, 1291, 1643, 1649, 2121, and 2127).
  `scripts/check-time-cards.mjs` uses the same approved-week pattern;
  those lines are not confirmed failures.
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

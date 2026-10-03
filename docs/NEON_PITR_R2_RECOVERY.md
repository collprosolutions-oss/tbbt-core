# Operator runbook: Neon PITR + private R2 recovery

This is the **hosted** recovery procedure for CollPro / TBBT. It is
documentation only. This is not the localhost drill from #321
(`docs/DATABASE_RESTORE.md`, `pg_dump` / `pg_restore`). Do not run that
drill against Neon.

This environment inspected live configuration **read-only** on
2026-10-03. It did **not** restore Production, change Neon history
retention, decrypt secrets, `GetObject` private bytes, or copy customer
data.

## Hard bans

| Action | Status |
| --- | --- |
| Instant-restore the Production Neon root in place | Forbidden until a recorded GO decision |
| `PATCH` Neon `history_retention_seconds` / Console Instant restore slider | Forbidden |
| Decrypt or print `DATABASE_URL`, `database_*`, or `R2_*` values | Forbidden |
| `GetObject` / `aws s3 cp` / `aws s3 sync` of customer objects | Forbidden |
| Make the private R2 bucket public (`r2.dev` or custom domain) | Forbidden |
| `prisma migrate deploy` / `db push` / `migrate reset` on Production | Forbidden during verification |
| `pg_dump` / `pg_restore` of the hosted database | Forbidden (that is the #321 localhost drill) |

## What this recovers, and what it does not

Neon Instant Restore (PITR) rewinds **Postgres data and schema** on a
**root** branch to a timestamp or LSN inside the project history window.
[Neon Instant restore](https://neon.com/docs/introduction/branch-restore)
overwrites every database on that branch. It does **not** rewind
Cloudflare R2. Neon Object Storage is not used here; TBBT private files
are `StoredAsset` metadata in Postgres plus object bytes in R2.

R2 has **no S3 object versioning** (`GetBucketVersioning` is unsupported).
A deleted private object cannot be time-traveled. Private recovery is
HeadObject existence + size against the restored ledger, or a separately
maintained replica that already exists. This runbook never creates that
replica and never copies bytes.

Preview and Production share the same Neon store (see below). An
in-place restore of the Production root also interrupts Preview.

---

## 1. Inspected configuration (2026-10-03)

Values below are identifiers and presence flags only. Secret values were
not decrypted.

### Neon (Vercel Marketplace)

| Field | Observed |
| --- | --- |
| Vercel store | `store_2ie8U4PWbJ5J3agg` (`collpro-reno-db`) |
| External resource | `empty-cherry-05140338` |
| Region | `iad1` |
| Billing plan | `free_v3` (Free), status `available` / `active` |
| Neon Auth | `false` |
| Integration | `icfg_QhIkqD8Ezq1RrC5FuGn3I7Bp` / `oac_3sK3gnG06emjIEVL09jjntDD` |
| Integration scopes | `read-write:marketplace`, `read:integration-configuration`, `read-write:integration-resource` |
| Connected Vercel project | `prj_7xmTwilZyg0plUHRzHgvboCusHLp` (`collpro-reno`) |
| Store environments | `production`, `preview` |
| Env-var prefix | `database` (`database_POSTGRES_URL`, `database_NEON_PROJECT_ID`, …) |
| App connection | `DATABASE_URL` is a **separate** sensitive Production+Preview var (not the `database_` prefix) |
| `database_NEON_PROJECT_ID` | Present, secret, length 21 — value not read |
| Founder read-only probe | `TBBT_FOUNDER_PRODUCTION_READONLY_DATABASE_URL` and `TBBT_FOUNDER_PRODUCTION_READONLY_CONFIRM` are **absent** on `collpro-reno` |

On the Free plan, anything older than **6 hours** or beyond the **1 GB**
history cap is **unrecoverable**. Do not lengthen retention to reach it.
Free also caps the project at **10 branches** and **1 manual snapshot**.
This agent could not `GET /projects/{id}` to confirm
`history_retention_seconds`.

`scripts/production-migrate-policy.mjs` still treats the unused
`workspace` Vercel project (`prj_93RU249o7PH0npog4XAuKAFZN0hd`) as
sharing Production `DATABASE_URL`. A listing of that project's env vars
returned empty in this session — do not assume it is disconnected
without a human check.

### Private R2 (Vercel env presence only)

These keys exist on `collpro-reno` for **production and preview**, all
`sensitive` / `decrypted: false`:

`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`R2_ENDPOINT`, `R2_BUCKET_NAME`.

Not present: `R2_REGION` (app default `auto`), `STORAGE_PUBLIC_BASE_URL`,
`STORAGE_DEFAULT_LIMIT_BYTES` (app default 5 GB).

Object keys are `businesses/{businessId}/{folder}/{uuid}.{ext}` from
`src/lib/business-storage/keys.ts`. Private bytes are served only after
`authorizePrivateStoredAssetDownload` (2-minute presigned GET). The
provider HeadObjects to confirm finalize; it never lists the bucket.

### Local migration ledger (repo, not Production)

Provider lock is PostgreSQL (`prisma/migrations/migration_lock.toml`).
The local side of the comparison is every
`prisma/migrations/<name>/migration.sql` directory, via
`listLocalMigrationNames` / `listLocalMigrationChecksums` in
`scripts/production-migrate-policy.mjs`. Recompute that list at verify
time. A count or newest-folder name written here will go stale.
Production applied rows were **not** read.

---

## 2. Missing permissions (this environment)

Do not invent access. Grant only what the next dry-run step needs.

| Need | Exact permission / credential | Observed failure |
| --- | --- | --- |
| Read Neon `history_retention_seconds`, branches, LSN | Neon API key with **project read** + **branch read**, or Console member on `empty-cherry-05140338`. APIs: `GET /projects/{project_id}`, `GET /projects/{project_id}/branches` | No `NEON_API_KEY`. `database_NEON_PROJECT_ID` not decrypted. No Neon MCP. |
| Time Travel connection string | Same Neon key, plus `neon connection-string <root>@<timestamp>` | Same. Time Travel is read-only and is the preferred dry-run. |
| Create an isolated restore branch | Neon **create branch** (`POST /projects/{project_id}/branches` with parent timestamp). Console: Branches → create from timestamp. | Not held. Do not use Instant restore on the Production root as a substitute. |
| Instant-restore Production root | `POST /projects/{project_id}/branches/{branch_id}/restore` | Must stay unused until GO. |
| Change history window | Neon project update / Console **Settings → Instant restore** | Must stay unused. |
| Read-only Production SQL | `TBBT_FOUNDER_PRODUCTION_READONLY_DATABASE_URL` **and** `TBBT_FOUNDER_PRODUCTION_READONLY_CONFIRM=confirm-readonly` (see `src/lib/founder-production-preflight.ts`) | Both unset on Vercel. Do not reuse live `DATABASE_URL` from this agent. |
| List / Head private R2 | Cloudflare API token **Account.Workers R2 Storage:Read** (and Account Settings Read if wrangler needs it), **or** an R2 S3 token limited to `s3:ListBucket` + `s3:GetObject` (Head). Cloudflare-bindings MCP must be authenticated. | MCP status `needsAuth`. No `CLOUDFLARE_API_TOKEN`. `R2_*` values not decrypted. |
| Team-scoped Vercel Storage API | Re-auth to Vercel scope `collpro-s-projects5` (`team_ShkiO7CkDXd00dYWYGW4Is3N`) | `get_project` / `filter_project_envs` with `teamId` returned 403 `Not authorized: Trying to access resource under scope "collpro-s-projects5"`. Project-name lookup without `teamId` succeeded. |
| GitHub MCP | Working GitHub MCP connection | Live discovery failed. `gh` CLI worked read-only. |

A dry-run operator token for R2 must **not** include `s3:PutObject`,
`s3:DeleteObject`, `s3:PutBucketVersioning`, or bucket-public ACL
changes.

---

## 3. Restore order

Do this order. Reversing it creates dangling `storageKey` rows or
orphaned objects.

1. **Record** incident time `T` as RFC 3339 UTC (and LSN if Neon shows one).
2. **Confirm** the Free history window still covers `T`. On Free,
   anything older than 6 hours / 1 GB is unrecoverable. Do not lengthen
   retention.
3. **Require Neon CLI 4.9.0+** with
   `node scripts/require-neon-cli.mjs` before any `neon` command.
   `--no-secrets` needs 4.9.0. A bare `neon --version` is not the gate.
   If the CLI is missing or older, upgrade first and retry; stop
   otherwise. Every pasteable block below aborts when the script exits
   non-zero.
4. **Discover `$ROOT_BRANCH`**: the project's default root from
   `neon branches list --output json` (`.default == true`). Do not
   assume the name `production`.
5. **Time Travel Assist** (read-only) at `T` on `$ROOT_BRANCH`.
   Pick the exact moment. Do not restore.
6. **Create an isolated Neon branch** with `--parent "$T"` (or keep
   using Time Travel if the checks fit in the ephemeral endpoint).
   Confirm that branch's `parent_timestamp` equals `T` before any
   verification SQL. Do **not** `neon branches restore` `$ROOT_BRANCH`.
7. **Migration-ledger** verification on that isolated connection
   (`planProductionMigrateDeploy`). No `migrate deploy`.
8. **Tenant-isolation** SQL on that same connection.
9. **File-reference** SQL, then **HeadObject** (never GetObject) each
   READY PRIVATE `storageKey` in the live private bucket.
10. **Rollback decision** (GO / NO-GO). Stop on NO-GO. Delete the
    isolated branch. Leave Production Neon and R2 untouched.
11. **GO only:** Instant-restore `$ROOT_BRANCH` with
    `--preserve-under-name`, then keep the live R2 bucket (objects are
    not time-traveled). Missing private objects stay missing unless a
    replica already exists.

Never restore R2 first. The database `StoredAsset` row is the ownership
source of truth (`prisma/schema.prisma`: bytes live in object storage;
the row owns visibility and quota).

---

## 4. Dry-run procedure (access missing or present)

Use this in **this** environment and in any later operator session that
still lacks write rights. It is the substitute for a live restore.

### 4.1 Always (no extra credentials)

1. Confirm this document and `docs/DATABASE_RESTORE.md` are different
   procedures. The localhost script refuses Neon hosts.
2. Confirm local ledger: `npm run test:production-migrate`.
3. Confirm isolation contract still exists: `npm run test:isolation`
   (localhost DB). That is not a Production restore.
4. Record `T`, the Vercel store id, and that Free-plan data older than
   6 hours / 1 GB is unrecoverable.

### 4.2 When Neon read is granted

Run `node scripts/require-neon-cli.mjs` **before** any `neon` command.
`--no-secrets` needs Neon CLI **4.9.0** or newer. The script fail-closes
on a missing binary, a non-zero `neon --version`, unreadable stdout, or
a version older than 4.9.0 (including `4.9.0` pre-releases such as
`4.9.0-beta.1`). A single anchored stdout line such as `v4.9.0` or
`neon 4.10.0` is accepted when the numeric version meets the floor.
Banner lines, stderr, and path-prefixed strings are not versions. If
the CLI is missing or older: **upgrade first, then retry. Stop
otherwise.** Do not continue to `neon branches create` / `restore`.

Every pasteable block starts with the guard and aborts the shell when
it fails (`return` inside a function, `exit` otherwise):

```bash
node scripts/require-neon-cli.mjs || return 1 2>/dev/null || exit 1
```

```bash
node scripts/require-neon-cli.mjs || return 1 2>/dev/null || exit 1
[ -n "${PROJECT//[[:space:]]/}" ] || { echo 'PROJECT must be set' >&2; return 1 2>/dev/null || exit 1; }
# Replace PROJECT with the decrypted database_NEON_PROJECT_ID or the
# Console id for empty-cherry-05140338. Do not paste secrets into git.
# Table output omits history_retention_seconds — use JSON.
neon projects get "$PROJECT" --output json
# Read .project.history_retention_seconds (or .history_retention_seconds).
# Free max is 21600 seconds. Do not PATCH it. If T is older than that
# window or the 1 GB cap, stop: it is unrecoverable.

neon branches list --project-id "$PROJECT" --output json
ROOT_BRANCH=$(neon branches list --project-id "$PROJECT" --output json \
  | jq -r '[.[] | select(.default == true) | .name] | unique | .[]')
[ -n "${ROOT_BRANCH//[[:space:]]/}" ] || { echo 'ROOT_BRANCH must be the project default root' >&2; return 1 2>/dev/null || exit 1; }
case "$ROOT_BRANCH" in *$'\n'*) echo 'ROOT_BRANCH must be a single default root' >&2; return 1 2>/dev/null || exit 1 ;; esac
DEFAULT_BRANCH="$ROOT_BRANCH"
# Exactly one default root. Do not assume the name production.
# --parent "$T" forks that default root at T. If ROOT_BRANCH is empty
# or more than one line, stop and do not guess.
```

Time Travel in the Neon Console SQL Editor on `$ROOT_BRANCH` at `T` is
read-only and prints no connection URI. Prefer that.

A bare `neon connection-string` always prints the role password
(`--no-secrets` is not documented on that command). Do **not** wrap
that command in `$(…)` / command substitution — that puts the password
on the next argv and in shell history.

Time Travel against the default root (only after `$ROOT_BRANCH` is set).
An omitted or empty branch argument means Neon’s **default** root —
never run `connection-string` without a non-empty branch:

```bash
node scripts/require-neon-cli.mjs || return 1 2>/dev/null || exit 1
[ -n "${PROJECT//[[:space:]]/}" ] || { echo 'PROJECT must be set' >&2; return 1 2>/dev/null || exit 1; }
[ -n "${ROOT_BRANCH//[[:space:]]/}" ] || { echo 'ROOT_BRANCH must be the project default root' >&2; return 1 2>/dev/null || exit 1; }
case "$ROOT_BRANCH" in *$'\n'*) echo 'ROOT_BRANCH must be a single default root' >&2; return 1 2>/dev/null || exit 1 ;; esac
[ -n "${T//[[:space:]]/}" ] || { echo 'T must be the incident timestamp' >&2; return 1 2>/dev/null || exit 1; }
neon connection-string "${ROOT_BRANCH}@${T}" --project-id "$PROJECT" --psql
```

Time Travel rejects writes. Run the SQL in sections 5–7 against that
connection. If checks need more than 30s, create a **child** branch
from the timestamp instead of restoring the root.

`--parent` takes a branch name, id, RFC 3339 timestamp, or LSN
([Neon CLI branches](https://neon.com/docs/cli/branches)). A timestamp
parent is an instant-restore branch from the default root at `T`.
There is no `--timestamp` flag. Do not pass a branch name plus a
separate timestamp option — an ignored unknown flag would fork HEAD.

`--no-secrets` omits connection credentials from command output
(documented on `neon projects create`, CLI 4.9.0+). Pass it on create
so `connection_uris` are not printed.

Define and validate `VERIFY_NAME` **before** any command that uses it.
It must be non-empty, not equal to `$ROOT_BRANCH`, and must not be the
project default. An empty `connection-string` branch argument targets
the default root.

```bash
node scripts/require-neon-cli.mjs || return 1 2>/dev/null || exit 1
[ -n "${PROJECT//[[:space:]]/}" ] || { echo 'PROJECT must be set' >&2; return 1 2>/dev/null || exit 1; }
[ -n "${ROOT_BRANCH//[[:space:]]/}" ] || { echo 'ROOT_BRANCH must be the project default root' >&2; return 1 2>/dev/null || exit 1; }
case "$ROOT_BRANCH" in *$'\n'*) echo 'ROOT_BRANCH must be a single default root' >&2; return 1 2>/dev/null || exit 1 ;; esac
[ -n "${DEFAULT_BRANCH//[[:space:]]/}" ] || { echo 'DEFAULT_BRANCH must be the project default' >&2; return 1 2>/dev/null || exit 1; }
[ -n "${T//[[:space:]]/}" ] || { echo 'T must be the incident timestamp' >&2; return 1 2>/dev/null || exit 1; }
VERIFY_NAME="tbbt-pitr-verify-$(date -u +%Y%m%dT%H%M%SZ)"
[ -n "${VERIFY_NAME//[[:space:]]/}" ] || { echo 'VERIFY_NAME must be the isolated verify branch' >&2; return 1 2>/dev/null || exit 1; }
[ "$VERIFY_NAME" != "$ROOT_BRANCH" ] || { echo 'VERIFY_NAME must not equal ROOT_BRANCH' >&2; return 1 2>/dev/null || exit 1; }
[ "$VERIFY_NAME" != "$DEFAULT_BRANCH" ] || { echo 'VERIFY_NAME must not equal the default branch' >&2; return 1 2>/dev/null || exit 1; }
neon branches create \
  --name "$VERIFY_NAME" \
  --project-id "$PROJECT" \
  --parent "$T" \
  --no-secrets
```

Before any verification SQL, confirm the branch was cut at `T`, not
HEAD, and is **not** the default root. Table output for `branches get`
does not show `parent_timestamp` — use JSON, and print only those
fields (create JSON can include passwords):

```bash
node scripts/require-neon-cli.mjs || return 1 2>/dev/null || exit 1
[ -n "${PROJECT//[[:space:]]/}" ] || { echo 'PROJECT must be set' >&2; return 1 2>/dev/null || exit 1; }
[ -n "${ROOT_BRANCH//[[:space:]]/}" ] || { echo 'ROOT_BRANCH must be the project default root' >&2; return 1 2>/dev/null || exit 1; }
case "$ROOT_BRANCH" in *$'\n'*) echo 'ROOT_BRANCH must be a single default root' >&2; return 1 2>/dev/null || exit 1 ;; esac
[ -n "${DEFAULT_BRANCH//[[:space:]]/}" ] || { echo 'DEFAULT_BRANCH must be the project default' >&2; return 1 2>/dev/null || exit 1; }
[ -n "${VERIFY_NAME//[[:space:]]/}" ] || { echo 'VERIFY_NAME must be the isolated verify branch' >&2; return 1 2>/dev/null || exit 1; }
[ "$VERIFY_NAME" != "$ROOT_BRANCH" ] || { echo 'VERIFY_NAME must not equal ROOT_BRANCH' >&2; return 1 2>/dev/null || exit 1; }
[ "$VERIFY_NAME" != "$DEFAULT_BRANCH" ] || { echo 'VERIFY_NAME must not equal the default branch' >&2; return 1 2>/dev/null || exit 1; }
neon branches get "$VERIFY_NAME" --project-id "$PROJECT" --output json \
  | jq '{id, name, parent_id, parent_timestamp, parent_lsn, default}'
```

`parent_timestamp` must equal `T` (same RFC 3339 instant). `default`
must be false. If either check fails, delete the branch and stop. Do
not verify against the wrong state.

To open the **verify** branch without printing secrets into history or
logs, let the CLI start psql (no `$(…)` wrap, no `set -x`, no paste
into tickets). Only after `VERIFY_NAME` is set and validated:

```bash
node scripts/require-neon-cli.mjs || return 1 2>/dev/null || exit 1
[ -n "${PROJECT//[[:space:]]/}" ] || { echo 'PROJECT must be set' >&2; return 1 2>/dev/null || exit 1; }
[ -n "${ROOT_BRANCH//[[:space:]]/}" ] || { echo 'ROOT_BRANCH must be the project default root' >&2; return 1 2>/dev/null || exit 1; }
case "$ROOT_BRANCH" in *$'\n'*) echo 'ROOT_BRANCH must be a single default root' >&2; return 1 2>/dev/null || exit 1 ;; esac
[ -n "${DEFAULT_BRANCH//[[:space:]]/}" ] || { echo 'DEFAULT_BRANCH must be the project default' >&2; return 1 2>/dev/null || exit 1; }
[ -n "${VERIFY_NAME//[[:space:]]/}" ] || { echo 'VERIFY_NAME must be the isolated verify branch' >&2; return 1 2>/dev/null || exit 1; }
[ "$VERIFY_NAME" != "$ROOT_BRANCH" ] || { echo 'VERIFY_NAME must not equal ROOT_BRANCH' >&2; return 1 2>/dev/null || exit 1; }
[ "$VERIFY_NAME" != "$DEFAULT_BRANCH" ] || { echo 'VERIFY_NAME must not equal the default branch' >&2; return 1 2>/dev/null || exit 1; }
neon connection-string "$VERIFY_NAME" --project-id "$PROJECT" --psql
```

Connect to **that** branch only. Drop it after the decision. Creating
this branch is copy-on-write; it is not an in-place Production restore.

Do **not** Instant-restore the default root here. The only pasteable
restore is section 8 after a recorded GO:

```bash
node scripts/require-neon-cli.mjs || return 1 2>/dev/null || exit 1
# FORBIDDEN until GO — overwrites the default root ($ROOT_BRANCH).
# Discover the real default first; do not hard-code the name production.
echo "Forbidden until a recorded GO. Stop." >&2
exit 1
```

### 4.3 When founder read-only Postgres is granted

Set both env vars on the **operator machine**, not in Vercel Production:

- `TBBT_FOUNDER_PRODUCTION_READONLY_DATABASE_URL` → the Time Travel or
  isolated-branch URL (never the live read-write `DATABASE_URL` if a
  time-travel URL exists).
- `TBBT_FOUNDER_PRODUCTION_READONLY_CONFIRM=confirm-readonly`

Then:

```bash
npm run preflight:founder
```

The probe opens only the explicit URL, `SET TRANSACTION READ ONLY`, and
reads `_prisma_migrations`. It does not migrate or repair.

### 4.4 When R2 Head is granted

Use a read-only token. Head only. Compare `ContentLength` to
`StoredAsset.fileSizeBytes`. Do not download.

```bash
# KEY comes from the isolated-branch SQL in section 7. One key at a time.
aws s3api head-object \
  --endpoint-url "$R2_ENDPOINT" \
  --region auto \
  --bucket "$R2_BUCKET_NAME" \
  --key "$KEY"
```

A 404 is a missing object (NO-GO unless a replica is already documented).
A matching size is a pass for that key. Stop after metadata.

---

## 5. Migration-ledger verification

Policy: `scripts/production-migrate-policy.mjs` →
`planProductionMigrateDeploy`. The Production runner
(`scripts/run-production-migrate.mjs`) uses the same SELECT and fails
closed on missing history, missing local names, or checksum mismatch.
Do not use `prisma migrate status` (it takes advisory lock `72707369`).

On the Time Travel / isolated-branch connection, read-only:

```sql
SET TRANSACTION READ ONLY;

SELECT "migration_name", "checksum", "finished_at", "rolled_back_at"
FROM "_prisma_migrations"
ORDER BY "finished_at" NULLS FIRST, "migration_name";
```

Also:

```sql
SELECT COUNT(*)::int AS user_tables
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_type = 'BASE TABLE'
  AND table_name <> '_prisma_migrations';
```

Compare to the **current** local folders from `listLocalMigrationNames`
/ `listLocalMigrationChecksums` (recompute from
`prisma/migrations/*/migration.sql` at verify time). Decision:

| Ledger at `T` | Meaning | Action |
| --- | --- | --- |
| Query error, table missing, `user_tables > 0` | Fail closed | NO-GO |
| Applied name missing locally | Divergent history | NO-GO |
| Applied checksum ≠ sha256 of `migration.sql` | Edited applied migration | NO-GO |
| Unfinished row (`finished_at` null, `rolled_back_at` null) | Interrupted migrate | NO-GO until understood |
| Applied names are a **prefix** of the current local folder list | Expected for an older `T` | Do not migrate during verify. Cut over only with an app SHA that matches that prefix, **or** migrate the isolated branch after GO — never Production during verify |
| Applied set equals the current local folder list, checksums match | Current schema at `T` | Continue isolation + file checks |
| `_prisma_migrations` missing and `user_tables = 0` | Empty database | NO-GO for tenant recovery |

Do not run `prisma migrate deploy` to "fix" a historical ledger during
this drill. Preview builds already skip migrate because they share
Production `DATABASE_URL`.

---

## 6. Tenant-isolation checks

Run on the same read-only connection. Every business-owned row must
carry `businessId`. Server code scopes with
`businessScope(workspace.business.id)` from `src/lib/access.ts`.
`StoredAsset.storageKey` must stay under
`businesses/{businessId}/` (`assertKeyBelongsToBusiness`).

```sql
SET TRANSACTION READ ONLY;

-- Cross-tenant graph breaks (must return 0 rows each)
SELECT c.id
FROM "Customer" c
JOIN "Property" p ON p."customerId" = c.id
WHERE c."businessId" <> p."businessId";

SELECT r.id
FROM "ServiceRequest" r
WHERE r."customerId" IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM "Customer" c
  WHERE c.id = r."customerId" AND c."businessId" = r."businessId"
);

SELECT e.id
FROM "Estimate" e
WHERE e."customerId" IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM "Customer" c
  WHERE c.id = e."customerId" AND c."businessId" = e."businessId"
);

SELECT j.id
FROM "Job" j
WHERE j."estimateId" IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM "Estimate" e
  WHERE e.id = j."estimateId" AND e."businessId" = j."businessId"
);

SELECT t.id
FROM "TimeEntry" t
WHERE t."jobId" IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM "Job" j
  WHERE j.id = t."jobId" AND j."businessId" = t."businessId"
);

SELECT i.id
FROM "Invoice" i
WHERE i."jobId" IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM "Job" j
  WHERE j.id = i."jobId" AND j."businessId" = i."businessId"
);

SELECT p.id
FROM "Payment" p
WHERE p."invoiceId" IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM "Invoice" i
  WHERE i.id = p."invoiceId" AND i."businessId" = p."businessId"
);

SELECT m.id
FROM "Membership" m
WHERE NOT EXISTS (
  SELECT 1 FROM "Business" b WHERE b.id = m."businessId"
);

-- StoredAsset namespace must match owning business
SELECT id, "businessId", "storageKey"
FROM "StoredAsset"
WHERE "storageKey" NOT LIKE 'businesses/' || "businessId" || '/%'
   OR "storageKey" LIKE '%..%'
   OR "storageKey" LIKE '%//%';

-- Pointer tables must not attach another tenant's file
SELECT jp.id
FROM "JobPhoto" jp
JOIN "StoredAsset" a ON a.id = jp."storedAssetId"
WHERE jp."storedAssetId" IS NOT NULL
  AND jp."businessId" <> a."businessId";

SELECT srp.id
FROM "ServiceRequestPhoto" srp
JOIN "StoredAsset" a ON a.id = srp."storedAssetId"
WHERE srp."businessId" <> a."businessId";

SELECT e.id
FROM "Expense" e
JOIN "StoredAsset" a ON a.id = e."receiptStoredAssetId"
WHERE e."receiptStoredAssetId" IS NOT NULL
  AND e."businessId" <> a."businessId";
```

Any row is NO-GO. Also sample two real businesses (if more than one
exists): a customer id from A must not appear on B. Public tokens
(`Estimate.publicToken`, `Job.projectToken`) stay on their original
`businessId`.

Money on a restored invoice is recomputed, not trusted as a stored
remaining-due column: `invoicePaymentBreakdown` is
total − recorded payments − recorded credits
(`src/lib/project-payments.ts`). Credits are not payments.

---

## 7. File-reference checks + private R2

### 7.1 Database pointers (read-only)

READY PRIVATE assets are the recovery set. PENDING may have no bytes.
FAILED / DELETED must not block.

```sql
SET TRANSACTION READ ONLY;

SELECT a.id, a."businessId", a."storageKey", a."fileSizeBytes",
       a.visibility, a.status, a.category
FROM "StoredAsset" a
WHERE a.status = 'READY'
  AND a.visibility = 'PRIVATE'
ORDER BY a."businessId", a.id;

-- Dangling pointers (asset missing)
SELECT 'JobPhoto' AS src, jp.id
FROM "JobPhoto" jp
WHERE jp."storedAssetId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "StoredAsset" a WHERE a.id = jp."storedAssetId")
UNION ALL
SELECT 'ServiceRequestPhoto', srp.id
FROM "ServiceRequestPhoto" srp
WHERE srp."storedAssetId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "StoredAsset" a WHERE a.id = srp."storedAssetId")
UNION ALL
SELECT 'Expense', e.id
FROM "Expense" e
WHERE e."receiptStoredAssetId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "StoredAsset" a WHERE a.id = e."receiptStoredAssetId")
UNION ALL
SELECT 'BusinessVaultRecord', v.id
FROM "BusinessVaultRecord" v
WHERE v."storedAssetId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "StoredAsset" a WHERE a.id = v."storedAssetId")
UNION ALL
SELECT 'ProjectDocumentReview', r.id
FROM "ProjectDocumentReview" r
WHERE NOT EXISTS (SELECT 1 FROM "StoredAsset" a WHERE a.id = r."storedAssetId")
UNION ALL
SELECT 'JobCallbackAttachment', c.id
FROM "JobCallbackAttachment" c
WHERE NOT EXISTS (SELECT 1 FROM "StoredAsset" a WHERE a.id = c."storedAssetId");
```

Legacy `JobPhoto.url` rows with a Vercel Blob URL and null
`storedAssetId` are **out of R2 scope**. Public website images
(`PublicSiteImage`, `WebsiteGalleryItem`, `visibility = PUBLIC`) are
not this private-recovery set.

### 7.2 HeadObject against live R2

For each READY PRIVATE `storageKey` from 7.1:

1. Confirm the key starts with `businesses/{that row's businessId}/`.
2. `HeadObject` in the configured private bucket.
3. Require `ContentLength === fileSizeBytes`.
4. Do not `GetObject`.

Mismatch after restoring Postgres to `T` while leaving live R2:

| Case | Result |
| --- | --- |
| Object existed at `T` and still exists | Pass |
| Object uploaded after `T` | Orphan in R2, absent from restored DB — acceptable |
| Object deleted after `T` | Restored row, 404 on HeadObject — **cannot** version-restore. NO-GO unless a replica already holds that key |
| Object overwritten after `T` | Size/etag may differ. R2 has no prior version. Treat as missing-for-`T` |

There is no `ListObjectVersions` recovery path on R2.

### 7.3 R2 versioning and lifecycle (operator console)

R2 does **not** support S3 object versioning (`GetBucketVersioning` is
unsupported). This runbook does not enable versioning, edit lifecycle
rules, or copy objects.

Before treating HeadObject 404s as "maybe recoverable later," the
operator with Cloudflare **Account.Workers R2 Storage:Read** must open
the bucket Settings and record:

1. Versioning is unavailable / off (expected).
2. Whether any **object lifecycle** rule expires or deletes keys under
   `businesses/`.

If a lifecycle rule already removed objects that existed at `T`, those
bytes are gone. This environment did not authenticate Cloudflare, so
that console check was **not performed** here.

---

## 8. Rollback decision

Record the decision before anyone touches the Production root.

### GO — all of these

- `T` is inside the observed history window. On Free, anything older
  than 6 hours / 1 GB is unrecoverable.
- Verification used Time Travel or an isolated child branch whose
  `parent_timestamp` equals `T` — Production root was not overwritten.
- `_prisma_migrations` readable; no missing-local names; no checksum
  mismatch; no unfinished row you do not understand.
- Isolation SQL returned zero cross-tenant rows.
- Every READY PRIVATE `storageKey` HeadObject-matched, **or** each miss
  is written down and accepted by the owner (legacy Blob or known
  pre-R2 gap).
- A `--preserve-under-name` backup name is chosen
  (`${ROOT_BRANCH}_old_<utc>`). Do not hard-code the branch name
  `production`.
- Neon CLI is 4.9.0 or newer (`node scripts/require-neon-cli.mjs`).
  If older or missing: upgrade first, stop otherwise.
- Preview owners know the shared `DATABASE_URL` will drop connections.

### NO-GO — any of these

- Neon CLI is missing, unreadable, or older than 4.9.0 (needed for
  `--no-secrets`). Upgrade first; stop otherwise.
- `$ROOT_BRANCH` was not discovered from `.default == true` (empty or
  more than one default). Do not guess `production`.
- `T` is outside the window (unrecoverable on Free; do not extend
  retention to reach it).
- Isolated verify branch `parent_timestamp` does not equal `T`.
- Free branch cap (10) blocks an isolated verify branch and Time Travel
  is unavailable.
- Ledger fail-closed reasons in section 5.
- Any cross-tenant row in section 6.
- READY PRIVATE HeadObject 404 / size mismatch with no existing replica.
- The only way forward would be GetObject, a public bucket, or copying
  customer data into this agent.
- Someone already restored Production in place without
  `preserve_under_name`.

### On NO-GO

1. Stop.
2. Delete the isolated verify branch if you created one.
3. Leave Production Neon, Preview, `DATABASE_URL`, and R2 unchanged.
4. File the missing permission from section 2 if the dry-run could not
   finish.

### On GO (human cutover — not performed here)

1. Instant-restore the Production **root** from `T` with a mandatory
   backup name:

   ```bash
   node scripts/require-neon-cli.mjs || return 1 2>/dev/null || exit 1
   [ -n "${PROJECT//[[:space:]]/}" ] || { echo 'PROJECT must be set' >&2; return 1 2>/dev/null || exit 1; }
   [ -n "${ROOT_BRANCH//[[:space:]]/}" ] || { echo 'ROOT_BRANCH must be the project default root' >&2; return 1 2>/dev/null || exit 1; }
   case "$ROOT_BRANCH" in *$'\n'*) echo 'ROOT_BRANCH must be a single default root' >&2; return 1 2>/dev/null || exit 1 ;; esac
   [ -n "${T//[[:space:]]/}" ] || { echo 'T must be the incident timestamp' >&2; return 1 2>/dev/null || exit 1; }
   # $ROOT_BRANCH is the project's real default (section 4.2), not a
   # hard-coded production name.
   neon branches restore "$ROOT_BRANCH" "^self@${T}" \
     --preserve-under-name "${ROOT_BRANCH}_old_${T}" \
     --project-id "$PROJECT"
   ```

2. Expect connection blips. Connection strings stay the same.
3. Re-run sections 5–7 against Production (read-only) immediately.
4. Do not migrate until the ledger says pending and isolation still
   holds. Only `collpro-reno` Production may run
   `prisma migrate deploy`.
5. R2 stays the live bucket. Do not overwrite it.
6. If the restore is wrong, Instant-restore **from**
   `${ROOT_BRANCH}_old_${T}` back onto `$ROOT_BRANCH`. Do not delete
   that backup while it has children. R2 needs no rollback because it
   was not rewritten.

---

## 9. Why this is not PR #321

| #321 localhost drill | This runbook |
| --- | --- |
| Disposable `tbbt_handy_restore_*` Postgres | Neon `empty-cherry-05140338` / store `store_2ie8U4PWbJ5J3agg` |
| `pg_dump` / `pg_restore` | Time Travel + optional isolated branch; Instant restore only on GO |
| `MemoryStorageProvider` bytes | HeadObject on private R2; no byte copy |
| Proves metadata survives a dump | Operator procedure for hosted PITR + file-pointer checks |
| Refuses Neon hosts | Never dumps the hosted database |

---

## Related

- Localhost drill: `docs/DATABASE_RESTORE.md`,
  `npm run test:handyman-database-restore`
- Ledger policy: `scripts/production-migrate-policy.mjs`,
  `npm run test:production-migrate`
- Neon CLI 4.9.0+ gate: `scripts/require-neon-cli.mjs`,
  `scripts/lib/neon-cli-version.mjs`
- Founder read-only probe: `scripts/founder-production-preflight-db.mjs`
- Isolation harness: `npm run test:isolation`
- Neon Instant restore: https://neon.com/docs/introduction/branch-restore
- Neon history window: https://neon.com/docs/introduction/history-window
- Neon Time Travel: https://neon.com/docs/guides/time-travel-assist

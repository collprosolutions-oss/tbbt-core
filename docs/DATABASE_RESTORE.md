# Local Handyman database restore

This is a **localhost drill**. It proves that a current-schema Handyman
business graph survives `pg_dump` → `pg_restore` on disposable Postgres.

It does **not** connect to Production. It does **not** dump Production.
A database restore recreates rows and file **metadata**. It **does not
recreate R2 bytes**.

Run the proof:

```bash
# DATABASE_URL must be localhost / 127.0.0.1 / ::1 Postgres.
npm run test:handyman-database-restore
```

The script creates two disposable databases, seeds a Handyman tenant,
dumps only the source disposable database, restores into the empty
target, checks tenant links / money totals / `StoredAsset` references,
then drops both databases.

## What the drill seeds

On the source disposable database, with fake in-process private storage
(`MemoryStorageProvider`, not Cloudflare R2):

- Handyman `Business` + `BusinessTrade`
- customer, property, request
- estimate + labor line, job, time card (`TimeEntry`)
- invoice + labor line, payment, invoice credit
- private job-photo `StoredAsset` metadata and a `JobPhoto` pointer
- a second tenant with its own customer (isolation check)

Expected money after restore:

| Field | Value |
| --- | --- |
| Invoice total | `400.00` |
| Recorded payment | `250.00` |
| Recorded credit | `50.00` |
| Remaining due | `100.00` |

Remaining due is `invoicePaymentBreakdown` (total − payments − credits).
Credits are not payments.

## Exact local recovery steps

These are the steps the proof script runs. They are safe only against
**disposable localhost** databases that the local-database guard accepts.

1. Confirm `DATABASE_URL` is local Postgres. Remote hosts, Neon-style
   hosts, `host` / `hostaddr` / `service` query overrides, and
   `PGHOST` / `DIRECT_URL` pointing off-box are refused.
2. Create an empty source database and apply the current Prisma schema
   (`prisma db push` on that disposable name only).
3. Seed the Handyman graph above. Put private-file **bytes** only in
   fake in-process storage. The database stores `storageKey`,
   `fileSizeBytes`, visibility, and the `JobPhoto.storedAssetId`.
4. Dump **that disposable database only**:

   ```bash
   pg_dump --dbname "$SOURCE_URL" --format=custom --compress=0 --no-owner --no-acl \
     --file /tmp/handyman-source.dump
   ```

5. Create a second empty disposable database. Do not `db push` it.
6. Restore the dump into the empty target:

   ```bash
   pg_restore --dbname "$TARGET_URL" --no-owner --no-acl \
     --exit-on-error /tmp/handyman-source.dump
   ```

7. Read the restored tenant. Check:
   - every seeded row still has the same `businessId`
   - customer → property → request → estimate → job → invoice
   - time card still points at the same job and membership
   - invoice total / payment / credit / remaining due
   - `StoredAsset.storageKey` and `JobPhoto.storedAssetId`
   - the other tenant’s customer is still on the other `businessId`
8. Drop both disposable databases and the dump file.

Helpers: `scripts/lib/local-postgres-backup.mjs`. They call
`assertSafeLocalDatabaseEnvironment` before `pg_dump` / `pg_restore`,
refuse any URL fragment (WHATWG-local URLs such as
`postgresql://127.0.0.1:54321#@evil.invalid:5999/x` are not safe for
libpq), and refuse any database name that does not start with
`tbbt_handy_restore_`. They cannot dump or restore the shared
localhost `tbbt` database.

## Missing dependencies after a database restore

A successful Postgres restore is **not** a full business recovery.

| Dependency | Restored by this dump? | Notes |
| --- | --- | --- |
| Tenant rows and foreign keys | Yes | Proven by the drill. |
| Invoice / payment / credit amounts | Yes | Remaining due is recomputed from restored rows. |
| `StoredAsset` metadata and `storageKey` | Yes | Pointers only. |
| Fake in-process private-storage bytes | No | Bytes live only in the process `MemoryStorageProvider`. The drill converts the custom dump to uncompressed dump SQL (`pg_restore -f -`) and scans that text. A positive control first writes the same sentinel into a `JobPhoto.caption` and shows that scan **fails** (the sentinel is present). The real dump, where the sentinel exists only as in-memory file bytes, does not contain it. After restore the **same** fake store still holds the original bytes — storage is process-local and separate from Postgres. A brand-new empty memory map is not the proof. |
| Cloudflare R2 object bytes | **No** | Database restore does not recreate R2 bytes. Restore the bucket (or copy objects) separately. |
| Production `DATABASE_URL` / hosted Postgres | Out of scope | This repo’s restore helpers refuse non-local hosts. |
| `R2_*`, Stripe, Resend, Twilio secrets | No | Live in the host environment, not the dump. |
| Session cookies / hashed session tokens | Rows only | Browsers still hold cookies; users may need to sign in again. |
| Legacy Vercel Blob URLs on old `JobPhoto.url` | URL string only | Bytes stay in that provider, if they still exist. |
| In-memory fake payment / messaging adapters | No | Process-local. Production must not set those fake adapters. |

## What this is not

- Not a Production backup tool.
- Not a license to `pg_dump` the CollPro hosted database from this
  environment.
- Not proof that field photos, request photos, vault documents, or
  website images will render after a database-only restore. They need
  the matching objects in R2 (or another configured bucket).
- Not a `prisma migrate deploy` against Production.

Hosted-database recovery, if it is ever needed, is a provider backup
restore performed **outside** this script, plus a separate object-storage
restore, plus the real environment variables. Do not substitute this
localhost drill for that work.

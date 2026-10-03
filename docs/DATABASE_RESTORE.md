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

## Private file-byte restore (disposable storage fixture)

This is the **file-byte half**. It proves that restored `StoredAsset`
references resolve to the expected private-file bytes in a **separate
disposable filesystem fixture**. It does **not** replace the
database-only drill above. Never read or write production R2.

```bash
# DATABASE_URL must be localhost / 127.0.0.1 / ::1 Postgres.
# R2_* is scrubbed for the process. The fixture is not Cloudflare R2.
npm run test:handyman-storage-restore
```

The script creates two disposable databases and two disposable
filesystem fixtures under `$TMPDIR/tbbt_handy_restore_storage_*`:

1. Confirm `DATABASE_URL` is local Postgres (same guard as the
   database-only drill).
2. Unset `R2_*` so no managed R2 client can be constructed.
3. Create an empty source database and a disposable filesystem
   fixture. Seed a Handyman tenant, a private job photo, a second
   private object, and another tenant’s private object. Bytes go only
   into the fixture. Object files are stored under a digest of
   `(bucket, key)` so a directory listing does not reveal storage keys.
4. Snapshot the fixture by copying it. Dump the source disposable
   database. Then delete the source fixture so recovery cannot
   accidentally read the original directory.
5. Restore the dump into a second empty disposable database.
6. Restore the snapshot into a second empty disposable fixture.
7. Resolve each restored `StoredAsset` against the restored fixture.
   Reports use opaque labels only (`object-1:ok`). Storage keys,
   filenames, emails, phone numbers, and customer names are not logged.
8. Negative cases:
   - empty fixture → `object-1:missing object-2:missing`
   - same key, different-length bytes → `object-1:mismatch object-2:ok`
   - same-length one-byte flip on a restored private object →
     `object-1:mismatch object-2:ok` (size matches `fileSizeBytes`;
     only the sha256 comparison catches it)
   - same-length swapped content between two restored objects →
     `object-1:mismatch object-2:mismatch`
   - one object removed → `object-1:ok object-2:missing`
9. Drop both databases and delete every fixture directory.

Expected bytes come from script constants, not from Postgres.
`StoredAsset` stores `storageKey`, `fileSizeBytes`, and visibility. It
has **no checksum column**. This drill does not add one. After restore,
the classifier hashes fixture bytes and compares them to those
constants. A same-length one-byte flip would pass a size-only check.

Helpers: `scripts/lib/local-storage-restore.mjs`. They refuse any
fixture path that is not under the process temp directory with the
`tbbt_handy_restore_storage_` prefix, refuse any bucket that is not
`tbbt-restore-drill-*`, and refuse to open a fixture while `R2_*` is
set.

| Dependency | Restored by this drill? | Notes |
| --- | --- | --- |
| Tenant rows and `StoredAsset` pointers | Yes | Same localhost `pg_dump` / `pg_restore` as the database-only drill. |
| Disposable filesystem fixture bytes | Yes | Copied separately. Proven by resolving restored references. |
| Missing or mismatched fixture objects | Reported | Status only (`missing` / `mismatch`). No keys or customer data. |
| Cloudflare R2 object bytes | **No** | Never read or write production R2. Restore a real bucket separately. |

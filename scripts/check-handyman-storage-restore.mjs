/**
 * Local-only proof that private file bytes can be recovered after
 * database restore, using a separate disposable storage fixture.
 *
 * Leaves the database-only drill intact. This is the file-byte half:
 * restored StoredAsset references must resolve to the expected bytes
 * in a copied filesystem fixture. Missing or mismatched objects are
 * reported. Logs never include storage keys or customer data.
 *
 * This script never connects to Production, never dumps Production,
 * and never reads or writes Cloudflare R2.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-handyman-storage-restore.mjs
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import {
  RemoteDatabaseRefusedError,
  assertLocalDatabaseUrl,
  openDisposableTestDatabase,
} from "./disposable-test-database.mjs";
import {
  HANDYMAN_RESTORE_DATABASE_PREFIX,
  RestoreDatabaseNameRefusedError,
  dumpLocalDatabase,
  dumpPlainSqlContains,
  libpqUrlForLocalBackup,
  restoreLocalDatabase,
} from "./lib/local-postgres-backup.mjs";
import {
  FAKE_RESTORE_BUCKET,
  HANDYMAN_RESTORE_STORAGE_PREFIX,
  ProductionR2RefusedError,
  RestoreStorageBucketRefusedError,
  RestoreStoragePathRefusedError,
  assertDisposableStorageRoot,
  assertProductionR2EnvScrubbed,
  assertRestoreDrillBucket,
  classifyRestoredObject,
  containsSensitiveRestoreLog,
  copyDisposableStorageFixture,
  countFixtureObjects,
  expectedBytesMeta,
  flipOneByte,
  formatRestoreReport,
  openDisposableStorageFixture,
  redactRestoreLog,
  refuseProductionR2Provider,
  resolveRestoredPrivateObjects,
  scrubProductionR2Env,
} from "./lib/local-storage-restore.mjs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

process.env.TZ = process.env.TZ || "America/New_York";
process.env.TBBT_PAYMENTS_ADAPTER = "fake";
process.env.TBBT_SAAS_BILLING_ADAPTER = "fake";
process.env.TBBT_CUSTOMER_MESSAGING_ADAPTER = "fake";

const PHOTO_SENTINEL = "TBBT_RESTORE_DRILL_PRIVATE_FILE_BYTES_RECOVERED_IN_FIXTURE";
const NOTE_SENTINEL = "TBBT_RESTORE_DRILL_SECOND_PRIVATE_OBJECT_BYTES";

let passed = 0;
let failed = 0;
let leakedLogs = 0;

const rawLog = console.log.bind(console);
const rawError = console.error.bind(console);

function guardedWrite(write, args) {
  const line = args
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
    .join(" ");
  if (containsSensitiveRestoreLog(line)) {
    leakedLogs += 1;
    write("FAIL - a log line contained a storage key or customer data");
    write(redactRestoreLog(line));
    return;
  }
  write(redactRestoreLog(line));
}

console.log = (...args) => guardedWrite(rawLog, args);
console.error = (...args) => guardedWrite(rawError, args);

function check(label, ok) {
  if (containsSensitiveRestoreLog(label)) {
    leakedLogs += 1;
    failed += 1;
    rawError("FAIL - check label contained a storage key or customer data");
    return false;
  }
  if (ok) {
    passed += 1;
    console.log(`  ok  - ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL - ${label}`);
  }
  return ok;
}

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: {
      role,
      business: { id: businessId, name: "Restore Drill Handyman" },
      membership: { id: membershipId },
    },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
    assertAttachable(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

function toReference(objectRef, bucket, asset, body) {
  return {
    objectRef,
    bucket,
    storageKey: asset.storageKey,
    ...expectedBytesMeta(body),
  };
}

console.log("\nSTATIC — file-byte restore drill; disposable fixture only, not production R2");
const selfSrc = readRepo("scripts/check-handyman-storage-restore.mjs");
const helperSrc = readRepo("scripts/lib/local-storage-restore.mjs");
const dbDrillSrc = readRepo("scripts/check-handyman-database-restore.mjs");
const backupSrc = readRepo("scripts/lib/local-postgres-backup.mjs");
const docsSrc = readRepo("docs/DATABASE_RESTORE.md");

check(
  "Database-only drill is still present and still metadata-only",
  dbDrillSrc.includes("never connects to or dumps Production") &&
    dbDrillSrc.includes("not recreate object-storage bytes") &&
    dbDrillSrc.includes("MemoryStorageProvider") &&
    dbDrillSrc.includes("Same fake store still holds the original bytes"),
);
check(
  "This drill uses the disposable DB harness, dump/restore helpers, and the filesystem fixture",
  selfSrc.includes('from "./disposable-test-database.mjs"') &&
    selfSrc.includes("openDisposableTestDatabase") &&
    selfSrc.includes('from "./lib/local-postgres-backup.mjs"') &&
    selfSrc.includes("dumpLocalDatabase") &&
    selfSrc.includes("restoreLocalDatabase") &&
    selfSrc.includes('from "./lib/local-storage-restore.mjs"') &&
    selfSrc.includes("openDisposableStorageFixture") &&
    selfSrc.includes("copyDisposableStorageFixture") &&
    selfSrc.includes("resolveRestoredPrivateObjects"),
);
check(
  "Helpers never import or construct an R2 client",
  !helperSrc.includes("@aws-sdk") &&
    !helperSrc.includes("cloudflarestorage") &&
    helperSrc.includes("Never reads or writes production R2") &&
    helperSrc.includes("scrubProductionR2Env") &&
    helperSrc.includes("HANDYMAN_RESTORE_STORAGE_PREFIX"),
);
check(
  "Classifier compares sha256 after size so a same-length flip cannot pass",
  helperSrc.includes("digestBytes(actual) !== expectedSha256") &&
    helperSrc.includes("export function flipOneByte") &&
    helperSrc.indexOf("actual.byteLength !== expectedSizeBytes") <
      helperSrc.indexOf("digestBytes(actual) !== expectedSha256"),
);
check(
  "Reports are opaque object refs and logs are redacted",
  helperSrc.includes("formatRestoreReport") &&
    helperSrc.includes("redactRestoreLog") &&
    helperSrc.includes("[storage-key]") &&
    helperSrc.includes("[customer]") &&
    helperSrc.includes("assertRestoreReportSafe") &&
    selfSrc.includes("containsSensitiveRestoreLog") &&
    selfSrc.includes("leakedLogs"),
);
check(
  "Recovery notes keep the database-only drill and document the file-byte half",
  docsSrc.includes("npm run test:handyman-database-restore") &&
    docsSrc.includes("npm run test:handyman-storage-restore") &&
    docsSrc.includes("does not recreate R2 bytes") &&
    docsSrc.includes("disposable filesystem fixture") &&
    docsSrc.includes("missing") &&
    docsSrc.includes("mismatch") &&
    docsSrc.includes("Never read or write production R2") &&
    docsSrc.includes("no checksum column") &&
    docsSrc.includes("same-length one-byte flip") &&
    !docsSrc.includes("pg_dump Production"),
);
check(
  "Dump helpers still refuse remote hosts and non-prefixed database names",
  backupSrc.includes("assertSafeLocalDatabaseEnvironment") &&
    backupSrc.includes("HANDYMAN_RESTORE_DATABASE_PREFIX") &&
    backupSrc.includes("Never dump Production"),
);

{
  let dumpReached = false;
  let restoreReached = false;
  const remote = "postgresql://user:secret@db.example.com:5432/production";
  try {
    dumpLocalDatabase({ databaseUrl: remote, outputPath: "/tmp/should-not-write.dump" });
    dumpReached = true;
  } catch (error) {
    check(
      "pg_dump helper throws RemoteDatabaseRefusedError for a remote host",
      error instanceof RemoteDatabaseRefusedError && /pg_dump/.test(error.message),
    );
  }
  try {
    restoreLocalDatabase({ databaseUrl: remote, inputPath: "/tmp/should-not-exist.dump" });
    restoreReached = true;
  } catch (error) {
    check(
      "pg_restore helper throws RemoteDatabaseRefusedError for a remote host",
      error instanceof RemoteDatabaseRefusedError && /pg_restore/.test(error.message),
    );
  }
  check("Remote dump/restore never start a Postgres client tool", dumpReached === false && restoreReached === false);
}

{
  const unprefixed = "postgresql://tbbt:tbbt@127.0.0.1:5432/tbbt";
  let dumpUnprefixed = false;
  try {
    dumpLocalDatabase({ databaseUrl: unprefixed, outputPath: "/tmp/should-not-dump-tbbt.dump" });
    dumpUnprefixed = true;
  } catch (error) {
    check(
      "dump still refuses a localhost DB whose name is not tbbt_handy_restore_",
      error instanceof RestoreDatabaseNameRefusedError &&
        error.databaseName === "tbbt" &&
        error.message.includes(HANDYMAN_RESTORE_DATABASE_PREFIX),
    );
  }
  check("Shared localhost database is not dumped by the file-byte drill", dumpUnprefixed === false);
}

{
  const hashBypass = "postgresql://127.0.0.1:54321#@evil.invalid:5999/x";
  try {
    libpqUrlForLocalBackup(hashBypass, "pg_dump");
    check("hash-fragment URL is refused before any storage work", false);
  } catch (error) {
    check(
      "hash-fragment URL is refused without naming the remote host",
      error instanceof RemoteDatabaseRefusedError &&
        /fragment/i.test(error.message) &&
        !String(error.message).includes("evil.invalid"),
    );
  }
}

{
  try {
    assertRestoreDrillBucket("collpro-production-photos", "open fixture");
    check("production-looking bucket names are refused", false);
  } catch (error) {
    check(
      "production-looking bucket names are refused",
      error instanceof RestoreStorageBucketRefusedError &&
        !String(error.message).includes("collpro-production-photos"),
    );
  }
  try {
    assertDisposableStorageRoot(join(tmpdir(), "evil"), "open fixture");
    check("storage roots outside the disposable prefix are refused", false);
  } catch (error) {
    check(
      "storage roots outside the disposable prefix are refused",
      error instanceof RestoreStoragePathRefusedError &&
        String(error.message).includes(HANDYMAN_RESTORE_STORAGE_PREFIX),
    );
  }
}

{
  const sample = "path businesses/biz_abc/jobs/photo.jpg for Restore Drill Customer <owner@example.com> at 5550100";
  const redacted = redactRestoreLog(sample);
  check(
    "Redaction strips storage keys, emails, customer name, and phone",
    redacted.includes("[storage-key]") &&
      redacted.includes("[email]") &&
      redacted.includes("[customer]") &&
      redacted.includes("[phone]") &&
      !containsSensitiveRestoreLog(redacted) &&
      !redacted.includes("biz_abc") &&
      !redacted.includes("example.com"),
  );
}

{
  const expected = expectedBytesMeta(Buffer.from("expected-bytes"));
  check(
    "Classifier reports missing when the object is absent",
    classifyRestoredObject({ ...expected, object: null }) === "missing",
  );
  check(
    "Classifier reports mismatch when the bytes differ",
    classifyRestoredObject({ ...expected, object: { body: Buffer.from("other-bytes") } }) === "mismatch",
  );
  check(
    "Classifier reports ok when the digest and size match",
    classifyRestoredObject({ ...expected, object: { body: Buffer.from("expected-bytes") } }) === "ok",
  );
}

{
  const reports = [
    { objectRef: "object-1", status: "ok" },
    { objectRef: "object-2", status: "missing" },
    { objectRef: "object-3", status: "mismatch" },
  ];
  check(
    "Formatted report is opaque refs and statuses only",
    formatRestoreReport(reports) === "object-1:ok object-2:missing object-3:mismatch" &&
      !containsSensitiveRestoreLog(JSON.stringify(reports)),
  );
}

{
  try {
    refuseProductionR2Provider("handyman storage-restore drill");
    check("refuseProductionR2Provider throws", false);
  } catch (error) {
    check(
      "refuseProductionR2Provider throws ProductionR2RefusedError without credentials",
      error instanceof ProductionR2RefusedError &&
        !/R2_SECRET|accessKey|cloudflarestorage/i.test(error.message),
    );
  }
}

process.env.R2_ACCOUNT_ID = "should-never-be-used";
process.env.R2_ACCESS_KEY_ID = "should-never-be-used";
process.env.R2_SECRET_ACCESS_KEY = "should-never-be-used";
process.env.R2_BUCKET_NAME = "production-looking-bucket";
process.env.R2_ENDPOINT = "https://example.invalid";
try {
  openDisposableStorageFixture({ nameSuffix: "blocked" });
  check("fixture open is refused while R2 env is present", false);
} catch (error) {
  check(
    "fixture open is refused while R2 env is present",
    error instanceof ProductionR2RefusedError &&
      !/should-never-be-used|production-looking-bucket|cloudflarestorage/i.test(error.message),
  );
}
scrubProductionR2Env();
try {
  assertProductionR2EnvScrubbed("handyman storage-restore drill");
  check("R2 environment is unset before any storage work", true);
} catch {
  check("R2 environment is unset before any storage work", false);
}

function padToLength(body, size, fill) {
  if (body.byteLength === size) return Buffer.from(body);
  const out = Buffer.alloc(size, fill);
  body.copy(out);
  return out;
}

const photoBody = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xd9]), Buffer.from(PHOTO_SENTINEL)]);
const noteBody = padToLength(Buffer.from(NOTE_SENTINEL), photoBody.byteLength, 0x5c);
const otherBody = Buffer.from("TBBT_RESTORE_DRILL_OTHER_TENANT_PRIVATE_BYTES");
if (photoBody.byteLength !== noteBody.byteLength || photoBody.equals(noteBody)) {
  throw new Error("photo and note fixtures must be same-length distinct bytes for the digest proof.");
}

{
  const expectedPhoto = expectedBytesMeta(photoBody);
  const flippedPhoto = flipOneByte(photoBody, photoBody.byteLength - 1);
  check(
    "Classifier reports mismatch for a same-length one-byte flip",
    flippedPhoto.byteLength === photoBody.byteLength &&
      !flippedPhoto.equals(photoBody) &&
      classifyRestoredObject({ ...expectedPhoto, object: { body: flippedPhoto } }) === "mismatch",
  );
  check(
    "Classifier reports mismatch when two same-length objects have swapped content",
    classifyRestoredObject({ ...expectedPhoto, object: { body: noteBody } }) === "mismatch" &&
      classifyRestoredObject({ ...expectedBytesMeta(noteBody), object: { body: photoBody } }) === "mismatch",
  );
}

{
  const isolated = openDisposableStorageFixture({ nameSuffix: "unit" });
  try {
    await isolated.provider.putObject({
      bucket: FAKE_RESTORE_BUCKET,
      key: "businesses/unit/jobs/demo.jpg",
      body: photoBody,
      contentType: "image/jpeg",
    });
    const copy = copyDisposableStorageFixture(isolated.rootDir, { nameSuffix: "unitcopy" });
    try {
      isolated.cleanup();
      const got = await copy.provider.getObject({
        bucket: FAKE_RESTORE_BUCKET,
        key: "businesses/unit/jobs/demo.jpg",
      });
      const missingFixture = openDisposableStorageFixture({ nameSuffix: "empty" });
      try {
        const refs = [
          {
            objectRef: "object-1",
            bucket: FAKE_RESTORE_BUCKET,
            storageKey: "businesses/unit/jobs/demo.jpg",
            ...expectedBytesMeta(photoBody),
          },
        ];
        const recovered = await resolveRestoredPrivateObjects(refs, (loc) => copy.provider.getObject(loc));
        const missing = await resolveRestoredPrivateObjects(refs, (loc) => missingFixture.provider.getObject(loc));
        await copy.provider.putObject({
          bucket: FAKE_RESTORE_BUCKET,
          key: "businesses/unit/jobs/demo.jpg",
          body: Buffer.from("wrong"),
          contentType: "image/jpeg",
        });
        const mismatched = await resolveRestoredPrivateObjects(refs, (loc) => copy.provider.getObject(loc));
        const flipped = flipOneByte(photoBody, 0);
        await copy.provider.putObject({
          bucket: FAKE_RESTORE_BUCKET,
          key: "businesses/unit/jobs/demo.jpg",
          body: flipped,
          contentType: "image/jpeg",
        });
        const flippedIsolated = await resolveRestoredPrivateObjects(refs, (loc) => copy.provider.getObject(loc));
        check(
          "Isolated fixture copy recovers expected bytes after the source directory is removed",
          recovered[0]?.status === "ok" &&
            got?.body &&
            Buffer.from(got.body).equals(photoBody) &&
            countFixtureObjects(copy.rootDir) === 1,
        );
        check("Isolated empty fixture reports missing", missing[0]?.status === "missing");
        check("Isolated mutated fixture reports mismatch", mismatched[0]?.status === "mismatch");
        check(
          "Isolated same-length one-byte flip reports mismatch",
          flipped.byteLength === photoBody.byteLength && flippedIsolated[0]?.status === "mismatch",
        );
      } finally {
        missingFixture.cleanup();
      }
    } finally {
      copy.cleanup();
    }
  } finally {
    try {
      isolated.cleanup();
    } catch {
      /* already removed */
    }
  }
}

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to a localhost Postgres URL.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "handyman storage-restore disposable database");

const dumpDir = mkdtempSync(join(tmpdir(), "tbbt-handyman-storage-restore-"));
const dumpPath = join(dumpDir, "handyman-source.dump");

let source = null;
let target = null;
let sourceStore = null;
let snapshotStore = null;
let restoredStore = null;
let emptyStore = null;
let mutatedStore = null;
let flippedStore = null;
let swappedStore = null;
let missingOneStore = null;

try {
  sourceStore = openDisposableStorageFixture({ nameSuffix: "src" });
  source = await openDisposableTestDatabase({
    databaseUrl: baseUrl,
    namePrefix: "tbbt_handy_restore_ssrc",
    setProcessEnv: true,
  });

  const { readManagedStorageConfig, isBusinessStorageConfigured } = await import(
    "@/lib/business-storage/config"
  );
  const { ensureBusinessStorageAccount, putBusinessObject } = await import(
    "@/lib/business-storage/service"
  );
  const { privateAssetPath } = await import("@/lib/business-storage/keys");

  check(
    "Managed R2 config is absent after scrub so resolveStorageProvider cannot fall through",
    readManagedStorageConfig() === null && isBusinessStorageConfigured() === false,
  );

  const prisma = source.prisma;
  const provider = sourceStore.provider;
  const deps = { db: prisma, provider, bucketName: FAKE_RESTORE_BUCKET };

  const ownerUser = await prisma.user.create({
    data: {
      name: "Restore Drill Owner",
      email: `restore.owner.${randomUUID().slice(0, 8)}@example.com`,
      passwordHash: "x",
    },
  });
  const business = await prisma.business.create({
    data: {
      name: "Restore Drill Handyman",
      slug: `restore-drill-handyman-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
    },
  });
  await prisma.businessTrade.create({
    data: { businessId: business.id, tradeCode: "HANDYMAN", status: "ACTIVE" },
  });
  const membership = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: business.id, role: "OWNER", hourlyWage: 45 },
  });
  const otherBusiness = await prisma.business.create({
    data: {
      name: "Other Tenant",
      slug: `other-tenant-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
    },
  });
  const otherUser = await prisma.user.create({
    data: {
      name: "Other Tenant Owner",
      email: `other.owner.${randomUUID().slice(0, 8)}@example.com`,
      passwordHash: "x",
    },
  });
  const otherMembership = await prisma.membership.create({
    data: { userId: otherUser.id, businessId: otherBusiness.id, role: "OWNER" },
  });
  const customer = await prisma.customer.create({
    data: {
      businessId: business.id,
      name: "Restore Drill Customer",
      email: "restore.customer@example.com",
      phone: "5550100",
    },
  });
  const property = await prisma.property.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      label: "Shop",
      addressLine1: "12 Restore Way",
      city: "Reno",
      region: "NV",
      postalCode: "89501",
    },
  });
  const job = await prisma.job.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      propertyId: property.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });

  const owner = makeAccess(business.id, "OWNER", membership.id);
  const otherOwner = makeAccess(otherBusiness.id, "OWNER", otherMembership.id);
  await ensureBusinessStorageAccount(prisma, business.id, {
    bucketName: FAKE_RESTORE_BUCKET,
    defaultLimitBytes: 5_000_000,
  });
  await ensureBusinessStorageAccount(prisma, otherBusiness.id, {
    bucketName: FAKE_RESTORE_BUCKET,
    defaultLimitBytes: 5_000_000,
  });

  const photo = await putBusinessObject(deps, owner, {
    category: "JOB_PHOTO",
    purpose: "job-private",
    originalFilename: "after.jpg",
    mimeType: "image/jpeg",
    body: photoBody,
    visibility: "PRIVATE",
  });
  const note = await putBusinessObject(deps, owner, {
    category: "DOCUMENT",
    purpose: "job-private",
    originalFilename: "note.txt",
    mimeType: "text/plain",
    body: noteBody,
    visibility: "PRIVATE",
  });
  const otherFile = await putBusinessObject(
    { db: prisma, provider, bucketName: FAKE_RESTORE_BUCKET },
    otherOwner,
    {
      category: "JOB_PHOTO",
      purpose: "job-private",
      originalFilename: "other.jpg",
      mimeType: "image/jpeg",
      body: otherBody,
      visibility: "PRIVATE",
    },
  );
  await prisma.storedAsset.update({
    where: { id: photo.id },
    data: { jobId: job.id, customerId: customer.id },
  });
  await prisma.storedAsset.update({
    where: { id: note.id },
    data: { jobId: job.id, customerId: customer.id },
  });
  await prisma.jobPhoto.create({
    data: {
      businessId: business.id,
      jobId: job.id,
      stage: "AFTER",
      url: privateAssetPath(photo.id),
      storedAssetId: photo.id,
      caption: "Private after photo metadata",
    },
  });

  const sourceRefs = [
    toReference("object-1", FAKE_RESTORE_BUCKET, photo, photoBody),
    toReference("object-2", FAKE_RESTORE_BUCKET, note, noteBody),
  ];

  console.log("\nSOURCE — private bytes live only in the disposable filesystem fixture");
  check(
    "Source fixture holds three private objects and no R2 config",
    countFixtureObjects(sourceStore.rootDir) === 3 && isBusinessStorageConfigured() === false,
  );
  const sourceResolved = await resolveRestoredPrivateObjects(sourceRefs, (loc) =>
    provider.getObject(loc),
  );
  check(
    "Source references resolve to expected bytes before dump",
    formatRestoreReport(sourceResolved) === "object-1:ok object-2:ok",
  );

  snapshotStore = copyDisposableStorageFixture(sourceStore.rootDir, { nameSuffix: "snap" });
  dumpLocalDatabase({ databaseUrl: source.testUrl, outputPath: dumpPath });
  check(
    "Database dump contains file metadata pointers but not the private-file sentinels",
    dumpPlainSqlContains(dumpPath, photo.storageKey) &&
      !dumpPlainSqlContains(dumpPath, PHOTO_SENTINEL) &&
      !dumpPlainSqlContains(dumpPath, NOTE_SENTINEL),
  );

  sourceStore.cleanup();
  sourceStore = null;
  check(
    "Source fixture was removed after the snapshot; recovery must use the copy",
    countFixtureObjects(snapshotStore.rootDir) === 3,
  );

  target = await openDisposableTestDatabase({
    databaseUrl: baseUrl,
    namePrefix: "tbbt_handy_restore_stgt",
    pushSchema: false,
  });
  restoreLocalDatabase({ databaseUrl: target.testUrl, inputPath: dumpPath });
  const restored = target.createClient();
  restoredStore = copyDisposableStorageFixture(snapshotStore.rootDir, { nameSuffix: "tgt" });
  snapshotStore.cleanup();
  snapshotStore = null;

  console.log("\nRESTORE — second disposable database + second disposable storage fixture");
  const restoredPhoto = await restored.storedAsset.findFirstOrThrow({
    where: { id: photo.id, businessId: business.id, visibility: "PRIVATE" },
  });
  const restoredNote = await restored.storedAsset.findFirstOrThrow({
    where: { id: note.id, businessId: business.id, visibility: "PRIVATE" },
  });
  const restoredOther = await restored.storedAsset.findFirstOrThrow({
    where: { id: otherFile.id, businessId: otherBusiness.id },
  });
  const restoredJobPhoto = await restored.jobPhoto.findFirstOrThrow({
    where: { businessId: business.id, storedAssetId: photo.id },
  });

  const restoredRefs = [
    toReference("object-1", FAKE_RESTORE_BUCKET, restoredPhoto, photoBody),
    toReference("object-2", FAKE_RESTORE_BUCKET, restoredNote, noteBody),
  ];
  const restoredOtherRef = toReference("object-other", FAKE_RESTORE_BUCKET, restoredOther, otherBody);

  const recovered = await resolveRestoredPrivateObjects(restoredRefs, (loc) =>
    restoredStore.provider.getObject(loc),
  );
  const recoveredOther = await resolveRestoredPrivateObjects([restoredOtherRef], (loc) =>
    restoredStore.provider.getObject(loc),
  );
  const recoveredPhoto = await restoredStore.provider.getObject({
    bucket: FAKE_RESTORE_BUCKET,
    key: restoredPhoto.storageKey,
  });
  const recoveredNote = await restoredStore.provider.getObject({
    bucket: FAKE_RESTORE_BUCKET,
    key: restoredNote.storageKey,
  });

  check(
    "Restored JobPhoto still points at the same private StoredAsset",
    restoredJobPhoto.storedAssetId === photo.id &&
      restoredPhoto.fileSizeBytes === photoBody.byteLength &&
      restoredNote.fileSizeBytes === noteBody.byteLength,
  );
  check(
    "Restored database references resolve to the expected fixture bytes",
    formatRestoreReport(recovered) === "object-1:ok object-2:ok" &&
      recoveredPhoto?.body &&
      recoveredNote?.body &&
      Buffer.from(recoveredPhoto.body).equals(photoBody) &&
      Buffer.from(recoveredNote.body).equals(noteBody),
  );
  check(
    "Other-tenant private object restores on its own reference and is not required for the primary report",
    formatRestoreReport(recoveredOther) === "object-other:ok" &&
      formatRestoreReport(recovered) === "object-1:ok object-2:ok",
  );

  emptyStore = openDisposableStorageFixture({ nameSuffix: "empty" });
  const missingAll = await resolveRestoredPrivateObjects(restoredRefs, (loc) =>
    emptyStore.provider.getObject(loc),
  );
  check(
    "Empty fixture reports missing for every restored reference",
    formatRestoreReport(missingAll) === "object-1:missing object-2:missing",
  );

  mutatedStore = copyDisposableStorageFixture(restoredStore.rootDir, { nameSuffix: "mut" });
  await mutatedStore.provider.putObject({
    bucket: FAKE_RESTORE_BUCKET,
    key: restoredPhoto.storageKey,
    body: Buffer.from("wrong-private-bytes"),
    contentType: "image/jpeg",
  });
  const mismatched = await resolveRestoredPrivateObjects(restoredRefs, (loc) =>
    mutatedStore.provider.getObject(loc),
  );
  check(
    "Mutated fixture reports mismatch for the changed object and ok for the untouched object",
    formatRestoreReport(mismatched) === "object-1:mismatch object-2:ok",
  );

  flippedStore = copyDisposableStorageFixture(restoredStore.rootDir, { nameSuffix: "flip" });
  const flippedRestored = flipOneByte(photoBody, photoBody.byteLength - 1);
  await flippedStore.provider.putObject({
    bucket: FAKE_RESTORE_BUCKET,
    key: restoredPhoto.storageKey,
    body: flippedRestored,
    contentType: "image/jpeg",
  });
  const flippedReport = await resolveRestoredPrivateObjects(restoredRefs, (loc) =>
    flippedStore.provider.getObject(loc),
  );
  check(
    "Same-length one-byte flip on a restored private object is mismatch",
    flippedRestored.byteLength === photoBody.byteLength &&
      restoredPhoto.fileSizeBytes === flippedRestored.byteLength &&
      formatRestoreReport(flippedReport) === "object-1:mismatch object-2:ok",
  );

  swappedStore = copyDisposableStorageFixture(restoredStore.rootDir, { nameSuffix: "swap" });
  await swappedStore.provider.putObject({
    bucket: FAKE_RESTORE_BUCKET,
    key: restoredPhoto.storageKey,
    body: noteBody,
    contentType: "image/jpeg",
  });
  await swappedStore.provider.putObject({
    bucket: FAKE_RESTORE_BUCKET,
    key: restoredNote.storageKey,
    body: photoBody,
    contentType: "text/plain",
  });
  const swappedReport = await resolveRestoredPrivateObjects(restoredRefs, (loc) =>
    swappedStore.provider.getObject(loc),
  );
  check(
    "Same-length swapped content between two restored objects is mismatch for both",
    photoBody.byteLength === noteBody.byteLength &&
      restoredPhoto.fileSizeBytes === restoredNote.fileSizeBytes &&
      formatRestoreReport(swappedReport) === "object-1:mismatch object-2:mismatch",
  );

  missingOneStore = copyDisposableStorageFixture(restoredStore.rootDir, { nameSuffix: "omit" });
  await missingOneStore.provider.deleteObject({
    bucket: FAKE_RESTORE_BUCKET,
    key: restoredNote.storageKey,
  });
  const missingOne = await resolveRestoredPrivateObjects(restoredRefs, (loc) =>
    missingOneStore.provider.getObject(loc),
  );
  check(
    "Fixture with one object removed reports missing for that reference only",
    formatRestoreReport(missingOne) === "object-1:ok object-2:missing",
  );

  const reportText = [recovered, recoveredOther, missingAll, mismatched, flippedReport, swappedReport, missingOne]
    .map((rows) => JSON.stringify(rows))
    .join("\n");
  check(
    "All restore reports omit storage keys, filenames, and customer fields",
    !reportText.includes("storageKey") &&
      !reportText.includes("originalFilename") &&
      !reportText.includes("customerId") &&
      !reportText.includes("businesses/") &&
      !containsSensitiveRestoreLog(reportText),
  );
} finally {
  for (const fixture of [
    missingOneStore,
    swappedStore,
    flippedStore,
    mutatedStore,
    emptyStore,
    restoredStore,
    snapshotStore,
    sourceStore,
  ]) {
    if (fixture) {
      try {
        fixture.cleanup();
      } catch {
        /* still drop databases */
      }
    }
  }
  if (target) {
    try {
      await target.cleanup();
    } catch {
      /* still drop source */
    }
  }
  if (source) {
    try {
      await source.cleanup();
    } catch {
      /* dump file still removed */
    }
  }
  rmSync(dumpDir, { recursive: true, force: true });
}

check("Live drill logs omitted storage keys and customer data", leakedLogs === 0);

console.log(
  failed === 0
    ? `\nHandyman storage-restore drill passed (${passed}). Restored database references resolved to fixture bytes; missing and mismatched objects were reported.`
    : `\n${failed} handyman storage-restore check(s) failed; ${passed} passed.`,
);
process.exit(failed === 0 ? 0 : 1);

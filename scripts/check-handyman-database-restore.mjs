/**
 * Local-only proof that a current-schema Handyman business can be
 * restored after database loss.
 *
 * Seeds customer, property, request, estimate, job, time card, invoice,
 * payment, credit, and private-file metadata on a disposable localhost
 * Postgres database. Uses in-process fake private storage (not R2).
 * Dumps only that disposable database, restores into a second empty
 * disposable database, and checks tenant links, money totals, and file
 * references.
 *
 * This script never connects to or dumps Production. A database restore
 * recreates StoredAsset metadata (storageKey, size, visibility). It does
 * not recreate object-storage bytes.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-handyman-database-restore.mjs
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
  dumpLocalDatabase,
  restoreLocalDatabase,
} from "./lib/local-postgres-backup.mjs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

process.env.TZ = process.env.TZ || "America/New_York";
process.env.TBBT_PAYMENTS_ADAPTER = "fake";
process.env.TBBT_SAAS_BILLING_ADAPTER = "fake";
process.env.TBBT_CUSTOMER_MESSAGING_ADAPTER = "fake";

const FILE_BYTE_SENTINEL = "TBBT_RESTORE_DRILL_PRIVATE_FILE_BYTES_NOT_IN_DUMP";
const INVOICE_TOTAL = "400.00";
const PAYMENT_AMOUNT = "250.00";
const CREDIT_AMOUNT = "50.00";
const REMAINING_DUE = "100.00";

let passed = 0;
let failed = 0;

function check(label, ok) {
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

function money(value) {
  return Number(value).toFixed(2);
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

function sameTenant(businessId, ...records) {
  return records.every((record) => record && record.businessId === businessId);
}

async function snapshotHandymanBusiness(prisma, businessId) {
  const { invoicePaymentBreakdown } = await import("@/lib/project-payments");
  const business = await prisma.business.findUniqueOrThrow({
    where: { id: businessId },
  });
  const customer = await prisma.customer.findFirstOrThrow({
    where: { businessId, name: "Restore Drill Customer" },
  });
  const property = await prisma.property.findFirstOrThrow({
    where: { businessId, customerId: customer.id },
  });
  const request = await prisma.serviceRequest.findFirstOrThrow({
    where: { businessId, customerId: customer.id },
  });
  const estimate = await prisma.estimate.findFirstOrThrow({
    where: { businessId, customerId: customer.id },
    include: { lineItems: { orderBy: { createdAt: "asc" } } },
  });
  const job = await prisma.job.findFirstOrThrow({
    where: { businessId, customerId: customer.id, estimateId: estimate.id },
  });
  const timeEntry = await prisma.timeEntry.findFirstOrThrow({
    where: { businessId, jobId: job.id },
  });
  const invoice = await prisma.invoice.findFirstOrThrow({
    where: { businessId, jobId: job.id },
    include: {
      lineItems: { orderBy: { createdAt: "asc" } },
      payments: { orderBy: { createdAt: "asc" } },
      credits: { orderBy: { createdAt: "asc" } },
    },
  });
  const asset = await prisma.storedAsset.findFirstOrThrow({
    where: { businessId, category: "JOB_PHOTO", visibility: "PRIVATE" },
  });
  const photo = await prisma.jobPhoto.findFirstOrThrow({
    where: { businessId, jobId: job.id, storedAssetId: asset.id },
  });
  const otherTenantCustomers = await prisma.customer.findMany({
    where: { name: "Other Tenant Customer" },
  });
  const breakdown = invoicePaymentBreakdown({
    status: invoice.status,
    total: invoice.total,
    payments: invoice.payments,
    credits: invoice.credits,
  });

  return {
    business: {
      id: business.id,
      name: business.name,
      tradeCode: business.tradeCode,
    },
    customer: { id: customer.id, businessId: customer.businessId, name: customer.name },
    property: {
      id: property.id,
      businessId: property.businessId,
      customerId: property.customerId,
      addressLine1: property.addressLine1,
    },
    request: {
      id: request.id,
      businessId: request.businessId,
      customerId: request.customerId,
      propertyId: request.propertyId,
      status: request.status,
      tradeCode: request.tradeCode,
    },
    estimate: {
      id: estimate.id,
      businessId: estimate.businessId,
      customerId: estimate.customerId,
      propertyId: estimate.propertyId,
      serviceRequestId: estimate.serviceRequestId,
      status: estimate.status,
      total: money(estimate.total),
      publicToken: estimate.publicToken,
      lineCount: estimate.lineItems.length,
      lineTotal: money(estimate.lineItems[0]?.total ?? 0),
    },
    job: {
      id: job.id,
      businessId: job.businessId,
      customerId: job.customerId,
      propertyId: job.propertyId,
      estimateId: job.estimateId,
      status: job.status,
      projectToken: job.projectToken,
    },
    timeEntry: {
      id: timeEntry.id,
      businessId: timeEntry.businessId,
      jobId: timeEntry.jobId,
      membershipId: timeEntry.membershipId,
      activityType: timeEntry.activityType,
      status: timeEntry.status,
    },
    invoice: {
      id: invoice.id,
      businessId: invoice.businessId,
      customerId: invoice.customerId,
      jobId: invoice.jobId,
      status: invoice.status,
      total: money(invoice.total),
      lineTotal: money(invoice.lineItems[0]?.total ?? 0),
      paymentAmount: money(invoice.payments[0]?.amount ?? 0),
      paymentPurpose: invoice.payments[0]?.purpose ?? null,
      creditAmount: money(invoice.credits[0]?.amount ?? 0),
      remainingDue: money(breakdown.amountDue),
    },
    file: {
      assetId: asset.id,
      businessId: asset.businessId,
      jobId: asset.jobId,
      customerId: asset.customerId,
      storageAccountId: asset.storageAccountId,
      storageKey: asset.storageKey,
      originalFilename: asset.originalFilename,
      mimeType: asset.mimeType,
      fileSizeBytes: asset.fileSizeBytes,
      visibility: asset.visibility,
      status: asset.status,
      photoId: photo.id,
      photoJobId: photo.jobId,
      photoUrl: photo.url,
    },
    otherTenantCustomerIds: otherTenantCustomers.map((row) => row.id).sort(),
    linksHold:
      sameTenant(businessId, customer, property, request, estimate, job, timeEntry, invoice, asset, photo) &&
      property.customerId === customer.id &&
      request.customerId === customer.id &&
      request.propertyId === property.id &&
      estimate.customerId === customer.id &&
      estimate.propertyId === property.id &&
      estimate.serviceRequestId === request.id &&
      job.customerId === customer.id &&
      job.propertyId === property.id &&
      job.estimateId === estimate.id &&
      timeEntry.jobId === job.id &&
      invoice.customerId === customer.id &&
      invoice.jobId === job.id &&
      asset.jobId === job.id &&
      photo.storedAssetId === asset.id &&
      otherTenantCustomers.every((row) => row.businessId !== businessId),
  };
}

console.log("\nSTATIC — local-only restore drill; database restore is not object storage");
const selfSrc = readRepo("scripts/check-handyman-database-restore.mjs");
const backupSrc = readRepo("scripts/lib/local-postgres-backup.mjs");
const docsSrc = readRepo("docs/DATABASE_RESTORE.md");
const schemaSrc = readRepo("prisma/schema.prisma");

check(
  "Verifier uses the disposable harness and local dump/restore helpers",
  selfSrc.includes('from "./disposable-test-database.mjs"') &&
    selfSrc.includes("openDisposableTestDatabase") &&
    selfSrc.includes("assertLocalDatabaseUrl") &&
    selfSrc.includes('from "./lib/local-postgres-backup.mjs"') &&
    selfSrc.includes("dumpLocalDatabase") &&
    selfSrc.includes("restoreLocalDatabase"),
);
const dumpFn = backupSrc.slice(backupSrc.indexOf("export function dumpLocalDatabase"));
const restoreFn = backupSrc.slice(backupSrc.indexOf("export function restoreLocalDatabase"));
check(
  "Dump and restore refuse remote hosts before pg_dump / pg_restore",
  backupSrc.includes('from "./local-database-guard.mjs"') &&
    dumpFn.indexOf("backupEnv(databaseUrl, \"pg_dump\")") < dumpFn.indexOf('findPostgresTool("pg_dump")') &&
    restoreFn.indexOf("backupEnv(databaseUrl, \"pg_restore\")") < restoreFn.indexOf('findPostgresTool("pg_restore")') &&
    backupSrc.includes("function backupEnv") &&
    backupSrc.includes("libpqUrlForLocalBackup") &&
    backupSrc.includes("Never dump Production") &&
    backupSrc.includes("metadata only"),
);
check(
  "This script never targets Production and never claims R2 bytes are restored",
  selfSrc.includes("never connects to or dumps Production") &&
    selfSrc.includes("not recreate object-storage bytes") &&
    selfSrc.includes("FILE_BYTE_SENTINEL") &&
    selfSrc.includes("MemoryStorageProvider"),
);
check(
  "Recovery notes record exact local steps and missing object-storage bytes",
  docsSrc.includes("pg_dump") &&
    docsSrc.includes("pg_restore") &&
    docsSrc.includes("does not recreate R2 bytes") &&
    docsSrc.includes("Missing dependencies") &&
    docsSrc.includes("npm run test:handyman-database-restore") &&
    !docsSrc.includes("pg_dump Production") &&
    !docsSrc.includes("dump the production database"),
);
check(
  "Current schema still stores private-file metadata on StoredAsset, not file bytes",
  schemaSrc.includes("model StoredAsset") &&
    schemaSrc.includes("The bytes live in object storage") &&
    schemaSrc.includes("storageKey") &&
    schemaSrc.includes("fileSizeBytes") &&
    !schemaSrc.includes("model TimeCard"),
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

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to a localhost Postgres URL.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "handyman database-restore disposable database");

const dumpDir = mkdtempSync(join(tmpdir(), "tbbt-handyman-restore-"));
const dumpPath = join(dumpDir, "handyman-source.dump");
const fileBody = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  Buffer.from(FILE_BYTE_SENTINEL),
]);

let source = null;
let target = null;

try {
  source = await openDisposableTestDatabase({
    databaseUrl: baseUrl,
    namePrefix: "tbbt_handy_restore_src",
    setProcessEnv: true,
  });

  const { Prisma } = await import("@prisma/client");
  const { MemoryStorageProvider } = await import("@/lib/business-storage/memory-provider");
  const { ensureBusinessStorageAccount, putBusinessObject } = await import(
    "@/lib/business-storage/service"
  );
  const { privateAssetPath } = await import("@/lib/business-storage/keys");
  const { invoicePaymentBreakdown } = await import("@/lib/project-payments");

  const prisma = source.prisma;
  const provider = new MemoryStorageProvider();

  const ownerUser = await prisma.user.create({
    data: {
      name: "Restore Drill Owner",
      email: `restore.owner.${randomUUID().slice(0, 8)}@example.com`,
      passwordHash: "x",
    },
  });
  const memberUser = await prisma.user.create({
    data: {
      name: "Restore Drill Member",
      email: `restore.member.${randomUUID().slice(0, 8)}@example.com`,
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
  const memberMembership = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: business.id, role: "MEMBER", hourlyWage: 28 },
  });
  const otherBusiness = await prisma.business.create({
    data: {
      name: "Other Tenant",
      slug: `other-tenant-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
    },
  });
  await prisma.customer.create({
    data: { businessId: otherBusiness.id, name: "Other Tenant Customer" },
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
  const request = await prisma.serviceRequest.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      propertyId: property.id,
      status: "CONVERTED",
      summary: "Hang a door",
      description: "Current-schema Handyman restore drill request",
      tradeCode: "HANDYMAN",
      serviceIntent: "ONE_TIME",
    },
  });
  const estimate = await prisma.estimate.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      propertyId: property.id,
      serviceRequestId: request.id,
      status: "APPROVED",
      total: new Prisma.Decimal(INVOICE_TOTAL),
      publicToken: randomUUID(),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: business.id,
      estimateId: estimate.id,
      description: "Door hang labor",
      quantity: new Prisma.Decimal("1"),
      unitPrice: new Prisma.Decimal(INVOICE_TOTAL),
      total: new Prisma.Decimal(INVOICE_TOTAL),
      type: "LABOR",
    },
  });
  const job = await prisma.job.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      propertyId: property.id,
      estimateId: estimate.id,
      assignedMembershipId: memberMembership.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  await prisma.timeEntry.create({
    data: {
      businessId: business.id,
      membershipId: memberMembership.id,
      jobId: job.id,
      activityType: "JOB",
      status: "STOPPED",
      startedAt: new Date("2026-10-01T14:00:00.000Z"),
      endedAt: new Date("2026-10-01T16:00:00.000Z"),
      note: "Restore-drill time card",
      source: "CLOCK",
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      jobId: job.id,
      kind: "ORIGINAL",
      status: "SENT",
      total: new Prisma.Decimal(INVOICE_TOTAL),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: business.id,
      invoiceId: invoice.id,
      description: "Door hang labor",
      quantity: new Prisma.Decimal("1"),
      unitPrice: new Prisma.Decimal(INVOICE_TOTAL),
      total: new Prisma.Decimal(INVOICE_TOTAL),
      type: "LABOR",
    },
  });
  await prisma.payment.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      jobId: job.id,
      invoiceId: invoice.id,
      purpose: "INVOICE_BALANCE",
      amount: new Prisma.Decimal(PAYMENT_AMOUNT),
      method: "CASH",
      note: "Restore-drill payment",
    },
  });
  await prisma.invoiceCredit.create({
    data: {
      businessId: business.id,
      invoiceId: invoice.id,
      customerId: customer.id,
      amount: new Prisma.Decimal(CREDIT_AMOUNT),
      reason: "Restore-drill courtesy credit",
      recordedByMembershipId: membership.id,
      idempotencyKey: `restore-drill-${randomUUID()}`,
    },
  });

  const owner = makeAccess(business.id, "OWNER", membership.id);
  await ensureBusinessStorageAccount(prisma, business.id, {
    bucketName: "tbbt-restore-drill-fake",
    defaultLimitBytes: 5_000_000,
  });
  const stored = await putBusinessObject(
    { db: prisma, provider, bucketName: "tbbt-restore-drill-fake" },
    owner,
    {
      category: "JOB_PHOTO",
      purpose: "job-private",
      originalFilename: "restore-door-after.jpg",
      mimeType: "image/jpeg",
      body: fileBody,
      visibility: "PRIVATE",
      jobId: job.id,
      customerId: customer.id,
    },
  );
  await prisma.storedAsset.update({
    where: { id: stored.id },
    data: { jobId: job.id, customerId: customer.id },
  });
  await prisma.jobPhoto.create({
    data: {
      businessId: business.id,
      jobId: job.id,
      stage: "AFTER",
      url: privateAssetPath(stored.id),
      storedAssetId: stored.id,
      caption: "Private after photo metadata",
    },
  });

  console.log("\nSOURCE — current-schema Handyman graph on disposable localhost Postgres");
  const sourceSnap = await snapshotHandymanBusiness(prisma, business.id);
  const sourceObject = await provider.getObject({
    bucket: "tbbt-restore-drill-fake",
    key: sourceSnap.file.storageKey,
  });
  const sourceBreakdown = invoicePaymentBreakdown({
    status: sourceSnap.invoice.status,
    total: sourceSnap.invoice.total,
    payments: [{ purpose: sourceSnap.invoice.paymentPurpose, amount: sourceSnap.invoice.paymentAmount }],
    credits: [{ amount: sourceSnap.invoice.creditAmount }],
  });

  check("Source business is Handyman", sourceSnap.business.tradeCode === "HANDYMAN");
  check("Source tenant links hold across the seeded graph", sourceSnap.linksHold === true);
  check(
    "Source invoice remaining due is total − payment − credit",
    sourceSnap.invoice.total === INVOICE_TOTAL &&
      sourceSnap.invoice.paymentAmount === PAYMENT_AMOUNT &&
      sourceSnap.invoice.creditAmount === CREDIT_AMOUNT &&
      sourceSnap.invoice.remainingDue === REMAINING_DUE &&
      money(sourceBreakdown.amountDue) === REMAINING_DUE,
  );
  check(
    "Source private-file metadata points at the fake storage key and the in-memory bytes exist only there",
    sourceSnap.file.visibility === "PRIVATE" &&
      sourceSnap.file.status === "READY" &&
      sourceSnap.file.storageKey.startsWith(`businesses/${business.id}/`) &&
      sourceSnap.file.fileSizeBytes === fileBody.byteLength &&
      sourceObject?.body &&
      Buffer.from(sourceObject.body).equals(fileBody),
  );

  dumpLocalDatabase({ databaseUrl: source.testUrl, outputPath: dumpPath });
  const dumpBytes = readFileSync(dumpPath);
  check("Local custom-format dump was written", dumpBytes.byteLength > 0);
  check(
    "Database dump does not contain the fake private-file bytes",
    !dumpBytes.includes(FILE_BYTE_SENTINEL),
  );

  target = await openDisposableTestDatabase({
    databaseUrl: baseUrl,
    namePrefix: "tbbt_handy_restore_tgt",
    pushSchema: false,
  });
  restoreLocalDatabase({ databaseUrl: target.testUrl, inputPath: dumpPath });
  const restored = target.createClient();

  console.log("\nRESTORE — second empty disposable database, metadata only");
  const restoredSnap = await snapshotHandymanBusiness(restored, business.id);
  const restoredProvider = new MemoryStorageProvider();
  const restoredObject = await restoredProvider.getObject({
    bucket: "tbbt-restore-drill-fake",
    key: restoredSnap.file.storageKey,
  });
  const restoredPublic = await restored.storedAsset.findUnique({
    where: { id: restoredSnap.file.assetId },
  });

  check("Restored Handyman business id and trade survived", restoredSnap.business.id === sourceSnap.business.id && restoredSnap.business.tradeCode === "HANDYMAN");
  check("Restored tenant links match the source graph", restoredSnap.linksHold === true);
  check(
    "Restored customer / property / request / estimate / job ids match",
    restoredSnap.customer.id === sourceSnap.customer.id &&
      restoredSnap.property.id === sourceSnap.property.id &&
      restoredSnap.request.id === sourceSnap.request.id &&
      restoredSnap.estimate.id === sourceSnap.estimate.id &&
      restoredSnap.job.id === sourceSnap.job.id &&
      restoredSnap.request.serviceRequestId === undefined &&
      restoredSnap.estimate.serviceRequestId === sourceSnap.request.id &&
      restoredSnap.job.estimateId === sourceSnap.estimate.id &&
      restoredSnap.request.propertyId === sourceSnap.property.id,
  );
  check(
    "Restored time card still belongs to the same job and membership",
    restoredSnap.timeEntry.id === sourceSnap.timeEntry.id &&
      restoredSnap.timeEntry.jobId === sourceSnap.job.id &&
      restoredSnap.timeEntry.membershipId === sourceSnap.timeEntry.membershipId &&
      restoredSnap.timeEntry.activityType === "JOB",
  );
  check(
    "Restored invoice totals, payment, credit, and remaining due match",
    JSON.stringify(restoredSnap.invoice) === JSON.stringify(sourceSnap.invoice) &&
      restoredSnap.invoice.remainingDue === REMAINING_DUE,
  );
  check(
    "Restored private-file metadata and JobPhoto reference match; object bytes were not recreated",
    JSON.stringify(restoredSnap.file) === JSON.stringify(sourceSnap.file) &&
      restoredPublic?.storageKey === sourceSnap.file.storageKey &&
      restoredPublic?.fileSizeBytes === fileBody.byteLength &&
      restoredObject === null,
  );
  check(
    "Other-tenant customer stayed on the other business after restore",
    restoredSnap.otherTenantCustomerIds.length === 1 &&
      restoredSnap.otherTenantCustomerIds.join() === sourceSnap.otherTenantCustomerIds.join(),
  );
  check(
    "Tokens that authorize customer surfaces survived",
    restoredSnap.estimate.publicToken === sourceSnap.estimate.publicToken &&
      restoredSnap.job.projectToken === sourceSnap.job.projectToken,
  );
} finally {
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

console.log(
  failed === 0
    ? `\nHandyman database-restore drill passed (${passed}). Database restore recreated tenant links, totals, and file metadata only.`
    : `\n${failed} handyman database-restore check(s) failed; ${passed} passed.`,
);
process.exit(failed === 0 ? 0 : 1);

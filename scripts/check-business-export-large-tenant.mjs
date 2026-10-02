/**
 * Large-tenant hardening for the merged #279/#280 owner business ZIP.
 *
 * Pages matching rows, proves unzip -t on a real OWNER ZIP, and refuses
 * an oversized workspace instead of omitting records. Uses a disposable
 * localhost database. Does not cancel an account or touch production.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-business-export-large-tenant.mjs
 */
import { register } from "node:module";
import { randomUUID } from "node:crypto";
import { crc32 as zlibCrc32 } from "node:zlib";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDisposableTestDatabase } from "./disposable-test-database.mjs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const {
  BUSINESS_EXPORT_AUDIT_AREA,
  BUSINESS_EXPORT_AUDIT_KEY,
  BUSINESS_EXPORT_INCOMPLETE_PREFIX,
  BUSINESS_EXPORT_PAGE_SIZE,
  BusinessExportIncompleteError,
  collectPagedRows,
  runBusinessExportDownload,
} = await import("@/lib/business-export");
const { canExportBusinessData } = await import("@/lib/accounting-export");
const { PROJECT_DOCUMENT_PURPOSE } = await import("@/lib/business-storage/project-documents");
const { VAULT_DOCUMENT_PURPOSE } = await import("@/lib/business-protection");
const {
  ZIP_UTF8_NAME_FLAG,
  buildZipStore,
  neutralizeCsvFormulaPrefix,
  readZipStoreFiles,
  zipNameGeneralPurposeFlag,
} = await import("@/lib/zip-store");

const LARGE_CUSTOMER_COUNT = 1200;
const LARGE_INVOICE_COUNT = 240;
const LARGE_PROJECT_DOC_COUNT = 60;
const PAGE_SIZE = 50;
const OVERFLOW_MAX_ROWS = 200;

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const session = await openDisposableTestDatabase({
  databaseUrl: baseUrl,
  namePrefix: "tbbt_business_export_large",
  pushSchema: true,
});
const prisma = session.prisma;

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

function readRepo(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      business: { id: businessId, name: "Large Export Tenant" },
    },
    scope: businessScope(businessId),
    assertOwned(record) {
      return assertBusinessRecord(record, businessId);
    },
    assertAttachable(record) {
      return assertBusinessRecord(record, businessId);
    },
  };
}

function parseCsv(text) {
  const src = String(text).replace(/\r\n/g, "\n");
  const lines = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
          continue;
        }
        inQuotes = false;
        continue;
      }
      cell += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      if (row.some((value) => value.length > 0)) lines.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.length > 0)) lines.push(row);
  }
  const headers = lines[0] ?? [];
  const records = lines.slice(1).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])),
  );
  return { headers, records };
}

function zipFile(files, name) {
  return files.find((file) => file.name === name) ?? null;
}

function readZipCrcs(bytes) {
  const buf = Buffer.from(bytes);
  const entries = [];
  let offset = 0;
  while (offset + 30 <= buf.length) {
    if (buf.readUInt32LE(offset) !== 0x04034b50) break;
    const crc = buf.readUInt32LE(offset + 14);
    const size = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const dataStart = offset + 30 + nameLen + extraLen;
    const data = buf.subarray(dataStart, dataStart + size);
    entries.push({ crc, data });
    offset = dataStart + size;
  }
  return entries;
}

function fakeFindMany(rows) {
  const calls = [];
  return {
    calls,
    async findMany({ take, cursor, skip }) {
      calls.push({ take, cursorId: cursor?.id ?? null, skip: skip ?? 0 });
      let start = 0;
      if (cursor) {
        const index = rows.findIndex((row) => row.id === cursor.id);
        start = index < 0 ? rows.length : index + (skip ?? 0);
      }
      return rows.slice(start, start + take);
    },
  };
}

const businessExportSrc = readRepo("src/lib/business-export.ts");
const pagingSrc = readRepo("src/lib/business-export-paging.ts");
const zipStoreSrc = readRepo("src/lib/zip-store.ts");
const settingsSrc = readRepo("src/lib/settings.ts");
const settingsWorkspaceSrc = readRepo("src/components/settings/settings-workspace.tsx");
const packageSrc = readRepo("package.json");
const projectQueryStart = businessExportSrc.indexOf("prisma.storedAsset.findMany({");
const projectQuery = businessExportSrc.slice(
  projectQueryStart,
  businessExportSrc.indexOf("]);", projectQueryStart) === -1
    ? businessExportSrc.length
    : businessExportSrc.indexOf("]);", projectQueryStart),
);

console.log("\nSTATIC — paging, fail-closed, preserved #279/#280 behavior");
check(
  "Business ZIP pages matching rows and refuses an incomplete archive",
  pagingSrc.includes("export async function streamPagedRows") &&
    pagingSrc.includes("take: pageSize + 1") &&
    pagingSrc.includes("BusinessExportIncompleteError") &&
    businessExportSrc.includes("collectPagedRows") &&
    businessExportSrc.includes("exportPagedCsv") &&
    businessExportSrc.includes("ZipStoreWriter") &&
    businessExportSrc.includes("status: 413") &&
    !businessExportSrc.includes("not size-capped") &&
    !settingsSrc.includes("not size-capped") &&
    !settingsWorkspaceSrc.includes("not size-capped") &&
    packageSrc.includes("test:business-export-large-tenant"),
);
check(
  "Invoice credits, project-document references, CRC, UTF-8, and formula protection stay",
  businessExportSrc.includes("prisma.invoiceCredit.findMany") &&
    businessExportSrc.includes('name: "invoice-credits.csv"') &&
    businessExportSrc.includes('name: "project-documents.csv"') &&
    projectQuery.includes("PROJECT_DOCUMENT_PURPOSE") &&
    projectQuery.includes('visibility: "PRIVATE"') &&
    projectQuery.includes('status: "READY"') &&
    zipStoreSrc.includes("crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1") &&
    zipStoreSrc.includes("ZIP_UTF8_NAME_FLAG") &&
    zipStoreSrc.includes("neutralizeCsvFormulaPrefix") &&
    businessExportSrc.includes("recordBusinessExportAudit") &&
    canExportBusinessData("OWNER") &&
    canExportBusinessData("ADMIN") &&
    !canExportBusinessData("MEMBER"),
);
check(
  "Default page size stays bounded and larger than this fixture page",
  BUSINESS_EXPORT_PAGE_SIZE === 500 && PAGE_SIZE < BUSINESS_EXPORT_PAGE_SIZE,
);

console.log("\nUNIT — pager finishes every row or throws before omitting");
const fakeRows = Array.from({ length: 25 }, (_, index) => ({
  id: `id-${String(index + 1).padStart(3, "0")}`,
}));
const completeFake = fakeFindMany(fakeRows);
const paged = await collectPagedRows(completeFake.findMany, {
  collection: "customers",
  limits: {
    pageSize: 7,
    maxRowsPerCollection: 100,
    maxZipBytes: 1024 * 1024,
    maxDocumentBytes: 1024 * 1024,
    maxDocuments: 10,
  },
});
check(
  "pageSize 7 reads all 25 rows across 4 pages",
  paged.length === 25 &&
    paged[0].id === "id-001" &&
    paged[24].id === "id-025" &&
    completeFake.calls.length === 4 &&
    completeFake.calls.every((call) => call.take === 8) &&
    completeFake.calls[0].cursorId === null &&
    completeFake.calls[1].cursorId === "id-007",
);

const overflowFake = fakeFindMany(fakeRows);
let overflowError = null;
try {
  await collectPagedRows(overflowFake.findMany, {
    collection: "customers",
    limits: {
      pageSize: 7,
      maxRowsPerCollection: 20,
      maxZipBytes: 1024 * 1024,
      maxDocumentBytes: 1024 * 1024,
      maxDocuments: 10,
    },
  });
} catch (error) {
  overflowError = error;
}
check(
  "Overflow throws before returning a truncated page",
  overflowError instanceof BusinessExportIncompleteError &&
    overflowError.message.includes(BUSINESS_EXPORT_INCOMPLETE_PREFIX) &&
    overflowError.message.includes("customers") &&
    overflowError.message.includes("No ZIP was written") &&
    !overflowError.message.includes("omitted silently"),
);

try {
  console.log("\nDB — large fixture, unzip -t, credits, isolation, fail-closed");
  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Large Export",
      slug: `alpha-large-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Large Export",
      slug: `beta-large-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
    },
  });
  const ownerA = await prisma.user.create({
    data: { name: "Olivia", email: `owner-large-${randomUUID()}@example.com`, passwordHash: "hashed-owner" },
  });
  const adminA = await prisma.user.create({
    data: { name: "Ada", email: `admin-large-${randomUUID()}@example.com`, passwordHash: "hashed-admin" },
  });
  const memberA = await prisma.user.create({
    data: { name: "Mia", email: `member-large-${randomUUID()}@example.com`, passwordHash: "hashed-member" },
  });
  const ownerB = await prisma.user.create({
    data: { name: "Bea", email: `beta-large-${randomUUID()}@example.com`, passwordHash: "hashed-beta" },
  });
  const ownerMemA = await prisma.membership.create({
    data: { userId: ownerA.id, businessId: businessA.id, role: "OWNER" },
  });
  const adminMemA = await prisma.membership.create({
    data: { userId: adminA.id, businessId: businessA.id, role: "ADMIN" },
  });
  const memberMemA = await prisma.membership.create({
    data: { userId: memberA.id, businessId: businessA.id, role: "MEMBER" },
  });
  const ownerMemB = await prisma.membership.create({
    data: { userId: ownerB.id, businessId: businessB.id, role: "OWNER" },
  });

  const formulaCustomer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "\t=1+1" },
  });
  const unicodeCustomer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Café 日本" },
  });
  const creditedCustomer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Pat Credit", email: "pat-credit@example.com" },
  });
  await prisma.customer.createMany({
    data: Array.from({ length: LARGE_CUSTOMER_COUNT - 3 }, (_, index) => ({
      businessId: businessA.id,
      name: `Bulk Customer ${String(index + 1).padStart(4, "0")}`,
      email: `bulk-${index + 1}-${randomUUID().slice(0, 8)}@example.com`,
    })),
  });
  const otherCustomer = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Secret", email: "beta-secret@example.com" },
  });

  const bulkInvoices = await prisma.invoice.createManyAndReturn({
    data: Array.from({ length: LARGE_INVOICE_COUNT }, (_, index) => ({
      businessId: businessA.id,
      customerId: creditedCustomer.id,
      kind: "ORIGINAL",
      status: "SENT",
      total: "10.00",
      paymentReference: `bulk-inv-${index + 1}`,
    })),
  });
  const creditedInvoice = await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: creditedCustomer.id,
      kind: "ORIGINAL",
      status: "SENT",
      total: "100.00",
    },
  });
  const paidInvoice = await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: creditedCustomer.id,
      kind: "ORIGINAL",
      status: "SENT",
      total: "125.50",
    },
  });
  const otherInvoice = await prisma.invoice.create({
    data: {
      businessId: businessB.id,
      customerId: otherCustomer.id,
      kind: "ORIGINAL",
      status: "SENT",
      total: "999.00",
    },
  });

  await prisma.invoiceCredit.createMany({
    data: [
      ...bulkInvoices.map((invoice, index) => ({
        businessId: businessA.id,
        invoiceId: invoice.id,
        customerId: creditedCustomer.id,
        amount: "1.00",
        reason: `Bulk credit ${index + 1}`,
        recordedByMembershipId: ownerMemA.id,
        idempotencyKey: `bulk-credit-${invoice.id}`,
      })),
      {
        businessId: businessA.id,
        invoiceId: creditedInvoice.id,
        customerId: creditedCustomer.id,
        amount: "30.00",
        reason: "Owner correction",
        recordedByMembershipId: ownerMemA.id,
        idempotencyKey: `credit-special-${creditedInvoice.id}`,
      },
      {
        businessId: businessB.id,
        invoiceId: otherInvoice.id,
        customerId: otherCustomer.id,
        amount: "10.00",
        reason: "Beta only credit",
        recordedByMembershipId: ownerMemB.id,
        idempotencyKey: `credit-beta-${otherInvoice.id}`,
      },
    ],
  });
  await prisma.payment.createMany({
    data: [
      ...bulkInvoices.map((invoice) => ({
        businessId: businessA.id,
        customerId: creditedCustomer.id,
        invoiceId: invoice.id,
        purpose: "INVOICE_BALANCE",
        amount: "2.00",
        method: "CHECK",
        note: "Bulk payment",
      })),
      {
        businessId: businessA.id,
        customerId: creditedCustomer.id,
        invoiceId: paidInvoice.id,
        purpose: "INVOICE_BALANCE",
        amount: "40.00",
        method: "CHECK",
        note: "Partial",
      },
    ],
  });

  const storageA = await prisma.businessStorageAccount.create({
    data: {
      businessId: businessA.id,
      provider: "R2",
      mode: "MANAGED",
      bucketName: "tbbt-large-a",
      namespacePrefix: `businesses/${businessA.id}`,
      storageLimitBytes: BigInt(1024 * 1024),
    },
  });
  const storageB = await prisma.businessStorageAccount.create({
    data: {
      businessId: businessB.id,
      provider: "R2",
      mode: "MANAGED",
      bucketName: "tbbt-large-b",
      namespacePrefix: `businesses/${businessB.id}`,
      storageLimitBytes: BigInt(1024 * 1024),
    },
  });
  const projectDocs = await prisma.storedAsset.createManyAndReturn({
    data: Array.from({ length: LARGE_PROJECT_DOC_COUNT }, (_, index) => ({
      businessId: businessA.id,
      storageAccountId: storageA.id,
      customerId: creditedCustomer.id,
      category: "DOCUMENT",
      purpose: PROJECT_DOCUMENT_PURPOSE,
      originalFilename: `scope-${String(index + 1).padStart(3, "0")}.pdf`,
      storageKey: `project-${index + 1}-${randomUUID()}`,
      mimeType: "application/pdf",
      fileSizeBytes: 2048,
      visibility: "PRIVATE",
      status: "READY",
    })),
  });
  const otherDoc = await prisma.storedAsset.create({
    data: {
      businessId: businessB.id,
      storageAccountId: storageB.id,
      customerId: otherCustomer.id,
      category: "DOCUMENT",
      purpose: PROJECT_DOCUMENT_PURPOSE,
      originalFilename: "beta-only.pdf",
      storageKey: `beta-doc-${randomUUID()}`,
      mimeType: "application/pdf",
      fileSizeBytes: 10,
      visibility: "PRIVATE",
      status: "READY",
    },
  });
  const vaultKey = `vault-${randomUUID()}`;
  const vaultAsset = await prisma.storedAsset.create({
    data: {
      businessId: businessA.id,
      storageAccountId: storageA.id,
      category: "DOCUMENT",
      purpose: VAULT_DOCUMENT_PURPOSE,
      originalFilename: "résumé-日本.pdf",
      storageKey: vaultKey,
      mimeType: "application/pdf",
      fileSizeBytes: 32,
      visibility: "PRIVATE",
      status: "READY",
    },
  });
  await prisma.businessVaultRecord.create({
    data: {
      businessId: businessA.id,
      title: "General liability",
      category: "INSURANCE",
      storedAssetId: vaultAsset.id,
      createdByMembershipId: ownerMemA.id,
    },
  });
  const vaultBytes = Buffer.from("%PDF-1.4 vault-bytes");
  const provider = {
    async getObject({ key }) {
      if (key !== vaultKey) return null;
      return { body: vaultBytes };
    },
  };

  const limits = {
    pageSize: PAGE_SIZE,
    maxRowsPerCollection: 5_000,
    maxZipBytes: 16 * 1024 * 1024,
    maxDocumentBytes: 1024 * 1024,
    maxDocuments: 20,
  };
  const ownerAccessA = makeAccess(businessA.id, "OWNER", ownerMemA.id);
  const adminAccessA = makeAccess(businessA.id, "ADMIN", adminMemA.id);
  const memberAccessA = makeAccess(businessA.id, "MEMBER", memberMemA.id);
  const ownerAccessB = makeAccess(businessB.id, "OWNER", ownerMemB.id);

  const memberDownload = await runBusinessExportDownload(prisma, memberAccessA, { limits, provider });
  check(
    "MEMBER still cannot download the business ZIP",
    memberDownload.ok === false && memberDownload.status === 403,
  );

  const ownerDownload = await runBusinessExportDownload(prisma, ownerAccessA, { limits, provider });
  check("OWNER large-tenant ZIP download succeeds", ownerDownload.ok === true);
  if (!ownerDownload.ok) {
    throw new Error(ownerDownload.error);
  }
  const files = readZipStoreFiles(ownerDownload.body);
  const customersCsv = parseCsv(zipFile(files, "customers.csv")?.data.toString("utf8") ?? "");
  const invoicesCsv = parseCsv(zipFile(files, "invoices.csv")?.data.toString("utf8") ?? "");
  const creditsCsv = parseCsv(zipFile(files, "invoice-credits.csv")?.data.toString("utf8") ?? "");
  const projectCsv = parseCsv(zipFile(files, "project-documents.csv")?.data.toString("utf8") ?? "");
  const zipText = ownerDownload.body.toString("utf8");
  const creditedInvoiceRow = invoicesCsv.records.find((row) => row["Invoice ID"] === creditedInvoice.id);
  const paidInvoiceRow = invoicesCsv.records.find((row) => row["Invoice ID"] === paidInvoice.id);
  check(
    `customers.csv includes all ${LARGE_CUSTOMER_COUNT} paged rows plus formula and UTF-8 names`,
    customersCsv.records.length === LARGE_CUSTOMER_COUNT &&
      customersCsv.records.some((row) => row.id === formulaCustomer.id && row.name === "'\t=1+1") &&
      customersCsv.records.some((row) => row.id === unicodeCustomer.id && row.name === "Café 日本") &&
      neutralizeCsvFormulaPrefix("\t=1+1") === "'\t=1+1" &&
      !customersCsv.records.some((row) => row.id === otherCustomer.id) &&
      !zipText.includes(otherCustomer.name),
  );
  check(
    `invoice-credits.csv keeps every credit and invoice remaining after paging`,
    creditsCsv.records.length === LARGE_INVOICE_COUNT + 1 &&
      creditsCsv.records.some(
        (row) => row.invoiceId === creditedInvoice.id && row.amount === "30.00" && row.reason === "Owner correction",
      ) &&
      creditedInvoiceRow?.Total === "100.00" &&
      creditedInvoiceRow?.["Amount Remaining"] === "70.00" &&
      paidInvoiceRow?.Total === "125.50" &&
      paidInvoiceRow?.["Amount Paid"] === "40.00" &&
      paidInvoiceRow?.["Amount Remaining"] === "85.50" &&
      !creditsCsv.records.some((row) => row.invoiceId === otherInvoice.id) &&
      !invoicesCsv.records.some((row) => row["Invoice ID"] === otherInvoice.id),
  );
  check(
    "project-documents.csv lists every READY private portal reference and no other-tenant row",
    projectCsv.records.length === LARGE_PROJECT_DOC_COUNT &&
      projectDocs.every((doc) => projectCsv.records.some((row) => row.id === doc.id)) &&
      !projectCsv.records.some((row) => row.id === otherDoc.id) &&
      !zipText.includes("beta-only.pdf") &&
      !zipText.includes(otherDoc.storageKey),
  );
  check(
    "Vault document export stays complete and uses a UTF-8 filename",
    ownerDownload.ok &&
      files.some((file) => file.name.includes("résumé-日本.pdf") && file.data.equals(vaultBytes)) &&
      zipNameGeneralPurposeFlag("vault-documents/id-résumé-日本.pdf") === ZIP_UTF8_NAME_FLAG,
  );

  const zipPath = join(tmpdir(), `business-export-large-${randomUUID()}.zip`);
  writeFileSync(zipPath, ownerDownload.body);
  const unzipTest = spawnSync("unzip", ["-t", "-qq", zipPath], { encoding: "utf8" });
  const unzipList = spawnSync("unzip", ["-Z", "-1", zipPath], { encoding: "utf8" });
  unlinkSync(zipPath);
  const listed = (unzipList.stdout ?? "").split(/\r?\n/);
  check(
    "unzip -t accepts the large OWNER ZIP and lists invoice-credits plus project-documents",
    unzipTest.status === 0 &&
      listed.includes("invoice-credits.csv") &&
      listed.includes("project-documents.csv") &&
      listed.includes("customers.csv"),
  );
  const crcEntries = readZipCrcs(ownerDownload.body);
  check(
    "Each ZIP entry CRC matches node:zlib crc32",
    crcEntries.length > 0 &&
      crcEntries.every((entry) => entry.crc === (zlibCrc32(entry.data) >>> 0)),
  );

  const adminDownload = await runBusinessExportDownload(prisma, adminAccessA, { limits, provider });
  check("ADMIN can still download the tenant ZIP", adminDownload.ok === true);

  const otherDownload = await runBusinessExportDownload(prisma, ownerAccessB, { limits });
  check("Other OWNER can download only their tenant", otherDownload.ok === true);
  if (otherDownload.ok) {
    const otherFiles = readZipStoreFiles(otherDownload.body);
    const otherCustomers = parseCsv(zipFile(otherFiles, "customers.csv")?.data.toString("utf8") ?? "");
    check(
      "Other OWNER never receives Alpha customers or credits",
      otherCustomers.records.some((row) => row.id === otherCustomer.id) &&
        !otherCustomers.records.some((row) => row.id === creditedCustomer.id) &&
        !otherDownload.body.toString("utf8").includes(creditedCustomer.name) &&
        !otherDownload.body.toString("utf8").includes(creditedInvoice.id),
    );
  }

  const successAudits = await prisma.settingsAuditLog.findMany({
    where: { businessId: businessA.id, settingKey: BUSINESS_EXPORT_AUDIT_KEY },
  });
  check(
    "Successful OWNER and ADMIN downloads still write the businessExport audit",
    successAudits.length === 2 &&
      successAudits.some((row) => row.changedByMembershipId === ownerMemA.id) &&
      successAudits.some((row) => row.changedByMembershipId === adminMemA.id) &&
      successAudits.every((row) => row.settingArea === BUSINESS_EXPORT_AUDIT_AREA) &&
      !successAudits.some((row) => row.changedByMembershipId === memberMemA.id),
  );

  const overflowDownload = await runBusinessExportDownload(prisma, ownerAccessA, {
    provider,
    limits: { ...limits, maxRowsPerCollection: OVERFLOW_MAX_ROWS },
  });
  const auditsAfterOverflow = await prisma.settingsAuditLog.count({
    where: { businessId: businessA.id, settingKey: BUSINESS_EXPORT_AUDIT_KEY },
  });
  check(
    "Oversized customer collection fails closed with 413 and no ZIP or audit",
    overflowDownload.ok === false &&
      overflowDownload.status === 413 &&
      overflowDownload.error.includes(BUSINESS_EXPORT_INCOMPLETE_PREFIX) &&
      overflowDownload.error.includes("customers") &&
      overflowDownload.error.includes("No ZIP was written") &&
      auditsAfterOverflow === successAudits.length,
  );

  const tinyZip = await runBusinessExportDownload(prisma, ownerAccessA, {
    provider,
    limits: { ...limits, maxZipBytes: 800 },
  });
  const auditsAfterTinyZip = await prisma.settingsAuditLog.count({
    where: { businessId: businessA.id, settingKey: BUSINESS_EXPORT_AUDIT_KEY },
  });
  check(
    "ZIP byte cap fails closed instead of writing a truncated archive",
    tinyZip.ok === false &&
      tinyZip.status === 413 &&
      tinyZip.error.includes(BUSINESS_EXPORT_INCOMPLETE_PREFIX) &&
      auditsAfterTinyZip === successAudits.length,
  );

  const tinyDocs = await runBusinessExportDownload(prisma, ownerAccessA, {
    provider,
    limits: { ...limits, maxDocuments: 0 },
  });
  check(
    "Vault document cap fails closed instead of omitting the READY file",
    tinyDocs.ok === false &&
      tinyDocs.status === 413 &&
      tinyDocs.error.includes("vault-documents"),
  );

  const utf8Zip = buildZipStore([{ name: "café.csv", data: "id\n1\n" }]);
  check(
    "UTF-8 ZIP name flag is unchanged for non-ASCII entries",
    zipNameGeneralPurposeFlag("café.csv") === ZIP_UTF8_NAME_FLAG &&
      zipNameGeneralPurposeFlag("customers.csv") === 0 &&
      readZipStoreFiles(utf8Zip)[0]?.name === "café.csv",
  );

  console.log("\nMUTATION — a silent slice would hide overflow");
  const mutatedPager = pagingSrc.replace(
    "if (nextCount > maxRows || (hasMore && nextCount === maxRows)) {",
    "if (false && (nextCount > maxRows || (hasMore && nextCount === maxRows))) {",
  );
  check(
    "Removing the overflow throw is a detectable source mutation",
    mutatedPager.includes("if (false && (nextCount > maxRows") &&
      !mutatedPager.includes("if (nextCount > maxRows || (hasMore && nextCount === maxRows)) {"),
  );
} catch (error) {
  failures += 1;
  console.error("FAIL - unexpected large-tenant export test error");
  console.error(error);
} finally {
  await session.cleanup();
}

if (failures > 0) {
  console.error(`\nBusiness export large-tenant check failed: ${failures} issue(s).`);
  process.exit(1);
}

console.log("\nAll business export large-tenant checks passed.");

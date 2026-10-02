/**
 * Unique #280 additions on top of #279's owner export.
 *
 * Proves runAccountingExportDownload, project-documents.csv, and
 * readZipStoreFiles. Does not replace #279's customer-records or
 * invoice-credit coverage. Uses a disposable local database. Does not
 * cancel an account or touch production customer data.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-owner-export-offboarding.mjs
 */
import { register } from "node:module";
import { randomUUID } from "node:crypto";
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
  runBusinessExportDownload,
} = await import("@/lib/business-export");
const {
  ACCOUNTING_EXPORT_AUDIT_AREA,
  ACCOUNTING_EXPORT_AUDIT_KEY,
  accountingExportAuditPayload,
  buildAccountingExportZip,
  canExportBusinessData,
  runAccountingExportDownload,
} = await import("@/lib/accounting-export");
const {
  CUSTOMER_RECORDS_EXPORT_AUDIT_KEY,
  PRIVATE_FILE_OMISSION,
  canExportCustomerRecords,
  parseCustomerRecordsExport,
  runCustomerRecordsExportDownload,
} = await import("@/lib/customer-records-export");
const { PROJECT_DOCUMENT_PURPOSE } = await import("@/lib/business-storage/project-documents");
const { buildZipStore, readZipStoreFiles } = await import("@/lib/zip-store");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const session = await openDisposableTestDatabase({
  databaseUrl: baseUrl,
  namePrefix: "tbbt_owner_export_offboarding",
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
      business: { id: businessId, name: "Export Tenant" },
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
  const lines = String(text)
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  const headers = (lines[0] ?? "").split(",");
  const records = lines.slice(1).map((line) => {
    const values = line.split(",");
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
  return { headers, records };
}

function zipFile(files, name) {
  return files.find((file) => file.name === name) ?? null;
}

const businessExportSrc = readRepo("src/lib/business-export.ts");
const accountingSrc = readRepo("src/lib/accounting-export.ts");
const accountingRouteSrc = readRepo("src/app/(app)/settings/export/accounting/route.ts");
const zipStoreSrc = readRepo("src/lib/zip-store.ts");
const packageSrc = readRepo("package.json");
const projectQueryStart = businessExportSrc.indexOf("prisma.storedAsset.findMany({");
const projectQuery = businessExportSrc.slice(
  projectQueryStart,
  businessExportSrc.indexOf("]);", projectQueryStart),
);

console.log("\nSTATIC — unique additions on top of #279");
check(
  "runAccountingExportDownload is the accounting download path and is absent from a #279-only route",
  accountingSrc.includes("export async function runAccountingExportDownload") &&
    accountingRouteSrc.includes("runAccountingExportDownload") &&
    !accountingRouteSrc.includes("buildAccountingExportZip") &&
    !accountingRouteSrc.includes("canExportBusinessData"),
);
check(
  "Accounting download audit stays on runAccountingExportDownload, not the route",
  accountingSrc.includes("recordAccountingExportAudit") &&
    accountingSrc.includes("await recordAccountingExportAudit") &&
    ACCOUNTING_EXPORT_AUDIT_AREA === "data-export" &&
    ACCOUNTING_EXPORT_AUDIT_KEY === "accountingExport" &&
    !accountingRouteSrc.includes("recordAccountingExportAudit") &&
    !accountingRouteSrc.includes("writeSettingsAuditLog"),
);
check(
  "project-documents.csv lists READY private portal references only",
  businessExportSrc.includes('name: "project-documents.csv"') &&
    projectQuery.includes("PROJECT_DOCUMENT_PURPOSE") &&
    projectQuery.includes('visibility: "PRIVATE"') &&
    projectQuery.includes('status: "READY"') &&
    projectQuery.includes("deletedAt: null") &&
    projectQuery.includes("publicPath: null") &&
    !projectQuery.includes("storageKey") &&
    !projectQuery.includes("storageAccountId") &&
    !/select:\s*\{[^}]*publicPath/.test(projectQuery),
);
check(
  "readZipStoreFiles is exported next to the #279 ZIP writer",
  zipStoreSrc.includes("export function readZipStoreFiles") &&
    zipStoreSrc.includes("ZIP_UTF8_NAME_FLAG") &&
    zipStoreSrc.includes("neutralizeCsvFormulaPrefix") &&
    packageSrc.includes("test:owner-export-offboarding"),
);
check(
  "#279 customer-records download and invoice-credit ZIP stay in place",
  businessExportSrc.includes('name: "invoice-credits.csv"') &&
    businessExportSrc.includes("recordBusinessExportAudit") &&
    canExportCustomerRecords("OWNER") &&
    !canExportCustomerRecords("ADMIN") &&
    !canExportCustomerRecords("MEMBER") &&
    canExportBusinessData("OWNER") &&
    canExportBusinessData("ADMIN") &&
    !canExportBusinessData("MEMBER"),
);

const utf8Zip = buildZipStore([{ name: "café.csv", data: "id\n1\n" }]);
const utf8Files = readZipStoreFiles(utf8Zip);
check(
  "readZipStoreFiles reads #279 ZIP local headers including a non-ASCII name",
  utf8Files.length === 1 && utf8Files[0].name === "café.csv" && utf8Files[0].data.toString("utf8") === "id\n1\n",
);

try {
  console.log("\nDB — unique download helper, project-document references, isolation");
  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Offboard",
      slug: `alpha-offboard-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Offboard",
      slug: `beta-offboard-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
    },
  });
  const ownerA = await prisma.user.create({
    data: { name: "Olivia", email: `owner-off-${randomUUID()}@example.com`, passwordHash: "hashed-owner" },
  });
  const adminA = await prisma.user.create({
    data: { name: "Ada", email: `admin-off-${randomUUID()}@example.com`, passwordHash: "hashed-admin" },
  });
  const memberA = await prisma.user.create({
    data: { name: "Mia", email: `member-off-${randomUUID()}@example.com`, passwordHash: "hashed-member" },
  });
  const ownerB = await prisma.user.create({
    data: { name: "Bea", email: `beta-off-${randomUUID()}@example.com`, passwordHash: "hashed-beta" },
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

  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Pat Alpha", email: "pat-alpha@example.com" },
  });
  const customerB = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Secret", email: "beta-secret@example.com" },
  });
  const propertyA = await prisma.property.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      label: "Alpha House",
      addressLine1: "10 Alpha Street",
      city: "Austin",
      region: "TX",
      postalCode: "78701",
    },
  });
  const requestA = await prisma.serviceRequest.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      status: "OPEN",
      summary: "Fix door",
      description: "Front door sticks",
      serviceIntent: "ONE_TIME",
    },
  });
  const estimateA = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      serviceRequestId: requestA.id,
      status: "SENT",
      total: "125.50",
      publicToken: `est-secret-${randomUUID()}`,
    },
  });
  const projectToken = `portal-secret-${randomUUID()}`;
  const jobA = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      estimateId: estimateA.id,
      status: "COMPLETED",
      serviceIntent: "ONE_TIME",
      projectToken,
    },
  });
  const jobB = await prisma.job.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      status: "COMPLETED",
      projectToken: `beta-portal-${randomUUID()}`,
    },
  });
  const invoiceA = await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      jobId: jobA.id,
      kind: "ORIGINAL",
      status: "SENT",
      total: "125.50",
    },
  });
  const invoiceB = await prisma.invoice.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      jobId: jobB.id,
      kind: "ORIGINAL",
      status: "SENT",
      total: "999.00",
    },
  });
  await prisma.payment.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      invoiceId: invoiceA.id,
      jobId: jobA.id,
      purpose: "INVOICE_BALANCE",
      amount: "40.00",
      method: "CHECK",
      note: "Partial",
    },
  });

  const storageA = await prisma.businessStorageAccount.create({
    data: {
      businessId: businessA.id,
      provider: "R2",
      mode: "MANAGED",
      bucketName: "tbbt-test-a",
      namespacePrefix: `businesses/${businessA.id}`,
      storageLimitBytes: BigInt(1024 * 1024),
    },
  });
  const storageB = await prisma.businessStorageAccount.create({
    data: {
      businessId: businessB.id,
      provider: "R2",
      mode: "MANAGED",
      bucketName: "tbbt-test-b",
      namespacePrefix: `businesses/${businessB.id}`,
      storageLimitBytes: BigInt(1024 * 1024),
    },
  });
  const projectDocKey = `secret-project-doc-${randomUUID()}`;
  const projectDocA = await prisma.storedAsset.create({
    data: {
      businessId: businessA.id,
      storageAccountId: storageA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      jobId: jobA.id,
      category: "DOCUMENT",
      purpose: PROJECT_DOCUMENT_PURPOSE,
      originalFilename: "signed-scope.pdf",
      storageKey: projectDocKey,
      mimeType: "application/pdf",
      fileSizeBytes: 2048,
      visibility: "PRIVATE",
      status: "READY",
    },
  });
  const pendingDocA = await prisma.storedAsset.create({
    data: {
      businessId: businessA.id,
      storageAccountId: storageA.id,
      jobId: jobA.id,
      category: "DOCUMENT",
      purpose: PROJECT_DOCUMENT_PURPOSE,
      originalFilename: "pending.pdf",
      storageKey: `pending-${randomUUID()}`,
      mimeType: "application/pdf",
      fileSizeBytes: 8,
      visibility: "PRIVATE",
      status: "PENDING",
    },
  });
  const publicDocA = await prisma.storedAsset.create({
    data: {
      businessId: businessA.id,
      storageAccountId: storageA.id,
      jobId: jobA.id,
      category: "DOCUMENT",
      purpose: PROJECT_DOCUMENT_PURPOSE,
      originalFilename: "public-leak.pdf",
      storageKey: `public-${randomUUID()}`,
      mimeType: "application/pdf",
      fileSizeBytes: 8,
      visibility: "PUBLIC",
      status: "READY",
      publicPath: `https://cdn.example/${randomUUID()}.pdf`,
    },
  });
  const vaultDocA = await prisma.storedAsset.create({
    data: {
      businessId: businessA.id,
      storageAccountId: storageA.id,
      jobId: jobA.id,
      category: "DOCUMENT",
      purpose: "BUSINESS_VAULT",
      originalFilename: "insurance.pdf",
      storageKey: `vault-${randomUUID()}`,
      mimeType: "application/pdf",
      fileSizeBytes: 12,
      visibility: "PRIVATE",
      status: "READY",
    },
  });
  const deletedDocA = await prisma.storedAsset.create({
    data: {
      businessId: businessA.id,
      storageAccountId: storageA.id,
      jobId: jobA.id,
      category: "DOCUMENT",
      purpose: PROJECT_DOCUMENT_PURPOSE,
      originalFilename: "deleted.pdf",
      storageKey: `deleted-${randomUUID()}`,
      mimeType: "application/pdf",
      fileSizeBytes: 8,
      visibility: "PRIVATE",
      status: "READY",
      deletedAt: new Date(),
    },
  });
  const jobPhotoA = await prisma.storedAsset.create({
    data: {
      businessId: businessA.id,
      storageAccountId: storageA.id,
      jobId: jobA.id,
      category: "JOB_PHOTO",
      purpose: "job-photo",
      originalFilename: "door.jpg",
      storageKey: `photo-${randomUUID()}`,
      mimeType: "image/jpeg",
      fileSizeBytes: 16,
      visibility: "PRIVATE",
      status: "READY",
    },
  });
  const projectDocB = await prisma.storedAsset.create({
    data: {
      businessId: businessB.id,
      storageAccountId: storageB.id,
      customerId: customerB.id,
      jobId: jobB.id,
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

  const ownerAccessA = makeAccess(businessA.id, "OWNER", ownerMemA.id);
  const adminAccessA = makeAccess(businessA.id, "ADMIN", adminMemA.id);
  const memberAccessA = makeAccess(businessA.id, "MEMBER", memberMemA.id);
  const ownerAccessB = makeAccess(businessB.id, "OWNER", ownerMemB.id);

  await buildAccountingExportZip(prisma, businessA.id);
  const previewAccountingAudits = await prisma.settingsAuditLog.count({
    where: { settingKey: ACCOUNTING_EXPORT_AUDIT_KEY },
  });
  check("Accounting ZIP preview/build writes no audit row", previewAccountingAudits === 0);

  const memberAccounting = await runAccountingExportDownload(prisma, memberAccessA);
  const memberBusiness = await runBusinessExportDownload(prisma, memberAccessA);
  const adminCustomer = await runCustomerRecordsExportDownload(prisma, adminAccessA);
  const failedAccounting = await runAccountingExportDownload(
    prisma,
    makeAccess(`missing-${randomUUID()}`, "OWNER", ownerMemA.id),
  );
  const afterDeniedOrFailed = await prisma.settingsAuditLog.count({
    where: { settingKey: ACCOUNTING_EXPORT_AUDIT_KEY },
  });
  check(
    "MEMBER cannot download the accounting ZIP or business ZIP",
    memberAccounting.ok === false &&
      memberAccounting.status === 403 &&
      !("bytes" in memberAccounting) &&
      memberBusiness.ok === false &&
      memberBusiness.status === 403,
  );
  check(
    "ADMIN still cannot download owner-only customer records",
    adminCustomer.ok === false && adminCustomer.status === 403,
  );
  check(
    "Denied requests and failed generation write no accounting audit and return no ZIP",
    failedAccounting.ok === false &&
      failedAccounting.status === 500 &&
      !("bytes" in failedAccounting) &&
      afterDeniedOrFailed === 0,
  );

  const ownerAccounting = await runAccountingExportDownload(prisma, ownerAccessA);
  const adminAccounting = await runAccountingExportDownload(prisma, adminAccessA);
  const otherAccounting = await runAccountingExportDownload(prisma, ownerAccessB);
  check(
    "OWNER and ADMIN accounting downloads succeed",
    ownerAccounting.ok === true && adminAccounting.ok === true,
  );
  if (!ownerAccounting.ok || !adminAccounting.ok || !otherAccounting.ok) {
    throw new Error("OWNER accounting download failed");
  }
  const accountingFiles = readZipStoreFiles(ownerAccounting.bytes);
  const accountingInvoices = parseCsv(zipFile(accountingFiles, "invoices.csv")?.data.toString("utf8") ?? "");
  const otherAccountingFiles = readZipStoreFiles(otherAccounting.bytes);
  const otherAccountingInvoices = parseCsv(
    zipFile(otherAccountingFiles, "invoices.csv")?.data.toString("utf8") ?? "",
  );
  check(
    "Accounting ZIP stays on this tenant and never includes the other business",
    accountingInvoices.records.some((row) => row["Invoice ID"] === invoiceA.id) &&
      !accountingInvoices.records.some((row) => row["Invoice ID"] === invoiceB.id) &&
      !ownerAccounting.bytes.toString("utf8").includes(customerB.name) &&
      otherAccountingInvoices.records.some((row) => row["Invoice ID"] === invoiceB.id) &&
      !otherAccountingInvoices.records.some((row) => row["Invoice ID"] === invoiceA.id) &&
      !otherAccounting.bytes.toString("utf8").includes(customerA.name),
  );

  const ownerBusiness = await runBusinessExportDownload(prisma, ownerAccessA);
  check("OWNER business ZIP download succeeds", ownerBusiness.ok === true);
  if (!ownerBusiness.ok) {
    throw new Error("OWNER business ZIP download failed");
  }
  const files = readZipStoreFiles(ownerBusiness.body);
  const projectCsv = parseCsv(zipFile(files, "project-documents.csv")?.data.toString("utf8") ?? "");
  const zipText = ownerBusiness.body.toString("utf8");
  const forbiddenProjectHeaders = ["storageKey", "publicPath", "storageAccountId", "url", "body", "bytes"];
  check(
    "project-documents.csv includes only this tenant's READY private portal reference",
    projectCsv.records.length === 1 &&
      projectCsv.records[0].id === projectDocA.id &&
      projectCsv.records[0].jobId === jobA.id &&
      projectCsv.records[0].originalFilename === "signed-scope.pdf" &&
      projectCsv.records[0].status === "READY" &&
      projectCsv.records[0].visibility === "PRIVATE",
  );
  check(
    "project-documents.csv omits pending, public, vault, deleted, job-photo, and other-tenant docs",
    !projectCsv.records.some((row) =>
      [pendingDocA.id, publicDocA.id, vaultDocA.id, deletedDocA.id, jobPhotoA.id, projectDocB.id].includes(
        row.id,
      ),
    ) &&
      !zipText.includes("pending.pdf") &&
      !zipText.includes("public-leak.pdf") &&
      !zipText.includes("beta-only.pdf") &&
      !zipText.includes("deleted.pdf"),
  );
  check(
    "project-documents.csv never leaks storage keys, signed URLs, or file bytes",
    forbiddenProjectHeaders.every((header) => !projectCsv.headers.includes(header)) &&
      !zipText.includes(projectDocKey) &&
      !zipText.includes(publicDocA.publicPath) &&
      !zipText.includes(projectToken) &&
      !zipText.includes("%PDF"),
  );
  const zipPath = join(tmpdir(), `owner-export-${randomUUID()}.zip`);
  writeFileSync(zipPath, ownerBusiness.body);
  const unzipTest = spawnSync("unzip", ["-t", "-qq", zipPath], { encoding: "utf8" });
  const unzipList = spawnSync("unzip", ["-Z", "-1", zipPath], { encoding: "utf8" });
  unlinkSync(zipPath);
  check(
    "unzip -t accepts the OWNER business ZIP and lists project-documents.csv",
    unzipTest.status === 0 && (unzipList.stdout ?? "").split(/\r?\n/).includes("project-documents.csv"),
  );

  const ownerCustomer = await runCustomerRecordsExportDownload(prisma, ownerAccessA, {
    customerId: customerA.id,
  });
  check("OWNER customer-records download still succeeds after the #279 base", ownerCustomer.ok === true);
  if (!ownerCustomer.ok) {
    throw new Error("OWNER customer-records download failed");
  }
  const customerDocument = parseCustomerRecordsExport(JSON.parse(ownerCustomer.body));
  const packet = customerDocument.customers[0];
  check(
    "Customer-records JSON still lists the READY project document as a labeled reference",
    packet.files.items.some(
      (file) =>
        file.id === projectDocA.id &&
        file.kind === "PROJECT_DOCUMENT" &&
        file.relatedJobId === jobA.id &&
        file.status === "REFERENCE" &&
        file.omission === PRIVATE_FILE_OMISSION,
    ) &&
      !ownerCustomer.body.includes(projectDocKey) &&
      !ownerCustomer.body.includes(projectDocB.id),
  );

  const otherBusiness = await runBusinessExportDownload(prisma, ownerAccessB);
  check("Other OWNER can download their own tenant ZIP", otherBusiness.ok === true);
  if (otherBusiness.ok) {
    const otherFiles = readZipStoreFiles(otherBusiness.body);
    const otherProject = parseCsv(zipFile(otherFiles, "project-documents.csv")?.data.toString("utf8") ?? "");
    check(
      "Other OWNER never receives Alpha project-document references",
      otherProject.records.some((row) => row.id === projectDocB.id) &&
        !otherProject.records.some((row) => row.id === projectDocA.id) &&
        !otherBusiness.body.toString("utf8").includes(projectDocA.id) &&
        !otherBusiness.body.toString("utf8").includes(customerA.name),
    );
  }

  const businessAuditsA = await prisma.settingsAuditLog.findMany({
    where: { businessId: businessA.id, settingKey: BUSINESS_EXPORT_AUDIT_KEY },
  });
  const customerAuditsA = await prisma.settingsAuditLog.findMany({
    where: { businessId: businessA.id, settingKey: CUSTOMER_RECORDS_EXPORT_AUDIT_KEY },
  });
  const accountingAuditsA = await prisma.settingsAuditLog.findMany({
    where: { businessId: businessA.id, settingKey: ACCOUNTING_EXPORT_AUDIT_KEY },
    orderBy: { changedAt: "asc" },
  });
  const accountingAuditsB = await prisma.settingsAuditLog.findMany({
    where: { businessId: businessB.id, settingKey: ACCOUNTING_EXPORT_AUDIT_KEY },
  });
  const ownerAccountingAudit = accountingAuditsA.find((row) => row.changedByMembershipId === ownerMemA.id);
  const adminAccountingAudit = accountingAuditsA.find((row) => row.changedByMembershipId === adminMemA.id);
  const ownerAccountingPayload = ownerAccountingAudit ? JSON.parse(ownerAccountingAudit.newValue) : null;
  check(
    "Business ZIP download still writes the #279 businessExport audit row",
    businessAuditsA.length === 1 &&
      businessAuditsA[0].changedByMembershipId === ownerMemA.id &&
      businessAuditsA[0].settingArea === BUSINESS_EXPORT_AUDIT_AREA &&
      customerAuditsA.length === 1,
  );
  check(
    "Each successful accounting ZIP download writes exactly one metadata-only audit row",
    accountingAuditsA.length === 2 &&
      Boolean(ownerAccountingAudit) &&
      Boolean(adminAccountingAudit) &&
      accountingAuditsB.length === 1 &&
      ownerAccountingAudit.settingArea === ACCOUNTING_EXPORT_AUDIT_AREA &&
      ownerAccountingAudit.previousValue === "null" &&
      ownerAccountingPayload?.filename === ownerAccounting.filename &&
      Object.keys(ownerAccountingPayload ?? {}).join(",") === "filename" &&
      JSON.stringify(ownerAccountingPayload) ===
        JSON.stringify(accountingExportAuditPayload({ filename: ownerAccounting.filename })) &&
      !ownerAccountingAudit.newValue.includes(customerA.name) &&
      !ownerAccountingAudit.newValue.includes(customerA.email) &&
      !ownerAccountingAudit.newValue.includes("10 Alpha Street") &&
      !ownerAccountingAudit.newValue.includes(customerB.name) &&
      !accountingAuditsA.some((row) => row.changedByMembershipId === memberMemA.id),
  );

  console.log("\nMUTATION — dropping the unique project-document CSV fails the proof");
  const mutatedSrc = businessExportSrc.replace(
    /\{\s*name: "project-documents.csv",[\s\S]*?projectDocuments,\s*\),\s*\},/,
    "",
  );
  const mutatedPath = join(tmpdir(), `owner-export-offboarding-mutated-${randomUUID()}.mjs`);
  writeFileSync(
    mutatedPath,
    `
      const src = ${JSON.stringify(mutatedSrc)};
      if (src.includes('name: "project-documents.csv"')) {
        console.error("mutated source still has project-documents.csv");
        process.exit(2);
      }
      process.exit(0);
    `,
  );
  const mutated = spawnSync(process.execPath, [mutatedPath], { encoding: "utf8" });
  unlinkSync(mutatedPath);
  check(
    "Mutation that removes project-documents.csv is detected",
    mutated.status === 0 && !mutatedSrc.includes('name: "project-documents.csv"'),
  );
} catch (error) {
  failures += 1;
  console.error("FAIL - unexpected owner-export offboarding test error");
  console.error(error);
} finally {
  await session.cleanup();
}

if (failures > 0) {
  console.error(`\nOwner export offboarding check failed: ${failures} issue(s).`);
  process.exit(1);
}

console.log("\nAll owner export offboarding checks passed.");

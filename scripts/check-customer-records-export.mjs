/**
 * OWNER-only tenant-scoped customer-records export proofs.
 *
 * Covers authorization, isolation, completeness, pagination/limits,
 * secret omission, private-file references, same-business properties
 * with structured addresses, and export audit on a dedicated local
 * test database.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-customer-records-export.mjs
 */
import { register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 as zlibCrc32 } from "node:zlib";
import { openDisposableTestDatabase } from "./disposable-test-database.mjs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError } = await import("@/lib/authorization");
const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const {
  CUSTOMER_RECORDS_EXPORT_AUDIT_AREA,
  CUSTOMER_RECORDS_EXPORT_AUDIT_KEY,
  CUSTOMER_RECORDS_EXPORT_CONTRACT,
  CUSTOMER_RECORDS_EXPORT_FILE_LIMIT,
  CUSTOMER_RECORDS_EXPORT_OMISSIONS,
  CUSTOMER_RECORDS_EXPORT_PAGE_SIZE,
  CUSTOMER_RECORDS_EXPORT_PROJECT_DOCUMENT_PURPOSE,
  CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT,
  CUSTOMER_RECORDS_EXPORT_VERSION,
  PRIVATE_FILE_OMISSION,
  boundExportRead,
  buildCustomerRecordsExport,
  canExportCustomerRecords,
  customerRecordsExportAuditPayload,
  customerRecordsExportFileTruncationMessage,
  customerRecordsExportFilename,
  customerRecordsExportPageTruncationMessage,
  customerRecordsExportCreditTruncationMessage,
  customerRecordsExportPropertyTruncationMessage,
  customerRecordsExportTimeCardTruncationMessage,
  listExportableCustomerRecords,
  parseCustomerRecordsExport,
  recordCustomerRecordsExportAudit,
  runCustomerRecordsExportDownload,
  serializeCustomerRecordsExport,
} = await import("@/lib/customer-records-export");
const {
  BUSINESS_EXPORT_AUDIT_AREA,
  BUSINESS_EXPORT_AUDIT_KEY,
  buildBusinessExportZip,
  runBusinessExportDownload,
} = await import("@/lib/business-export");
const { PROJECT_DOCUMENT_PURPOSE } = await import("@/lib/business-storage/project-documents");
const {
  ZIP_UTF8_NAME_FLAG,
  buildZipStore,
  neutralizeCsvFormulaPrefix,
  toCsvCell,
  zipNameGeneralPurposeFlag,
} = await import("@/lib/zip-store");
const { isSecretSettingKey } = await import("@/lib/settings");
const { CustomerRecordsExportError } = await import("@/lib/customer-records-export/access");

function crc32Table(elseShift) {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = i;
    for (let j = 0; j < 8; j += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> elseShift;
    }
    table[i] = crc >>> 0;
  }
  return table;
}

function crc32WithTable(data, table) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readZipStoreEntries(bytes) {
  const buf = Buffer.from(bytes);
  const entries = [];
  let offset = 0;
  while (offset + 30 <= buf.length) {
    if (buf.readUInt32LE(offset) !== 0x04034b50) break;
    const localFlags = buf.readUInt16LE(offset + 6);
    const crc = buf.readUInt32LE(offset + 14);
    const size = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buf.subarray(nameStart, nameStart + nameLen).toString("utf8");
    const dataStart = nameStart + nameLen + extraLen;
    const data = buf.subarray(dataStart, dataStart + size);
    entries.push({ name, crc, data, localFlags, centralFlags: null });
    offset = dataStart + size;
  }
  while (offset + 46 <= buf.length) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const centralFlags = buf.readUInt16LE(offset + 8);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    const entry = entries.find((row) => row.name === name && row.centralFlags == null);
    if (entry) entry.centralFlags = centralFlags;
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function probeZipTools(bytes) {
  const dir = mkdtempSync(join(tmpdir(), "tbbt-zip-probe-"));
  const zipPath = join(dir, "probe.zip");
  writeFileSync(zipPath, bytes);
  try {
    const unzipTest = spawnSync("unzip", ["-t", "-qq", zipPath]);
    const pythonTest = spawnSync(
      "python3",
      [
        "-c",
        "import sys, zipfile; z=zipfile.ZipFile(sys.argv[1]); print('OK' if z.testzip() is None else 'BAD'); print('\\n'.join(z.namelist()))",
        zipPath,
      ],
      { encoding: "utf8" },
    );
    return {
      unzipMissing: unzipTest.error?.code === "ENOENT",
      unzipOk: unzipTest.status === 0,
      pythonMissing: pythonTest.error?.code === "ENOENT",
      pythonOk: pythonTest.status === 0 && (pythonTest.stdout ?? "").startsWith("OK"),
      pythonNames: (pythonTest.stdout ?? "")
        .split("\n")
        .slice(1)
        .map((row) => row.trim())
        .filter(Boolean),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseCsv(text) {
  const src = text.replace(/\r\n/g, "\n");
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
      lines.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    lines.push(row);
  }
  if (lines.length && lines[lines.length - 1].every((value) => value === "")) {
    lines.pop();
  }
  const headers = lines[0] ?? [];
  const records = lines.slice(1).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])),
  );
  return { headers, records };
}

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const session = await openDisposableTestDatabase({
  databaseUrl: baseUrl,
  namePrefix: "tbbt_customer_records_export",
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

async function expectRejects(label, fn, isExpected) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, isExpected(error));
  }
}

const contractSrc = readRepo("src/lib/customer-records-export/contract.ts");
const buildSrc = readRepo("src/lib/customer-records-export/build.ts");
const parseSrc = readRepo("src/lib/customer-records-export/parse.ts");
const accessSrc = readRepo("src/lib/customer-records-export/access.ts");
const auditSrc = readRepo("src/lib/customer-records-export/audit.ts");
const httpSrc = readRepo("src/lib/customer-records-export/http.ts");
const pageSrc = readRepo("src/app/(app)/customers/records-export/page.tsx");
const downloadSrc = readRepo("src/app/(app)/customers/records-export/download/route.ts");
const businessExportRouteSrc = readRepo("src/app/(app)/settings/export/route.ts");
const panelSrc = readRepo("src/components/customers/customer-records-export-panel.tsx");
const customersPageSrc = readRepo("src/app/(app)/customers/page.tsx");
const customerProfileSrc = readRepo("src/app/(app)/customers/[customerId]/page.tsx");
const settingsSrc = readRepo("src/components/settings/settings-workspace.tsx");
const businessExportSrc = readRepo("src/lib/business-export.ts");
const accountingExportSrc = readRepo("src/lib/accounting-export.ts");
const csvButtonSrc = readRepo("src/components/customers/export-customers-button.tsx");
const authSrc = readRepo("src/lib/authorization.ts");
const schemaSrc = readRepo("prisma/schema.prisma");
const navSrc = readRepo("src/lib/nav.ts");
const packageSrc = readRepo("package.json");
const checkSrc = readRepo("scripts/check-customer-records-export.mjs");
const zipStoreSrc = readRepo("src/lib/zip-store.ts");

const SECRET_MARKERS = [
  "publicToken",
  "projectToken",
  "stripeCheckoutSessionId",
  "stripePaymentIntentId",
  "propertyAccessInstructions",
  "passwordHash",
  "totpSecret",
  "storageKey",
];

console.log("\nSTATIC — inspect existing exports, then OWNER-only customer records");
check(
  "Existing business ZIP, accounting ZIP, and customers CSV remain",
  businessExportSrc.includes("buildBusinessExportZip") &&
    accountingExportSrc.includes("buildAccountingExportZip") &&
    csvButtonSrc.includes("ExportCustomersButton") &&
    customersPageSrc.includes("ExportCustomersButton"),
);
check(
  "OWNER may export customer records; ADMIN and MEMBER cannot",
  canExportCustomerRecords("OWNER") &&
    !canExportCustomerRecords("ADMIN") &&
    !canExportCustomerRecords("MEMBER"),
);
check(
  "Contract is versioned tbbt.customer-records.v1",
  CUSTOMER_RECORDS_EXPORT_CONTRACT === "tbbt.customer-records.v1" &&
    CUSTOMER_RECORDS_EXPORT_VERSION === 1 &&
    contractSrc.includes("tbbt.customer-records.v1"),
);
check(
  "Builder scopes every load by access.businessId and asserts ownership",
  buildSrc.includes("where: { id: cursor, businessId }") &&
    buildSrc.includes("where: { id: customerId, businessId }") &&
    buildSrc.includes("where: { businessId, customerId: customer.id }") &&
    buildSrc.includes("access.assertOwned(customer)") &&
    buildSrc.includes("access.assertOwned(row)") &&
    buildSrc.includes("access.assertOwned(photo)"),
);
check(
  "Secrets, portal tokens, Stripe ids, access codes, and storage keys are never selected",
  SECRET_MARKERS.every((marker) => !buildSrc.includes(marker)) &&
    !buildSrc.includes("url: true") &&
    buildSrc.includes("PRIVATE_FILE_OMISSION") &&
    !auditSrc.includes("propertyAccessInstructions") &&
    !auditSrc.includes("storageKey") &&
    !auditSrc.includes("publicToken"),
);
check(
  "Same-business properties load with structured addresses and stay bounded",
  buildSrc.includes("prisma.property.findMany") &&
    buildSrc.includes("where: { businessId, customerId: customer.id }") &&
    buildSrc.includes("addressLine1: true") &&
    buildSrc.includes("address: {") &&
    buildSrc.includes("postalCode: row.postalCode") &&
    buildSrc.includes("properties: propertyCollection") &&
    parseSrc.includes("customers[${index}].properties") &&
    parseSrc.includes("FORBIDDEN_PROPERTY_KEYS") &&
    parseSrc.includes("entryInstructions") &&
    contractSrc.includes("CustomerRecordsExportAddress") &&
    contractSrc.includes("properties: CustomerRecordsExportCollection<CustomerRecordsExportProperty>"),
);
check(
  "Download records who exported and when on existing SettingsAuditLog",
  downloadSrc.includes("runCustomerRecordsExportDownload") &&
    httpSrc.includes("recordCustomerRecordsExportAudit") &&
    auditSrc.includes("writeSettingsAuditLog") &&
    auditSrc.includes("CUSTOMER_RECORDS_EXPORT_AUDIT_AREA") &&
    CUSTOMER_RECORDS_EXPORT_AUDIT_AREA === "data-export" &&
    CUSTOMER_RECORDS_EXPORT_AUDIT_KEY === "customerRecordsExport" &&
    !isSecretSettingKey(CUSTOMER_RECORDS_EXPORT_AUDIT_KEY) &&
    !schemaSrc.includes("CustomerRecordsExport") &&
    !pageSrc.includes("recordCustomerRecordsExportAudit"),
);
check(
  "Dedicated page and download route stay OWNER-gated",
  pageSrc.includes("canExportCustomerRecords") &&
    pageSrc.includes("buildCustomerRecordsExport") &&
    downloadSrc.includes("runCustomerRecordsExportDownload") &&
    httpSrc.includes("canExportCustomerRecords") &&
    downloadSrc.includes("Cache-Control") &&
    downloadSrc.includes("no-store"),
);
check(
  "Business ZIP download is route-level gated and audited without a new capability",
  businessExportRouteSrc.includes("runBusinessExportDownload") &&
    businessExportSrc.includes("canExportBusinessData") &&
    businessExportSrc.includes("recordBusinessExportAudit") &&
    BUSINESS_EXPORT_AUDIT_AREA === "data-export" &&
    BUSINESS_EXPORT_AUDIT_KEY === "businessExport" &&
    !isSecretSettingKey(BUSINESS_EXPORT_AUDIT_KEY) &&
    businessExportSrc.includes("propertyId: true") &&
    businessExportSrc.includes("activityType: true") &&
    businessExportSrc.includes("exportEstimateTotal") &&
    businessExportSrc.includes("prisma.invoiceCredit.findMany") &&
    businessExportSrc.includes("credits:") &&
    businessExportSrc.includes("invoice-credits.csv"),
);
check(
  "ZIP CRC-32 table uses the correct else-shift and formula text is neutralized",
  zipStoreSrc.includes("crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1") &&
    !zipStoreSrc.includes("crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 8") &&
    zipStoreSrc.includes("neutralizeCsvFormulaPrefix") &&
    zipStoreSrc.includes("CSV_NUMERIC_CELL") &&
    zipStoreSrc.includes("/^[=+\\-@\\t\\r]/") &&
    zipStoreSrc.includes("/[\",\\n\\r]/") &&
    zipStoreSrc.includes("0x0800"),
);
const downloadHelperSrc = httpSrc.slice(
  httpSrc.indexOf("export async function runCustomerRecordsExportDownload"),
);
check(
  "Customer-records download helper owns the OWNER gate and the audit write",
  downloadHelperSrc.includes("if (!canExportCustomerRecords(access.workspace.role))") &&
    downloadHelperSrc.includes('return { ok: false, status: 403, error: "Forbidden" }') &&
    downloadHelperSrc.includes("await recordCustomerRecordsExportAudit(prisma, access, document)") &&
    downloadHelperSrc.indexOf("canExportCustomerRecords") <
      downloadHelperSrc.indexOf("buildCustomerRecordsExport") &&
    downloadHelperSrc.indexOf("await recordCustomerRecordsExportAudit") >
      downloadHelperSrc.indexOf("const document = await buildCustomerRecordsExport"),
);
check(
  "Customer-records contract includes time cards and permitted project-document references",
  contractSrc.includes("timeCards") &&
    contractSrc.includes("PROJECT_DOCUMENT") &&
    CUSTOMER_RECORDS_EXPORT_PROJECT_DOCUMENT_PURPOSE === PROJECT_DOCUMENT_PURPOSE &&
    buildSrc.includes("prisma.timeEntry.findMany") &&
    buildSrc.includes("kind: \"PROJECT_DOCUMENT\"") &&
    !buildSrc.includes("storageKey: true") &&
    parseSrc.includes("FORBIDDEN_TIME_CARD_KEYS") &&
    parseSrc.includes("approvedHourlyWage"),
);
check(
  "Settings and customer surfaces expose the OWNER export without a new global nav item",
  settingsSrc.includes("/customers/records-export") &&
    settingsSrc.includes("CUSTOMER_RECORDS_EXPORT_MESSAGE") &&
    settingsSrc.includes('role === "OWNER"') &&
    customersPageSrc.includes("/customers/records-export") &&
    customerProfileSrc.includes("/customers/records-export?customerId=") &&
    !navSrc.includes("records-export"),
);
check(
  "No new capability, schema table, or shared-database claim",
  !authSrc.includes("EXPORT_CUSTOMER_RECORDS") &&
    !schemaSrc.includes("CustomerRecordsExport") &&
    !buildSrc.includes("liveSynchronization: true") &&
    packageSrc.includes("test:customer-records-export") &&
    checkSrc.includes("openDisposableTestDatabase") &&
    checkSrc.includes('namePrefix: "tbbt_customer_records_export"'),
);
check(
  "Parser rejects live sync, shared database, non-OWNER authorization, and file bytes",
  parseSrc.includes("limits.liveSynchronization must be false") &&
    parseSrc.includes("limits.sharedDatabase must be false") &&
    parseSrc.includes('asExactString(value.role, "OWNER"') &&
    parseSrc.includes('assertAbsent(value, `${label}`, FORBIDDEN_FILE_KEYS)') &&
    parseSrc.includes("publicToken") &&
    parseSrc.includes("stripeCheckoutSessionId"),
);
check(
  "Access helper is OWNER-only and does not invent ADMIN export",
  accessSrc.includes('return role === "OWNER"') && accessSrc.includes('requireBusinessRole(access, "OWNER")'),
);
check(
  "Customer pages and related/file reads are bounded and detect one extra row",
  CUSTOMER_RECORDS_EXPORT_PAGE_SIZE === 25 &&
    CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT === 50 &&
    CUSTOMER_RECORDS_EXPORT_FILE_LIMIT === 40 &&
    buildSrc.includes("take: CUSTOMER_RECORDS_EXPORT_PAGE_SIZE + 1") &&
    buildSrc.includes("take: CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT + 1") &&
    buildSrc.includes("take: CUSTOMER_RECORDS_EXPORT_FILE_LIMIT + 1") &&
    buildSrc.includes("boundExportRead"),
);
check(
  "UI shows pagination, property, time-card, and file-reference honesty",
  panelSrc.includes("customerRecordsExportPageTruncationMessage") &&
    panelSrc.includes("customerRecordsExportFileTruncationMessage") &&
    panelSrc.includes("customerRecordsExportPropertyTruncationMessage") &&
    panelSrc.includes("customerRecordsExportTimeCardTruncationMessage") &&
    panelSrc.includes("document.provenance.page.truncated") &&
    panelSrc.includes("packet.properties.count") &&
    panelSrc.includes("packet.timeCards.count") &&
    panelSrc.includes("packet.credits.count") &&
    panelSrc.includes("customerRecordsExportCreditTruncationMessage") &&
    customerRecordsExportPropertyTruncationMessage(CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT).includes(
      String(CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT),
    ) &&
    customerRecordsExportTimeCardTruncationMessage(CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT).includes(
      String(CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT),
    ) &&
    customerRecordsExportCreditTruncationMessage(CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT).includes(
      String(CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT),
    ),
);
const crcSample = Buffer.from("invoices.csv,payments.csv,time-entries.csv");
const zlibSampleCrc = zlibCrc32(crcSample) >>> 0;
check(
  "Old ZIP CRC table (>>> 8 in the else branch) disagrees with zlib",
  crc32WithTable(crcSample, crc32Table(8)) !== zlibSampleCrc,
);
check(
  "Fixed ZIP CRC table (>>> 1 in the else branch) matches zlib",
  crc32WithTable(crcSample, crc32Table(1)) === zlibSampleCrc,
);
check(
  "CSV formula prefix is neutralized on text and left alone on money",
  neutralizeCsvFormulaPrefix("=cmd|' /C calc'!A0") === "'=cmd|' /C calc'!A0" &&
    neutralizeCsvFormulaPrefix("+SUM(A1)") === "'+SUM(A1)" &&
    neutralizeCsvFormulaPrefix("@foo") === "'@foo" &&
    neutralizeCsvFormulaPrefix("\t=1+1") === "'\t=1+1" &&
    neutralizeCsvFormulaPrefix("\r=1+1") === "'\r=1+1" &&
    neutralizeCsvFormulaPrefix("-70.00") === "-70.00" &&
    neutralizeCsvFormulaPrefix("-1") === "-1" &&
    neutralizeCsvFormulaPrefix("-0.5") === "-0.5" &&
    neutralizeCsvFormulaPrefix("100.00") === "100.00" &&
    toCsvCell("\t=1+1") === "'\t=1+1" &&
    toCsvCell("\r=1+1") === `"'\r=1+1"` &&
    toCsvCell("Line1\rLine2") === `"Line1\rLine2"` &&
    toCsvCell("-70.00") === "-70.00" &&
    toCsvCell("-1") === "-1" &&
    toCsvCell("-0.5") === "-0.5",
);
check(
  "boundExportRead keeps the cap and marks overflow",
  boundExportRead(["a", "b", "c"], 2).truncated === true &&
    boundExportRead(["a", "b", "c"], 2).items.join(",") === "a,b" &&
    boundExportRead(["a", "b"], 2).truncated === false,
);

try {
  console.log("\nDB — authorization, isolation, completeness, limits");
  const businessA = await prisma.business.create({
    data: { name: "Alpha Records", slug: `alpha-cre-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Records", slug: `beta-cre-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const ownerA = await prisma.user.create({
    data: { name: "Olivia", email: `owner-cre-${randomUUID()}@example.com`, passwordHash: "hashed-owner-secret" },
  });
  const adminA = await prisma.user.create({
    data: { name: "Ada", email: `admin-cre-${randomUUID()}@example.com`, passwordHash: "hashed-admin-secret" },
  });
  const memberA = await prisma.user.create({
    data: { name: "Mia", email: `member-cre-${randomUUID()}@example.com`, passwordHash: "hashed-member-secret" },
  });
  const ownerB = await prisma.user.create({
    data: { name: "Bea", email: `beta-cre-${randomUUID()}@example.com`, passwordHash: "hashed-beta-secret" },
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
    data: {
      businessId: businessA.id,
      name: "Pat Alpha",
      email: "pat-alpha@example.com",
      phone: "555-0100",
      firstLeadSource: "WEBSITE",
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    },
  });
  const overflowCustomer = await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: "Overflow Alpha",
      email: "overflow-alpha@example.com",
      createdAt: new Date("2020-01-02T00:00:00.000Z"),
    },
  });
  const customerB = await prisma.customer.create({
    data: {
      businessId: businessB.id,
      name: "Beta Secret",
      email: "beta-secret@example.com",
      phone: "555-0199",
    },
  });

  const propertyA = await prisma.property.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      label: "Alpha House",
      addressLine1: "10 Alpha Street",
      addressLine2: "Unit 2",
      city: "Austin",
      region: "TX",
      postalCode: "78701",
      createdAt: new Date("2020-01-01T12:00:00.000Z"),
    },
  });
  const propertyA2 = await prisma.property.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      label: "Alpha Shop",
      addressLine1: "22 Alpha Way",
      city: "Austin",
      region: "TX",
      postalCode: "78702",
      createdAt: new Date("2020-01-01T13:00:00.000Z"),
    },
  });
  const propertyB = await prisma.property.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      label: "Beta Only Property",
      addressLine1: "99 Beta Lane",
      city: "Dallas",
      region: "TX",
      postalCode: "75201",
    },
  });
  const propertyCross = await prisma.property.create({
    data: {
      businessId: businessB.id,
      customerId: customerA.id,
      label: "Cross-tenant planted property",
      addressLine1: "1 Cross Street",
    },
  });
  const propertyMismatchedOwner = await prisma.property.create({
    data: {
      businessId: businessA.id,
      customerId: customerB.id,
      label: "Wrong-customer planted property",
      addressLine1: "2 Mismatch Road",
    },
  });

  const requestA1 = await prisma.serviceRequest.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      status: "OPEN",
      summary: "Fix door",
      description: "Front door sticks",
      leadSource: "WEBSITE",
    },
  });
  const requestA2 = await prisma.serviceRequest.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "CONVERTED",
      summary: "Paint trim",
    },
  });
  const requestB = await prisma.serviceRequest.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      status: "OPEN",
      summary: "Beta only request",
    },
  });
  const requestCross = await prisma.serviceRequest.create({
    data: {
      businessId: businessB.id,
      customerId: customerA.id,
      status: "OPEN",
      summary: "Cross-tenant planted request",
    },
  });
  const requestMismatchedOwner = await prisma.serviceRequest.create({
    data: {
      businessId: businessA.id,
      customerId: customerB.id,
      status: "OPEN",
      summary: "Wrong-customer planted request",
    },
  });

  const estimateToken = `est-secret-${randomUUID()}`;
  const estimateA = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      serviceRequestId: requestA1.id,
      status: "SENT",
      total: "125.50",
      publicToken: estimateToken,
    },
  });
  const estimateB = await prisma.estimate.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      status: "DRAFT",
      total: "999.00",
      publicToken: `beta-est-${randomUUID()}`,
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
      propertyAccessInstructions: "Key under mat. Code 4321.",
      propertyAccessContactInfo: "Neighbor 555-0111",
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
      paymentMethod: "CHECK",
      paymentReference: "1001",
    },
  });
  const invoiceB = await prisma.invoice.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      status: "SENT",
      total: "888.00",
    },
  });

  const stripeSession = `cs_test_${randomUUID()}`;
  const paymentA = await prisma.payment.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      invoiceId: invoiceA.id,
      jobId: jobA.id,
      purpose: "INVOICE_BALANCE",
      amount: "40.00",
      method: "CHECK",
      note: "Partial",
      stripeCheckoutSessionId: stripeSession,
      stripePaymentIntentId: `pi_${randomUUID()}`,
    },
  });
  const paymentB = await prisma.payment.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      invoiceId: invoiceB.id,
      purpose: "INVOICE_BALANCE",
      amount: "888.00",
      method: "CASH",
    },
  });

  const creditedInvoice = await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      jobId: jobA.id,
      kind: "ORIGINAL",
      status: "SENT",
      total: "100.00",
    },
  });
  const creditA = await prisma.invoiceCredit.create({
    data: {
      businessId: businessA.id,
      invoiceId: creditedInvoice.id,
      customerId: customerA.id,
      amount: "30.00",
      reason: "Owner correction",
      recordedByMembershipId: ownerMemA.id,
      idempotencyKey: `credit-a-${randomUUID()}`,
    },
  });
  const creditB = await prisma.invoiceCredit.create({
    data: {
      businessId: businessB.id,
      invoiceId: invoiceB.id,
      customerId: customerB.id,
      amount: "10.00",
      reason: "Beta only credit",
      recordedByMembershipId: ownerMemB.id,
      idempotencyKey: `credit-b-${randomUUID()}`,
    },
  });
  const formulaNote = "=cmd|' /C calc'!A0";

  const photoUrl = `https://secret-storage.example/private-${randomUUID()}.jpg`;
  const photoA = await prisma.serviceRequestPhoto.create({
    data: {
      businessId: businessA.id,
      serviceRequestId: requestA1.id,
      url: photoUrl,
    },
  });
  await prisma.jobPhoto.create({
    data: {
      businessId: businessA.id,
      jobId: jobA.id,
      stage: "AFTER",
      caption: "Finished lockset",
      url: `https://secret-storage.example/job-${randomUUID()}.jpg`,
      marketingPermissionStatus: "PRIVATE",
    },
  });
  await prisma.serviceRequestPhoto.create({
    data: {
      businessId: businessB.id,
      serviceRequestId: requestB.id,
      url: "https://secret-storage.example/beta-only.jpg",
    },
  });

  const timeCardA = await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: ownerMemA.id,
      jobId: jobA.id,
      activityType: "JOB",
      status: "STOPPED",
      source: "CLOCK",
      note: "Installed lockset",
      startedAt: new Date("2026-03-01T14:00:00.000Z"),
      endedAt: new Date("2026-03-01T16:00:00.000Z"),
    },
  });
  await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: memberMemA.id,
      jobId: jobA.id,
      activityType: "JOB",
      status: "STOPPED",
      source: "CLOCK",
      note: formulaNote,
      startedAt: new Date("2026-03-01T16:00:00.000Z"),
      endedAt: new Date("2026-03-01T16:30:00.000Z"),
    },
  });
  const timeCardB = await prisma.timeEntry.create({
    data: {
      businessId: businessB.id,
      membershipId: ownerMemB.id,
      jobId: jobB.id,
      activityType: "JOB",
      status: "STOPPED",
      source: "CLOCK",
      note: "Beta only time",
      startedAt: new Date("2026-03-02T14:00:00.000Z"),
      endedAt: new Date("2026-03-02T15:00:00.000Z"),
    },
  });
  const timeCardCross = await prisma.timeEntry.create({
    data: {
      businessId: businessB.id,
      membershipId: ownerMemB.id,
      jobId: jobA.id,
      activityType: "TRAVEL",
      status: "STOPPED",
      source: "CLOCK",
      note: "Cross-tenant planted time",
      startedAt: new Date("2026-03-03T14:00:00.000Z"),
      endedAt: new Date("2026-03-03T14:30:00.000Z"),
    },
  });

  const storageA = await prisma.businessStorageAccount.create({
    data: {
      businessId: businessA.id,
      provider: "R2",
      mode: "MANAGED",
      bucketName: "tbbt-test",
      namespacePrefix: `businesses/${businessA.id}`,
      storageLimitBytes: BigInt(1024 * 1024),
    },
  });
  const storageB = await prisma.businessStorageAccount.create({
    data: {
      businessId: businessB.id,
      provider: "R2",
      mode: "MANAGED",
      bucketName: "tbbt-test",
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
      originalFilename: "permit.pdf",
      storageKey: projectDocKey,
      mimeType: "application/pdf",
      fileSizeBytes: 24,
      visibility: "PRIVATE",
      status: "READY",
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

  const overflowJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: overflowCustomer.id,
      status: "SCHEDULED",
      serviceIntent: "ONE_TIME",
      projectToken: `overflow-job-${randomUUID()}`,
    },
  });
  const overflowTimeCards = await Promise.all(
    Array.from({ length: CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT + 1 }, (_, index) =>
      prisma.timeEntry.create({
        data: {
          businessId: businessA.id,
          membershipId: ownerMemA.id,
          jobId: overflowJob.id,
          activityType: "JOB",
          status: "STOPPED",
          source: "CLOCK",
          note: `Overflow time ${index + 1}`,
          startedAt: new Date(Date.UTC(2024, 2, 1 + index, 13, 0, 0)),
          endedAt: new Date(Date.UTC(2024, 2, 1 + index, 14, 0, 0)),
        },
      }),
    ),
  );

  const overflowRequests = await Promise.all(
    Array.from({ length: CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT + 1 }, (_, index) =>
      prisma.serviceRequest.create({
        data: {
          businessId: businessA.id,
          customerId: overflowCustomer.id,
          status: "OPEN",
          summary: `Overflow request ${index + 1}`,
          createdAt: new Date(Date.UTC(2024, 0, 1 + index)),
        },
      }),
    ),
  );
  const overflowProperties = await Promise.all(
    Array.from({ length: CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT + 1 }, (_, index) =>
      prisma.property.create({
        data: {
          businessId: businessA.id,
          customerId: overflowCustomer.id,
          label: `Overflow property ${index + 1}`,
          addressLine1: `${index + 1} Overflow Court`,
          createdAt: new Date(Date.UTC(2024, 1, 1 + index)),
        },
      }),
    ),
  );

  const extraCustomers = [];
  for (let index = 0; index < CUSTOMER_RECORDS_EXPORT_PAGE_SIZE; index += 1) {
    extraCustomers.push(
      await prisma.customer.create({
        data: {
          businessId: businessA.id,
          name: `Extra ${String(index + 1).padStart(2, "0")}`,
          createdAt: new Date(Date.UTC(2025, 0, 1 + index)),
        },
      }),
    );
  }
  const tabFormulaCustomer = await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: "\t=1+1",
      createdAt: new Date(Date.UTC(2026, 0, 2)),
    },
  });
  const crFormulaCustomer = await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: "\r=1+1",
      createdAt: new Date(Date.UTC(2026, 0, 3)),
    },
  });
  const embeddedCrCustomer = await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: "Line1\rLine2",
      createdAt: new Date(Date.UTC(2026, 0, 4)),
    },
  });

  const ownerAccessA = makeAccess(businessA.id, "OWNER", ownerMemA.id);
  const adminAccessA = makeAccess(businessA.id, "ADMIN", adminMemA.id);
  const memberAccessA = makeAccess(businessA.id, "MEMBER", memberMemA.id);
  const ownerAccessB = makeAccess(businessB.id, "OWNER", ownerMemB.id);

  await expectRejects(
    "ADMIN cannot export customer records",
    () => buildCustomerRecordsExport(prisma, adminAccessA),
    (error) => error instanceof ForbiddenError,
  );
  await expectRejects(
    "MEMBER cannot export customer records",
    () => buildCustomerRecordsExport(prisma, memberAccessA),
    (error) => error instanceof ForbiddenError,
  );
  await expectRejects(
    "ADMIN cannot list exportable customer records",
    () => listExportableCustomerRecords(prisma, adminAccessA),
    (error) => error instanceof ForbiddenError,
  );
  await expectRejects(
    "OWNER cannot export another business's customer by id",
    () => buildCustomerRecordsExport(prisma, ownerAccessA, { customerId: customerB.id }),
    (error) => error instanceof CustomerRecordsExportError && error.code === "NOT_FOUND",
  );
  await expectRejects(
    "OWNER cannot page from another business's customer cursor",
    () => buildCustomerRecordsExport(prisma, ownerAccessA, { cursor: customerB.id }),
    (error) => error instanceof CustomerRecordsExportError && error.code === "INVALID",
  );

  const pageOne = await buildCustomerRecordsExport(prisma, ownerAccessA);
  const pageOneJson = serializeCustomerRecordsExport(pageOne);
  const pageOneIds = pageOne.customers.map((packet) => packet.customer.id);
  const packetA = pageOne.customers.find((packet) => packet.customer.id === customerA.id);
  const overflowPacket = pageOne.customers.find((packet) => packet.customer.id === overflowCustomer.id);

  check(
    "First page is bounded and marked truncated when more customers exist",
    pageOne.provenance.page.truncated === true &&
      pageOne.provenance.page.limit === CUSTOMER_RECORDS_EXPORT_PAGE_SIZE &&
      pageOne.provenance.page.count === CUSTOMER_RECORDS_EXPORT_PAGE_SIZE &&
      pageOne.customers.length === CUSTOMER_RECORDS_EXPORT_PAGE_SIZE &&
      Boolean(pageOne.provenance.page.nextCursor) &&
      customerRecordsExportPageTruncationMessage(CUSTOMER_RECORDS_EXPORT_PAGE_SIZE).includes(
        String(CUSTOMER_RECORDS_EXPORT_PAGE_SIZE),
      ),
  );
  check(
    "First page includes the oldest same-business customers and never another tenant",
    pageOneIds.includes(customerA.id) &&
      pageOneIds.includes(overflowCustomer.id) &&
      !pageOneIds.includes(customerB.id) &&
      pageOne.customers.every((packet) => packet.customer.id !== customerB.id),
  );
  check(
    "OWNER export includes the complete related set for a customer under the cap",
    Boolean(packetA) &&
      packetA.properties.count === 2 &&
      packetA.properties.truncated === false &&
      packetA.properties.items.some(
        (row) =>
          row.id === propertyA.id &&
          row.customerId === customerA.id &&
          row.label === "Alpha House" &&
          row.address.addressLine1 === "10 Alpha Street" &&
          row.address.addressLine2 === "Unit 2" &&
          row.address.city === "Austin" &&
          row.address.region === "TX" &&
          row.address.postalCode === "78701",
      ) &&
      packetA.properties.items.some((row) => row.id === propertyA2.id) &&
      packetA.requests.count === 2 &&
      packetA.requests.truncated === false &&
      packetA.requests.items.some((row) => row.id === requestA1.id && row.summary === "Fix door") &&
      packetA.requests.items.some((row) => row.id === requestA2.id) &&
      packetA.estimates.count === 1 &&
      packetA.estimates.items[0].id === estimateA.id &&
      packetA.estimates.items[0].total === "125.50" &&
      packetA.estimates.items[0].propertyId === propertyA.id &&
      packetA.jobs.count === 1 &&
      packetA.jobs.items[0].id === jobA.id &&
      packetA.jobs.items[0].propertyId === propertyA.id &&
      packetA.jobs.items[0].estimateId === estimateA.id &&
      packetA.invoices.count === 2 &&
      packetA.invoices.items.some((row) => row.id === invoiceA.id) &&
      packetA.invoices.items.some((row) => row.id === creditedInvoice.id && row.total === "100.00") &&
      packetA.payments.count === 1 &&
      packetA.payments.items[0].id === paymentA.id &&
      packetA.payments.items[0].amount === "40.00" &&
      packetA.credits.count === 1 &&
      packetA.credits.truncated === false &&
      packetA.credits.items[0].id === creditA.id &&
      packetA.credits.items[0].invoiceId === creditedInvoice.id &&
      packetA.credits.items[0].amount === "30.00" &&
      packetA.timeCards.count === 2 &&
      packetA.timeCards.truncated === false &&
      packetA.timeCards.items.some(
        (row) =>
          row.id === timeCardA.id &&
          row.jobId === jobA.id &&
          row.activityType === "JOB" &&
          row.note === "Installed lockset",
      ),
  );
  check(
    "Related overflow is truncated at the related-record cap",
    Boolean(overflowPacket) &&
      overflowPacket.requests.truncated === true &&
      overflowPacket.requests.count === CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT &&
      overflowPacket.requests.items.length === CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT &&
      overflowPacket.requests.items[0].id === overflowRequests[0].id &&
      !overflowPacket.requests.items.some(
        (row) => row.id === overflowRequests[CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT].id,
      ) &&
      overflowPacket.properties.truncated === true &&
      overflowPacket.properties.count === CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT &&
      overflowPacket.properties.items.length === CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT &&
      overflowPacket.properties.items[0].id === overflowProperties[0].id &&
      !overflowPacket.properties.items.some(
        (row) => row.id === overflowProperties[CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT].id,
      ) &&
      overflowPacket.timeCards.truncated === true &&
      overflowPacket.timeCards.count === CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT &&
      overflowPacket.timeCards.items[0].id === overflowTimeCards[0].id &&
      !overflowPacket.timeCards.items.some(
        (row) => row.id === overflowTimeCards[CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT].id,
      ),
  );
  check(
    "Export never includes another business's records or planted cross-tenant rows",
    !pageOneJson.includes(customerB.name) &&
      !pageOneJson.includes(customerB.email) &&
      !pageOneJson.includes(requestB.id) &&
      !pageOneJson.includes(requestCross.id) &&
      !pageOneJson.includes(requestMismatchedOwner.id) &&
      !pageOneJson.includes(estimateB.id) &&
      !pageOneJson.includes(jobB.id) &&
      !pageOneJson.includes(invoiceB.id) &&
      !pageOneJson.includes(paymentB.id) &&
      !pageOneJson.includes(creditB.id) &&
      !pageOneJson.includes("Beta only credit") &&
      !pageOneJson.includes(timeCardB.id) &&
      !pageOneJson.includes(timeCardCross.id) &&
      !pageOneJson.includes("Beta only time") &&
      !pageOneJson.includes("Cross-tenant planted time") &&
      !pageOneJson.includes(projectDocB.id) &&
      !pageOneJson.includes("beta-only.pdf") &&
      !pageOneJson.includes(vaultDocA.id) &&
      !pageOneJson.includes(pendingDocA.id) &&
      !pageOneJson.includes("Beta only request") &&
      !pageOneJson.includes("Cross-tenant planted request") &&
      !pageOneJson.includes("Wrong-customer planted request") &&
      !pageOneJson.includes(propertyB.id) &&
      !pageOneJson.includes(propertyCross.id) &&
      !pageOneJson.includes(propertyMismatchedOwner.id) &&
      !pageOneJson.includes("Beta Only Property") &&
      !pageOneJson.includes("Cross-tenant planted property") &&
      !pageOneJson.includes("Wrong-customer planted property") &&
      !pageOneJson.includes("99 Beta Lane"),
  );
  check(
    "Secrets, portal tokens, Stripe ids, access codes, and private file URLs are omitted",
    !pageOneJson.includes(estimateToken) &&
      !pageOneJson.includes(projectToken) &&
      !pageOneJson.includes(stripeSession) &&
      !pageOneJson.includes("Key under mat") &&
      !pageOneJson.includes("4321") &&
      !pageOneJson.includes(photoUrl) &&
      !pageOneJson.includes(projectDocKey) &&
      !pageOneJson.includes("hashed-owner-secret") &&
      !pageOneJson.includes("publicToken") &&
      !pageOneJson.includes("projectToken") &&
      !pageOneJson.includes("stripeCheckoutSessionId") &&
      !pageOneJson.includes("storageKey") &&
      !pageOneJson.includes("accessCode") &&
      !pageOneJson.includes("entryInstructions") &&
      packetA.properties.items.every(
        (row) =>
          !("accessCode" in row) &&
          !("entryInstructions" in row) &&
          !("storageKey" in row) &&
          !("url" in row.address),
      ),
  );
  check(
    "Private files are same-business permitted references with a labeled omission",
    packetA.files.count >= 3 &&
      packetA.files.items.some(
        (file) =>
          file.id === photoA.id &&
          file.kind === "REQUEST_PHOTO" &&
          file.relatedRequestId === requestA1.id &&
          file.status === "REFERENCE" &&
          file.omission === PRIVATE_FILE_OMISSION,
      ) &&
      packetA.files.items.some(
        (file) =>
          file.id === projectDocA.id &&
          file.kind === "PROJECT_DOCUMENT" &&
          file.relatedJobId === jobA.id &&
          file.originalFilename === "permit.pdf" &&
          file.status === "REFERENCE" &&
          file.omission === PRIVATE_FILE_OMISSION,
      ) &&
      packetA.files.items.every(
        (file) =>
          !("url" in file) &&
          !("storageKey" in file) &&
          file.id !== vaultDocA.id &&
          file.id !== pendingDocA.id &&
          file.id !== projectDocB.id,
      ) &&
      CUSTOMER_RECORDS_EXPORT_OMISSIONS.some((item) => item.includes("Private file bytes")),
  );

  const pageTwo = await buildCustomerRecordsExport(prisma, ownerAccessA, {
    cursor: pageOne.provenance.page.nextCursor,
  });
  const pageTwoIds = pageTwo.customers.map((packet) => packet.customer.id);
  const allPageIds = [...pageOneIds, ...pageTwoIds];
  const expectedExtra = extraCustomers.map((row) => row.id);
  check(
    "Second page continues after the cursor with no overlap and no other tenant",
    pageTwo.provenance.page.cursor === pageOne.provenance.page.nextCursor &&
      pageTwo.provenance.page.truncated === false &&
      pageTwoIds.length > 0 &&
      pageTwoIds.every((id) => !pageOneIds.includes(id)) &&
      !pageTwoIds.includes(customerB.id) &&
      expectedExtra.every((id) => allPageIds.includes(id)) &&
      allPageIds.includes(customerA.id) &&
      allPageIds.includes(overflowCustomer.id) &&
      !allPageIds.includes(customerB.id),
  );

  const single = await buildCustomerRecordsExport(prisma, ownerAccessA, {
    customerId: customerA.id,
  });
  check(
    "Single-customer export is complete for that tenant customer only",
    single.provenance.page.customerId === customerA.id &&
      single.customers.length === 1 &&
      single.customers[0].customer.id === customerA.id &&
      single.customers[0].requests.items.map((row) => row.id).sort().join(",") ===
        [requestA1.id, requestA2.id].sort().join(",") &&
      single.customers[0].properties.items.map((row) => row.id).sort().join(",") ===
        [propertyA.id, propertyA2.id].sort().join(",") &&
      single.customers[0].payments.items[0].id === paymentA.id &&
      !serializeCustomerRecordsExport(single).includes(customerB.name),
  );

  const otherOwner = await buildCustomerRecordsExport(prisma, ownerAccessB);
  const otherJson = serializeCustomerRecordsExport(otherOwner);
  check(
    "The other OWNER only receives their own tenant's customers and related records",
    otherOwner.customers.length === 1 &&
      otherOwner.customers[0].customer.id === customerB.id &&
      otherOwner.customers[0].requests.items.some((row) => row.id === requestB.id) &&
      otherOwner.customers[0].properties.items.some((row) => row.id === propertyB.id) &&
      !otherJson.includes(propertyA.id) &&
      !otherJson.includes(customerA.name) &&
      !otherJson.includes(requestA1.id) &&
      !otherJson.includes(estimateA.id) &&
      !otherJson.includes(jobA.id) &&
      !otherJson.includes(invoiceA.id) &&
      !otherJson.includes(paymentA.id) &&
      !otherJson.includes(creditA.id) &&
      !otherJson.includes(timeCardA.id) &&
      !otherJson.includes(projectDocA.id),
  );

  const roundTrip = parseCustomerRecordsExport(JSON.parse(serializeCustomerRecordsExport(single)));
  check(
    "Portable JSON round-trips through the versioned parser",
    roundTrip.contract === CUSTOMER_RECORDS_EXPORT_CONTRACT &&
      roundTrip.customers[0].customer.id === customerA.id &&
      roundTrip.customers[0].invoices.items[0].total === "125.50" &&
      roundTrip.authorization.role === "OWNER" &&
      customerRecordsExportFilename(roundTrip).includes(businessA.slug),
  );

  const listed = await listExportableCustomerRecords(prisma, ownerAccessA, {
    customerId: customerA.id,
  });
  check(
    "List helper reuses the same OWNER builder and tenant counts",
    listed.customers.length === 1 &&
      listed.customers[0].customerId === customerA.id &&
      listed.customers[0].propertyCount === 2 &&
      listed.customers[0].requestCount === 2 &&
      listed.customers[0].paymentCount === 1 &&
      listed.customers[0].creditCount === 1 &&
      listed.customers[0].timeCardCount === 2 &&
      listed.truncated === false,
  );

  await prisma.serviceRequestPhoto.createMany({
    data: Array.from({ length: CUSTOMER_RECORDS_EXPORT_FILE_LIMIT }, (_, index) => ({
      businessId: businessA.id,
      serviceRequestId: requestA2.id,
      url: `https://secret-storage.example/overflow-${index}.jpg`,
      createdAt: new Date(Date.UTC(2024, 6, 1 + index)),
    })),
  });
  const fileLimited = await buildCustomerRecordsExport(prisma, ownerAccessA, {
    customerId: customerA.id,
  });
  check(
    "File references stop at the cap and never include overflow URLs",
    fileLimited.customers[0].files.truncated === true &&
      fileLimited.customers[0].files.count === CUSTOMER_RECORDS_EXPORT_FILE_LIMIT &&
      fileLimited.customers[0].files.items.length === CUSTOMER_RECORDS_EXPORT_FILE_LIMIT &&
      !serializeCustomerRecordsExport(fileLimited).includes("/overflow-") &&
      customerRecordsExportFileTruncationMessage(CUSTOMER_RECORDS_EXPORT_FILE_LIMIT).includes(
        String(CUSTOMER_RECORDS_EXPORT_FILE_LIMIT),
      ),
  );

  const parsedLimited = parseCustomerRecordsExport(JSON.parse(serializeCustomerRecordsExport(fileLimited)));
  check(
    "Truncated file-reference packet round-trips with the cap marked",
    parsedLimited.customers[0].files.truncated === true &&
      parsedLimited.customers[0].files.count === CUSTOMER_RECORDS_EXPORT_FILE_LIMIT,
  );

  const previewAuditRows = await prisma.settingsAuditLog.findMany({
    where: {
      businessId: { in: [businessA.id, businessB.id] },
      settingKey: CUSTOMER_RECORDS_EXPORT_AUDIT_KEY,
    },
  });
  check(
    "Preview/build does not write an export audit row",
    previewAuditRows.length === 0,
  );

  const recorded = await recordCustomerRecordsExportAudit(prisma, ownerAccessA, single);
  const payload = JSON.parse(recorded.newValue);
  const expectedPayload = customerRecordsExportAuditPayload(single);
  check(
    "OWNER download audit records who exported and when on this tenant",
    recorded.businessId === businessA.id &&
      recorded.changedByMembershipId === ownerMemA.id &&
      recorded.settingArea === CUSTOMER_RECORDS_EXPORT_AUDIT_AREA &&
      recorded.settingKey === CUSTOMER_RECORDS_EXPORT_AUDIT_KEY &&
      recorded.previousValue === "null" &&
      recorded.changedAt instanceof Date &&
      payload.exportedAt === single.exportedAt &&
      payload.authorizedByMembershipId === ownerMemA.id &&
      payload.customerId === customerA.id &&
      payload.contract === CUSTOMER_RECORDS_EXPORT_CONTRACT &&
      payload.version === CUSTOMER_RECORDS_EXPORT_VERSION &&
      JSON.stringify(payload) === JSON.stringify(expectedPayload),
  );
  check(
    "Export audit payload keeps secrets, tokens, and storage keys out",
    !recorded.newValue.includes(estimateToken) &&
      !recorded.newValue.includes(projectToken) &&
      !recorded.newValue.includes(stripeSession) &&
      !recorded.newValue.includes("Key under mat") &&
      !recorded.newValue.includes(photoUrl) &&
      !recorded.newValue.includes("hashed-owner-secret") &&
      !recorded.newValue.includes("publicToken") &&
      !recorded.newValue.includes("storageKey") &&
      !recorded.newValue.includes("accessCode"),
  );

  await expectRejects(
    "ADMIN cannot record a customer-records export audit",
    () => recordCustomerRecordsExportAudit(prisma, adminAccessA, single),
    (error) => error instanceof ForbiddenError,
  );

  const otherAudit = await recordCustomerRecordsExportAudit(prisma, ownerAccessB, otherOwner);
  const ownerAAudit = await prisma.settingsAuditLog.findMany({
    where: { businessId: businessA.id, settingKey: CUSTOMER_RECORDS_EXPORT_AUDIT_KEY },
  });
  const ownerBAudit = await prisma.settingsAuditLog.findMany({
    where: { businessId: businessB.id, settingKey: CUSTOMER_RECORDS_EXPORT_AUDIT_KEY },
  });
  check(
    "Export audit rows stay tenant-isolated",
    ownerAAudit.length === 1 &&
      ownerAAudit[0].id === recorded.id &&
      ownerAAudit[0].changedByMembershipId === ownerMemA.id &&
      ownerBAudit.length === 1 &&
      ownerBAudit[0].id === otherAudit.id &&
      ownerBAudit[0].changedByMembershipId === ownerMemB.id &&
      !ownerAAudit.some((row) => row.id === otherAudit.id) &&
      !ownerBAudit.some((row) => row.id === recorded.id),
  );

  const adminCustomerDownload = await runCustomerRecordsExportDownload(prisma, adminAccessA);
  const memberCustomerDownload = await runCustomerRecordsExportDownload(prisma, memberAccessA);
  check(
    "Route-level ADMIN customer-records download is 403 Forbidden",
    adminCustomerDownload.ok === false &&
      adminCustomerDownload.status === 403 &&
      adminCustomerDownload.error === "Forbidden",
  );
  check(
    "Route-level MEMBER customer-records download is 403 Forbidden",
    memberCustomerDownload.ok === false &&
      memberCustomerDownload.status === 403 &&
      memberCustomerDownload.error === "Forbidden",
  );
  const ownerAuditsBeforeDownload = await prisma.settingsAuditLog.count({
    where: { businessId: businessA.id, settingKey: CUSTOMER_RECORDS_EXPORT_AUDIT_KEY },
  });
  const ownerCustomerDownload = await runCustomerRecordsExportDownload(prisma, ownerAccessA, {
    customerId: customerA.id,
  });
  const ownerCustomerBody = ownerCustomerDownload.ok ? JSON.parse(ownerCustomerDownload.body) : null;
  const ownerAuditsAfterDownload = await prisma.settingsAuditLog.count({
    where: { businessId: businessA.id, settingKey: CUSTOMER_RECORDS_EXPORT_AUDIT_KEY },
  });
  check(
    "Route-level OWNER customer-records download succeeds",
    ownerCustomerDownload.ok === true &&
      ownerCustomerDownload.status === 200 &&
      ownerCustomerBody?.customers[0]?.customer.id === customerA.id &&
      ownerCustomerBody?.customers[0]?.jobs.items[0]?.propertyId === propertyA.id &&
      ownerCustomerBody?.customers[0]?.estimates.items[0]?.total === "125.50" &&
      ownerCustomerBody?.customers[0]?.credits.items[0]?.id === creditA.id &&
      ownerCustomerBody?.customers[0]?.timeCards.items.some((row) => row.id === timeCardA.id) &&
      ownerCustomerBody?.customers[0]?.files.truncated === true &&
      !ownerCustomerDownload.body.includes(customerB.name) &&
      !ownerCustomerDownload.body.includes(projectDocKey),
  );
  check(
    "OWNER route-level download writes one new customer-records audit row",
    ownerCustomerDownload.ok === true &&
      ownerAuditsAfterDownload === ownerAuditsBeforeDownload + 1,
  );
  const afterAdminMemberCustomerAudit = await prisma.settingsAuditLog.count({
    where: {
      businessId: businessA.id,
      settingKey: CUSTOMER_RECORDS_EXPORT_AUDIT_KEY,
      changedByMembershipId: { in: [adminMemA.id, memberMemA.id] },
    },
  });
  check(
    "ADMIN and MEMBER customer-records route denials do not write an export audit",
    afterAdminMemberCustomerAudit === 0,
  );

  const memberBusinessDownload = await runBusinessExportDownload(prisma, memberAccessA);
  const adminBusinessDownload = await runBusinessExportDownload(prisma, adminAccessA);
  const ownerBusinessDownload = await runBusinessExportDownload(prisma, ownerAccessA);
  const ownerZipText = ownerBusinessDownload.ok ? ownerBusinessDownload.body.toString("utf8") : "";
  const adminZipText = adminBusinessDownload.ok ? adminBusinessDownload.body.toString("utf8") : "";
  check(
    "Route-level business ZIP lets OWNER and ADMIN retrieve tenant records; MEMBER is forbidden",
    memberBusinessDownload.ok === false &&
      memberBusinessDownload.status === 403 &&
      adminBusinessDownload.ok === true &&
      ownerBusinessDownload.ok === true &&
      ownerZipText.includes(customerA.name) &&
      ownerZipText.includes(propertyA.id) &&
      ownerZipText.includes(jobA.id) &&
      ownerZipText.includes("125.50") &&
      ownerZipText.includes("JOB") &&
      ownerZipText.includes("Installed lockset") &&
      ownerZipText.includes(timeCardA.id) &&
      !ownerZipText.includes(customerB.name) &&
      !ownerZipText.includes(timeCardB.id) &&
      !ownerZipText.includes(projectDocKey) &&
      adminZipText.includes(customerA.name) &&
      !adminZipText.includes(customerB.name),
  );
  const builtZip = await buildBusinessExportZip(prisma, businessA.id);
  const builtZipText = builtZip.bytes.toString("utf8");
  const zipEntries = readZipStoreEntries(builtZip.bytes);
  const invoicesCsv = zipEntries.find((entry) => entry.name === "invoices.csv");
  const creditsCsv = zipEntries.find((entry) => entry.name === "invoice-credits.csv");
  const timeEntriesCsv = zipEntries.find((entry) => entry.name === "time-entries.csv");
  const customersCsv = zipEntries.find((entry) => entry.name === "customers.csv");
  const invoiceRows = invoicesCsv ? parseCsv(invoicesCsv.data.toString("utf8")).records : [];
  const creditRows = creditsCsv ? parseCsv(creditsCsv.data.toString("utf8")).records : [];
  const creditedInvoiceRow = invoiceRows.find((row) => row["Invoice ID"] === creditedInvoice.id);
  check(
    "Business ZIP completeness keeps property links, estimate totals, and time-card activity",
    builtZipText.includes("propertyId") &&
      builtZipText.includes("activityType") &&
      builtZipText.includes(propertyA.id) &&
      builtZipText.includes(estimateA.id) &&
      builtZipText.includes("125.50") &&
      builtZipText.includes(timeCardA.id) &&
      builtZipText.includes("CLOCK") &&
      !builtZipText.includes(estimateToken) &&
      !builtZipText.includes(projectToken) &&
      !builtZipText.includes(stripeSession) &&
      !builtZipText.includes("Key under mat"),
  );
  check(
    "Credited SENT invoice remaining is 70.00 and the credit row is exported",
    creditedInvoiceRow?.Total === "100.00" &&
      creditedInvoiceRow?.["Amount Remaining"] === "70.00" &&
      creditedInvoiceRow?.["Payment Basis"] === "NO_RECORDED_PAYMENT" &&
      creditRows.some(
        (row) =>
          row.id === creditA.id &&
          row.invoiceId === creditedInvoice.id &&
          row.amount === "30.00" &&
          row.reason === "Owner correction",
      ) &&
      !creditRows.some((row) => row.id === creditB.id) &&
      !builtZipText.includes(creditB.id) &&
      ownerCustomerBody?.customers[0]?.credits.items.some(
        (row) => row.id === creditA.id && row.amount === "30.00",
      ) &&
      !ownerCustomerDownload.body.includes(creditB.id),
  );
  check(
    "Each Settings ZIP entry CRC matches node:zlib crc32",
    zipEntries.length > 0 &&
      zipEntries.every((entry) => entry.crc === (zlibCrc32(entry.data) >>> 0)),
  );
  const settingsZipProbe = probeZipTools(builtZip.bytes);
  check(
    "unzip -t accepts the Settings ZIP when unzip is available",
    settingsZipProbe.unzipMissing || settingsZipProbe.unzipOk,
  );
  check(
    "Python zipfile accepts the Settings ZIP when python3 is available",
    settingsZipProbe.pythonMissing || settingsZipProbe.pythonOk,
  );
  check(
    "Time-card note formula prefix is neutralized in the ZIP CSV",
    Boolean(timeEntriesCsv?.data.toString("utf8").includes(`'=cmd|' /C calc'!A0`)) &&
      neutralizeCsvFormulaPrefix(formulaNote) === "'=cmd|' /C calc'!A0",
  );
  const customersCsvText = customersCsv?.data.toString("utf8") ?? "";
  const customerRows = customersCsv ? parseCsv(customersCsvText).records : [];
  check(
    "ZIP customers.csv prefixes tab/CR formulas and quotes embedded CR",
    customersCsvText.includes("'\t=1+1") &&
      customersCsvText.includes(`"'${"\r"}=1+1"`) &&
      customersCsvText.includes(`"Line1\rLine2"`) &&
      customerRows.some((row) => row.name === "'\t=1+1" && row.id === tabFormulaCustomer.id) &&
      customerRows.some((row) => row.name === "'\r=1+1" && row.id === crFormulaCustomer.id) &&
      customerRows.some((row) => row.name === "Line1\rLine2" && row.id === embeddedCrCustomer.id) &&
      !customerRows.some((row) => row.name === "\t=1+1" || row.name === "\r=1+1"),
  );

  const unicodeEntryName = "vault-documents/id-résumé-日本.pdf";
  const unicodeZip = buildZipStore([{ name: unicodeEntryName, data: "vault-bytes" }]);
  const unicodeEntries = readZipStoreEntries(unicodeZip);
  const unicodeEntry = unicodeEntries.find((entry) => entry.name === unicodeEntryName);
  const unicodeProbe = probeZipTools(unicodeZip);
  check(
    "Non-ASCII ZIP entry names set UTF-8 flag bit 11 in local and central headers",
    ZIP_UTF8_NAME_FLAG === 0x0800 &&
      zipNameGeneralPurposeFlag(unicodeEntryName) === ZIP_UTF8_NAME_FLAG &&
      zipNameGeneralPurposeFlag("customers.csv") === 0 &&
      unicodeEntry?.localFlags === ZIP_UTF8_NAME_FLAG &&
      unicodeEntry?.centralFlags === ZIP_UTF8_NAME_FLAG &&
      zipEntries.every((entry) => entry.localFlags === 0 && entry.centralFlags === 0) &&
      (unicodeProbe.unzipMissing || unicodeProbe.unzipOk) &&
      (unicodeProbe.pythonMissing ||
        (unicodeProbe.pythonOk && unicodeProbe.pythonNames.includes(unicodeEntryName))),
  );

  const businessAuditsA = await prisma.settingsAuditLog.findMany({
    where: { businessId: businessA.id, settingKey: BUSINESS_EXPORT_AUDIT_KEY },
  });
  const businessAuditsB = await prisma.settingsAuditLog.findMany({
    where: { businessId: businessB.id, settingKey: BUSINESS_EXPORT_AUDIT_KEY },
  });
  check(
    "Business ZIP route writes tenant-scoped audit for permitted downloaders only",
    businessAuditsA.length === 2 &&
      businessAuditsA.some((row) => row.changedByMembershipId === ownerMemA.id) &&
      businessAuditsA.some((row) => row.changedByMembershipId === adminMemA.id) &&
      !businessAuditsA.some((row) => row.changedByMembershipId === memberMemA.id) &&
      businessAuditsB.length === 0 &&
      businessAuditsA.every((row) => {
        const payload = JSON.parse(row.newValue);
        return (
          row.settingArea === BUSINESS_EXPORT_AUDIT_AREA &&
          payload.filename?.startsWith("tbbt-export-") &&
          !row.newValue.includes(projectDocKey) &&
          !row.newValue.includes(estimateToken)
        );
      }),
  );

  try {
    const forgedProperty = structuredClone(single);
    forgedProperty.customers[0].properties.items[0].accessCode = "4321";
    parseCustomerRecordsExport(forgedProperty);
    check("Parser rejects property access codes", false);
  } catch (error) {
    check(
      "Parser rejects property access codes",
      error instanceof CustomerRecordsExportError && /must not include accessCode/.test(error.message),
    );
  }
  try {
    const forgedAddress = structuredClone(single);
    forgedAddress.customers[0].properties.items[0].address.entryInstructions = "Use side gate";
    parseCustomerRecordsExport(forgedAddress);
    check("Parser rejects address entry instructions", false);
  } catch (error) {
    check(
      "Parser rejects address entry instructions",
      error instanceof CustomerRecordsExportError &&
        /must not include entryInstructions/.test(error.message),
    );
  }

  try {
    parseCustomerRecordsExport({
      ...single,
      authorization: { ...single.authorization, role: "ADMIN" },
    });
    check("Parser rejects non-OWNER authorization", false);
  } catch (error) {
    check(
      "Parser rejects non-OWNER authorization",
      error instanceof CustomerRecordsExportError && /authorization.role/.test(error.message),
    );
  }
  try {
    parseCustomerRecordsExport({
      ...single,
      limits: { ...single.limits, liveSynchronization: true },
    });
    check("Parser rejects live synchronization", false);
  } catch (error) {
    check(
      "Parser rejects live synchronization",
      error instanceof CustomerRecordsExportError && /liveSynchronization/.test(error.message),
    );
  }
  try {
    const forged = structuredClone(single);
    forged.customers[0].files.items[0].url = photoUrl;
    parseCustomerRecordsExport(forged);
    check("Parser rejects private file URLs on references", false);
  } catch (error) {
    check(
      "Parser rejects private file URLs on references",
      error instanceof CustomerRecordsExportError && /must not include url/.test(error.message),
    );
  }
  try {
    const forgedTime = structuredClone(single);
    forgedTime.customers[0].timeCards.items[0].approvedHourlyWage = "25.00";
    parseCustomerRecordsExport(forgedTime);
    check("Parser rejects time-card wage fields", false);
  } catch (error) {
    check(
      "Parser rejects time-card wage fields",
      error instanceof CustomerRecordsExportError && /must not include approvedHourlyWage/.test(error.message),
    );
  }
} catch (error) {
  failures += 1;
  console.error("FAIL - unexpected customer-records export test error");
  console.error(error);
} finally {
  await session.cleanup();
}

if (failures > 0) {
  console.error(`\nCustomer-records export check failed: ${failures} issue(s).`);
  process.exit(1);
}

console.log("\nAll customer-records export checks passed.");

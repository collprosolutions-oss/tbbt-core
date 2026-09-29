/**
 * OWNER-reviewed existing-customer CSV import proofs.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-customer-csv-import.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for customer CSV import checks.");
  process.exit(generateEarly.status ?? 1);
}

const { ForbiddenError, requireBusinessRole } = await import("@/lib/authorization");
const { APP_NAV } = await import("@/lib/nav");
const { businessScope, assertBusinessRecord } = await import("@/lib/access-scope");
const {
  applySameBusinessDuplicates,
  customerImportRowFingerprint,
  CustomerCsvImportError,
  CUSTOMER_CSV_IMPORT_ROUTE,
  decodeCsvBytes,
  evaluateCustomerImportRow,
  FILE_TOO_LARGE_MESSAGE,
  IMPORT_CSV_REQUIRED_MESSAGE,
  IMPORT_NO_CONSENT_MESSAGE,
  IMPORT_NO_OUTREACH_MESSAGE,
  IMPORT_NO_OVERWRITE_MESSAGE,
  IMPORT_NO_SCORE_MESSAGE,
  IMPORT_NO_SCRAPE_MESSAGE,
  IMPORT_NOT_AVAILABLE_MESSAGE,
  IMPORT_RESOLVE_INVALID_MESSAGE,
  IMPORT_ROW_NOT_EDITABLE_MESSAGE,
  IMPORT_ROW_REJECTED_TERMINAL_MESSAGE,
  isIgnoredConsentHeader,
  MAX_CUSTOMER_CSV_IMPORT_BYTES,
  MAX_CUSTOMER_CSV_IMPORT_ROWS,
  MISSING_NAME_HEADER_MESSAGE,
  NOT_CSV_MESSAGE,
  OWNER_ONLY_CUSTOMER_IMPORT_MESSAGE,
  parseCsv,
  parseCustomerCsv,
  ROW_REJECTED_BY_OWNER_MESSAGE,
  sanitizeImportText,
  sanitizeSourceFilename,
  storedRowToParsed,
  TOO_MANY_ROWS_MESSAGE,
} = await import("@/lib/customer-csv-import");
const importModule = await import("@/lib/customer-csv-import");
const opsModule = await import("@/lib/customer-csv-import-ops");
const {
  confirmCustomerCsvImport,
  correctCustomerCsvImportRow,
  loadOwnedImport,
  previewCustomerCsvUpload,
  rejectCustomerCsvImportRow,
} = opsModule;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function readSrc(relative) {
  return readFileSync(join(root, relative), "utf8");
}

const featureFiles = [
  "src/lib/customer-csv-import-copy.ts",
  "src/lib/customer-csv-import.ts",
  "src/lib/customer-csv-import-ops.ts",
  "src/app/actions/customer-csv-import.ts",
  "src/app/(app)/customers/import/page.tsx",
  "src/app/(app)/customers/import/[importId]/page.tsx",
  "src/components/customers/import-customers-form.tsx",
  "src/components/customers/import-customers-preview.tsx",
  "src/components/customers/import-customers-row-review.tsx",
];
const featureSource = featureFiles.map(readSrc).join("\n");
const uiSource = [
  "src/app/(app)/customers/import/page.tsx",
  "src/app/(app)/customers/import/[importId]/page.tsx",
  "src/components/customers/import-customers-form.tsx",
  "src/components/customers/import-customers-preview.tsx",
  "src/components/customers/import-customers-row-review.tsx",
]
  .map(readSrc)
  .join("\n");
const opsSrc = readSrc("src/lib/customer-csv-import-ops.ts");
const actionSrc = readSrc("src/app/actions/customer-csv-import.ts");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

function isLocalDatabaseHost(hostname) {
  const host = (hostname ?? "").replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

const parsedBase = new URL(baseUrl);
if (!isLocalDatabaseHost(parsedBase.hostname)) {
  console.error(
    `customer CSV import checks refuse a remote DATABASE_URL host (${parsedBase.hostname}).`,
  );
  process.exit(1);
}

const testDbName = "tbbt_customer_csv_import_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;

const adminUrl = new URL(baseUrl);
adminUrl.search = "";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

const clients = [];
function trackClient(client) {
  clients.push(client);
  return client;
}

let prisma;
let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: { role, membership: { id: membershipId } },
    scope: businessScope(businessId),
    assertOwned(record) {
      return assertBusinessRecord(record, businessId);
    },
    assertAttachable(record) {
      return assertBusinessRecord(record, businessId);
    },
  };
}

function csv(rows) {
  return ["name,email,phone,label,street,city,region,postal", ...rows].join("\n");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function observeSettled(promise) {
  const settled = promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
  return { promise, settled };
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  timeout.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

function dedicatedClientUrl(applicationName) {
  const url = new URL(testUrl);
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("application_name", applicationName);
  return url.toString();
}

try {
  const createDb = spawnSync("psql", [adminUrl.toString(), "-c", `CREATE DATABASE "${testDbName}"`], {
    encoding: "utf8",
  });
  if (createDb.status !== 0 && !/already exists/i.test(`${createDb.stderr}${createDb.stdout}`)) {
    console.warn(createDb.stderr || createDb.stdout);
  }

  const push = spawnSync(
    "npx",
    ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
    { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
  );
  if (push.status !== 0) {
    throw new Error("Failed to push schema for customer CSV import test database.");
  }

  prisma = trackClient(new PrismaClient({ datasourceUrl: testUrl }));

  console.log("\nSTATIC — bounds, wording, isolation of shared files");
  check("File bound is 256 KB", MAX_CUSTOMER_CSV_IMPORT_BYTES === 256 * 1024);
  check("Row bound is 200", MAX_CUSTOMER_CSV_IMPORT_ROWS === 200);
  check("Dedicated route is /customers/import", CUSTOMER_CSV_IMPORT_ROUTE === "/customers/import");
  check("Owner-only copy is present", OWNER_ONLY_CUSTOMER_IMPORT_MESSAGE.includes("business owner"));
  check("No-scrape copy is present", /does not scrape/.test(IMPORT_NO_SCRAPE_MESSAGE));
  check("No-score copy is present", /does not invent a customer score/.test(IMPORT_NO_SCORE_MESSAGE));
  check("No-outreach copy is present", /does not send email, SMS/.test(IMPORT_NO_OUTREACH_MESSAGE));
  check("No-consent copy is present", /never grants or changes SMS consent/.test(IMPORT_NO_CONSENT_MESSAGE));
  check("No-overwrite copy is present", /never overwrites an existing customer/.test(IMPORT_NO_OVERWRITE_MESSAGE));
  check(
    "Global nav does not add an import destination",
    APP_NAV.every((item) => item.href !== CUSTOMER_CSV_IMPORT_ROUTE) &&
      !readSrc("src/lib/nav.ts").includes("customers/import"),
  );
  check(
    "Dashboard and growth were not used as shared entry points",
    !readSrc("src/app/(app)/dashboard/page.tsx").includes("customers/import") &&
      !readSrc("src/app/(app)/growth/page.tsx").includes("customers/import"),
  );
  check(
    "Customers page keeps the New Customer action and adds an OWNER import link",
    readSrc("src/app/(app)/customers/page.tsx").includes('<NewCustomerForm label="New Customer" />') &&
      readSrc("src/app/(app)/customers/page.tsx").includes('href="/customers/import"') &&
      readSrc("src/app/(app)/customers/page.tsx").includes('role === "OWNER"'),
  );
  check(
    "UI does not invent scores, scrape, or bought lists",
    uiSource.includes("IMPORT_NO_SCRAPE_MESSAGE") &&
      uiSource.includes("IMPORT_NO_SCORE_MESSAGE") &&
      uiSource.includes("IMPORT_NO_OUTREACH_MESSAGE") &&
      uiSource.includes("IMPORT_NO_CONSENT_MESSAGE") &&
      uiSource.includes("IMPORT_NO_OVERWRITE_MESSAGE") &&
      !/likely to convert|lead ranking|autonomous outreach/i.test(featureSource),
  );
  check(
    "Client forms do not import Node DNS/crypto modules",
    !uiSource.includes("customer-csv-import.ts") &&
      uiSource.includes("customer-csv-import-copy") &&
      !readSrc("src/lib/customer-csv-import-copy.ts").includes("node:"),
  );
  check(
    "Server-side owner CSV URL fetch is disabled",
    !featureSource.includes("fetchOwnerSuppliedCsv") &&
      !featureSource.includes("previewOwnerSourceUrl") &&
      !featureSource.includes("sourceUrl") &&
      !uiSource.includes("Owner-supplied source URL") &&
      IMPORT_CSV_REQUIRED_MESSAGE.includes("does not fetch") &&
      !("fetchOwnerSuppliedCsv" in importModule) &&
      !("previewOwnerSourceUrl" in opsModule),
  );
  check(
    "Ops require OWNER and scope every load by businessId",
    opsSrc.includes('requireBusinessRole(access, "OWNER")') &&
      opsSrc.includes("businessId: access.businessId"),
  );
  check(
    "Confirm creates customers only after explicit confirmation",
    opsSrc.includes("confirmCustomerCsvImport") &&
      actionSrc.includes("confirmCustomerCsvImport") &&
      actionSrc.includes("PRODUCT_CAPABILITIES.CRM"),
  );
  check(
    "Owner can correct or reject staged invalid rows before confirm",
    opsSrc.includes("correctCustomerCsvImportRow") &&
      opsSrc.includes("rejectCustomerCsvImportRow") &&
      actionSrc.includes("correctCustomerCsvImportRow") &&
      actionSrc.includes("rejectCustomerCsvImportRow") &&
      uiSource.includes("Save correction") &&
      uiSource.includes("Reject this row") &&
      IMPORT_RESOLVE_INVALID_MESSAGE.includes("Correct or reject") &&
      IMPORT_ROW_REJECTED_TERMINAL_MESSAGE.includes("cannot be corrected") &&
      /previewStatus:\s*"INVALID"/.test(
        opsSrc.slice(
          opsSrc.indexOf("async function persistReviewedRow"),
          opsSrc.indexOf("export type CustomerImportRowCorrectionInput"),
        ),
      ),
  );
  check(
    "Correction, rejection, and confirm do not send messages",
    !/sendEmail|sendMail|sendSms|resend|appointment-mail|appointment-notify/i.test(opsSrc) &&
      !/sendEmail|sendMail|sendSms|resend|appointment-mail|appointment-notify/i.test(actionSrc),
  );
  check(
    "Confirm never writes SMS consent or overwrites customer identity fields",
    !/smsConsentStatus\s*:/.test(opsSrc) &&
      !/smsConsentUpdatedAt\s*:/.test(opsSrc) &&
      !opsSrc.includes("customer.update") &&
      opsSrc.includes("reusedExisting = true") &&
      featureSource.includes("isIgnoredConsentHeader"),
  );
  const applyConfirmedSlice = opsSrc.slice(
    opsSrc.indexOf("async function applyConfirmedRow"),
    opsSrc.indexOf("export type ConfirmCustomerImportResult"),
  );
  check(
    "applyConfirmedRow locks the staged row with FOR UPDATE before reading createdCustomerId",
    applyConfirmedSlice.includes('FROM "CustomerCsvImportRow"') &&
      applyConfirmedSlice.includes("FOR UPDATE") &&
      applyConfirmedSlice.indexOf("FOR UPDATE") <
        applyConfirmedSlice.indexOf("if (current.createdCustomerId)"),
  );
  const harnessSrc = readSrc("scripts/check-customer-csv-import.mjs");
  check(
    "Harness refuses a remote DATABASE_URL host and drops the dedicated DB",
    harnessSrc.includes('host === "localhost"') &&
      harnessSrc.includes('host === "127.0.0.1"') &&
      harnessSrc.includes('host === "::1"') &&
      harnessSrc.includes('DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE)') &&
      !/process\.exit\(/.test(
        harnessSrc.slice(harnessSrc.indexOf("try {"), harnessSrc.lastIndexOf("process.exitCode")),
      ),
  );
  const raceSlice = harnessSrc.slice(harnessSrc.indexOf("RACE — two confirms"));
  check(
    "Race test holds the staged row lock and waits until both racers block",
    raceSlice.includes("SELECT id") &&
      raceSlice.includes('FROM "CustomerCsvImportRow"') &&
      raceSlice.includes("FOR UPDATE") &&
      raceSlice.includes("pg_stat_activity") &&
      raceSlice.includes("pg_locks") &&
      raceSlice.includes("wait_event_type") &&
      raceSlice.includes("Promise.allSettled") &&
      raceSlice.includes("observeSettled"),
  );
  check(
    "Fingerprint is stable for the same sanitized identity and address",
    customerImportRowFingerprint({
      name: "Ada",
      email: "ada@example.com",
      phone: "2393578199",
      streetAddress: "1 Main",
      unit: "",
      city: "Naples",
      region: "FL",
      postalCode: "34102",
    }) ===
      customerImportRowFingerprint({
        name: "Ada",
        email: "ada@example.com",
        phone: "2393578199",
        streetAddress: "1 Main",
        unit: "",
        city: "Naples",
        region: "FL",
        postalCode: "34102",
      }),
  );

  console.log("\nSTATIC — parse, sanitize, upload bounds");
  const quoted = parseCsv('name,street\n"Lee, Jr.","1 Main, Apt 2"');
  check(
    "CSV parser keeps quoted commas",
    quoted[1][0] === "Lee, Jr." && quoted[1][1] === "1 Main, Apt 2",
  );
  check(
    "Sanitize strips tags and control characters",
    sanitizeImportText("Ada\u0000<script>x</script> Smith", 80) === "Ada Smith",
  );
  check(
    "Filename is sanitized",
    sanitizeSourceFilename("../../bought customers!.csv") === "bought_customers_.csv",
  );
  check(
    "Consent-shaped headers are ignored",
    isIgnoredConsentHeader("sms_consent") &&
      isIgnoredConsentHeader("SMS Opt-In") &&
      isIgnoredConsentHeader("marketing_consent"),
  );
  const invalid = evaluateCustomerImportRow(2, { name: "", email: "not-an-email" });
  check("Missing name is invalid", invalid.previewStatus === "INVALID");
  const badEmail = evaluateCustomerImportRow(2, { name: "Ada", email: "not-an-email" });
  check("Invalid email is invalid", badEmail.previewStatus === "INVALID");
  const partialAddress = evaluateCustomerImportRow(2, {
    name: "Ada",
    email: "ada@example.com",
    street: "1 Main",
  });
  check("Partial property address is invalid", partialAddress.previewStatus === "INVALID");
  try {
    parseCustomerCsv("email,phone\nada@example.com,2393578199");
    check("CSV without a name column is rejected", false);
  } catch (error) {
    check("CSV without a name column is rejected", error.message === MISSING_NAME_HEADER_MESSAGE);
  }
  try {
    const many = ["name,email", ...Array.from({ length: 201 }, (_, i) => `N${i},n${i}@example.com`)].join("\n");
    parseCustomerCsv(many);
    check("Row bound rejects 201 data rows", false);
  } catch (error) {
    check("Row bound rejects 201 data rows", error.message === TOO_MANY_ROWS_MESSAGE);
  }
  try {
    decodeCsvBytes(Buffer.alloc(MAX_CUSTOMER_CSV_IMPORT_BYTES + 1));
    check("Byte bound rejects oversized buffers", false);
  } catch (error) {
    check("Byte bound rejects oversized buffers", error.message === FILE_TOO_LARGE_MESSAGE);
  }
  try {
    decodeCsvBytes(Buffer.from("<html>directory</html>"));
    check("HTML upload is rejected as not CSV", false);
  } catch (error) {
    check("HTML upload is rejected as not CSV", error.message === NOT_CSV_MESSAGE);
  }

  const withConsentColumn = parseCustomerCsv(
    [
      "name,email,phone,sms_consent,street,city,region,postal",
      "Ada,ada@example.com,2393578199,GRANTED,1 Main St,Naples,FL,34102",
    ].join("\n"),
  );
  check(
    "sms_consent column is ignored and does not invalidate a ready row",
    withConsentColumn[0].previewStatus === "VALID" &&
      withConsentColumn[0].name === "Ada" &&
      withConsentColumn[0].streetAddress === "1 Main St",
  );

  const sameBusinessDupes = applySameBusinessDuplicates(
    parseCustomerCsv(csv(["Ada,ada@example.com,2393578199,Home,1 Main St,Naples,FL,34102"])),
    [{ id: "cust-a", name: "Ada", email: "ada@example.com", phone: "2393578199" }],
  );
  check(
    "Same-business email/phone is a possible duplicate, not a score",
    sameBusinessDupes[0].previewStatus === "POSSIBLE_DUPLICATE" &&
      sameBusinessDupes[0].possibleDuplicateCustomerId === "cust-a",
  );
  const crossTenant = applySameBusinessDuplicates(
    parseCustomerCsv(csv(["Ada,ada@example.com,2393578199,Home,1 Main St,Naples,FL,34102"])),
    [],
  );
  check(
    "Other-business identities are not duplicates when omitted from the same-business set",
    crossTenant[0].previewStatus === "VALID",
  );
  const rejectedStored = storedRowToParsed({
    rowNumber: 4,
    name: "Skip",
    email: "skip@example.com",
    phone: "",
    propertyLabel: "",
    streetAddress: "",
    unit: "",
    city: "",
    region: "",
    postalCode: "",
    previewStatus: "REJECTED",
    invalidReason: ROW_REJECTED_BY_OWNER_MESSAGE,
    rowFingerprint: "abc",
  });
  check(
    "Rejected staged rows stay rejected when re-evaluated for duplicates",
    applySameBusinessDuplicates(
      [rejectedStored],
      [{ id: "cust-skip", name: "Skip", email: "skip@example.com", phone: null }],
    )[0].previewStatus === "REJECTED",
  );

  const businessA = await prisma.business.create({
    data: { name: "Alpha Customers", slug: `alpha-cci-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Customers", slug: `beta-cci-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const ownerAUser = await prisma.user.create({
    data: { name: "Olivia", email: `owner-a-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminAUser = await prisma.user.create({
    data: { name: "Ava", email: `admin-a-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberAUser = await prisma.user.create({
    data: { name: "Mia", email: `member-a-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerBUser = await prisma.user.create({
    data: { name: "Bea", email: `owner-b-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerAMem = await prisma.membership.create({
    data: { userId: ownerAUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const adminAMem = await prisma.membership.create({
    data: { userId: adminAUser.id, businessId: businessA.id, role: "ADMIN" },
  });
  const memberAMem = await prisma.membership.create({
    data: { userId: memberAUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const ownerBMem = await prisma.membership.create({
    data: { userId: ownerBUser.id, businessId: businessB.id, role: "OWNER" },
  });
  const ownerA = makeAccess(businessA.id, "OWNER", ownerAMem.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminAMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberAMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", ownerBMem.id);

  const existingAda = await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: "Existing Ada",
      email: "existing-ada@example.com",
      phone: "2395550100",
      smsConsentStatus: "GRANTED",
    },
  });
  await prisma.property.create({
    data: {
      businessId: businessA.id,
      customerId: existingAda.id,
      addressLine1: "9 Old St",
      city: "Naples",
      region: "FL",
      postalCode: "34102",
    },
  });
  await prisma.customer.create({
    data: {
      businessId: businessB.id,
      name: "Beta Ada",
      email: "ada@example.com",
      phone: "2393578199",
      smsConsentStatus: "GRANTED",
    },
  });

  console.log("\nAUTH — OWNER review only");
  try {
    requireBusinessRole(adminA, "OWNER");
    check("ADMIN fails the OWNER role floor", false);
  } catch (error) {
    check("ADMIN fails the OWNER role floor", error instanceof ForbiddenError);
  }
  try {
    await previewCustomerCsvUpload(prisma, adminA, {
      filename: "customers.csv",
      bytes: Buffer.from(csv(["Ada,ada@example.com,2393578199,Home,1 Main St,Naples,FL,34102"])),
    });
    check("ADMIN cannot preview", false);
  } catch (error) {
    check("ADMIN cannot preview", error instanceof ForbiddenError);
  }
  try {
    await previewCustomerCsvUpload(prisma, memberA, {
      filename: "customers.csv",
      bytes: Buffer.from(csv(["Ada,ada@example.com,2393578199,Home,1 Main St,Naples,FL,34102"])),
    });
    check("MEMBER cannot preview", false);
  } catch (error) {
    check("MEMBER cannot preview", error instanceof ForbiddenError);
  }

  console.log("\nPREVIEW — source, capture date, invalid, same-business duplicates");
  const mixedCsv = Buffer.from(
    [
      "name,email,phone,label,street,city,region,postal,sms_consent",
      "Ada Lovelace,ada@example.com,2393578199,Home,1 Main St,Naples,FL,34102,GRANTED",
      ",missing@example.com,2395550111,,,,,,",
      "Ada Changed,existing-ada@example.com,2395550199,New,100 New St,Naples,FL,34102,GRANTED",
    ].join("\n"),
  );
  const previewA = await previewCustomerCsvUpload(prisma, ownerA, {
    filename: "owner-customers.csv",
    bytes: mixedCsv,
  });
  check("Preview stays PREVIEW until confirm", previewA.status === "PREVIEW");
  check(
    "Preview records source label and capture date",
    previewA.sourceLabel === "owner-customers.csv" && previewA.capturedAt instanceof Date,
  );
  check(
    "Valid / invalid / duplicate counts are exact",
    previewA.validCount === 1 && previewA.invalidCount === 1 && previewA.possibleDuplicateCount === 1,
  );
  check(
    "Possible duplicate points at the same-business customer only",
    previewA.rows.some(
      (row) =>
        row.previewStatus === "POSSIBLE_DUPLICATE" &&
        row.email === "existing-ada@example.com" &&
        row.possibleDuplicateCustomerId === existingAda.id,
    ),
  );
  check(
    "Cross-tenant Beta Ada email is not a duplicate on Alpha",
    previewA.rows.find((row) => row.email === "ada@example.com")?.previewStatus === "VALID",
  );

  try {
    await confirmCustomerCsvImport(prisma, ownerA, { importId: previewA.id });
    check("Confirm is blocked while invalid rows remain", false);
  } catch (error) {
    check(
      "Confirm is blocked while invalid rows remain",
      error.message === IMPORT_RESOLVE_INVALID_MESSAGE,
    );
  }

  const invalidA = previewA.rows.find((row) => row.previewStatus === "INVALID");
  check("Mixed preview has one invalid row to resolve", Boolean(invalidA));
  const rejectedA = await rejectCustomerCsvImportRow(prisma, ownerA, {
    importId: previewA.id,
    rowId: invalidA.id,
  });
  check(
    "Owner rejection clears the invalid count without creating a customer",
    rejectedA.preview.invalidCount === 0 &&
      rejectedA.preview.rejectedCount === 1 &&
      rejectedA.preview.createdCount === 0 &&
      rejectedA.preview.rows.find((row) => row.id === invalidA.id)?.previewStatus === "REJECTED",
  );
  const rejectedAgain = await rejectCustomerCsvImportRow(prisma, ownerA, {
    importId: previewA.id,
    rowId: invalidA.id,
  });
  check("Retry reject of the same row is idempotent", rejectedAgain.reused === true);

  const previewAgain = await previewCustomerCsvUpload(prisma, ownerA, {
    filename: "owner-customers.csv",
    bytes: mixedCsv,
  });
  check("Retry of the same CSV reuses the same preview id", previewAgain.id === previewA.id);
  check(
    "Retry of the same CSV preserves the owner rejection",
    previewAgain.rows.find((row) => row.rowNumber === invalidA.rowNumber)?.previewStatus ===
      "REJECTED",
  );

  try {
    await loadOwnedImport(prisma, ownerB, previewA.id);
    check("Business B cannot load Business A preview", false);
  } catch (error) {
    check(
      "Business B cannot load Business A preview",
      error.message === IMPORT_NOT_AVAILABLE_MESSAGE,
    );
  }

  const previewB = await previewCustomerCsvUpload(prisma, ownerB, {
    filename: "owner-customers.csv",
    bytes: mixedCsv,
  });
  check("Same CSV bytes can be previewed independently per tenant", previewB.id !== previewA.id);
  check(
    "Business B flags its own Ada email as a possible duplicate",
    previewB.rows.find((row) => row.email === "ada@example.com")?.previewStatus === "POSSIBLE_DUPLICATE",
  );

  check("Preview source kind is CSV upload only", previewA.sourceKind === "CSV_UPLOAD");

  console.log("\nCONFIRM — explicit OWNER create, no silent overwrite, idempotent retry");
  const customersBeforeA = await prisma.customer.count({ where: { businessId: businessA.id } });
  const customersBeforeB = await prisma.customer.count({ where: { businessId: businessB.id } });
  const propertiesBeforeA = await prisma.property.count({ where: { businessId: businessA.id } });

  try {
    await confirmCustomerCsvImport(prisma, ownerB, { importId: previewA.id });
    check("Business B cannot confirm Business A preview", false);
  } catch (error) {
    check(
      "Business B cannot confirm Business A preview",
      error.message === IMPORT_NOT_AVAILABLE_MESSAGE,
    );
  }
  try {
    await confirmCustomerCsvImport(prisma, adminA, { importId: previewA.id });
    check("ADMIN cannot confirm", false);
  } catch (error) {
    check("ADMIN cannot confirm", error instanceof ForbiddenError);
  }

  const confirmed = await confirmCustomerCsvImport(prisma, ownerA, { importId: previewA.id });
  const createdAda = await prisma.customer.findFirst({
    where: { businessId: businessA.id, email: "ada@example.com" },
    include: { properties: true },
  });
  const existingAfterDefault = await prisma.customer.findFirst({
    where: { id: existingAda.id },
  });
  check("Confirm creates only the ready row by default", confirmed.preview.createdCount === 1);
  check("Created customer stays on tenant A", createdAda?.businessId === businessA.id);
  check(
    "New imported customer stays UNKNOWN for SMS consent even when CSV said GRANTED",
    createdAda?.smsConsentStatus === "UNKNOWN",
  );
  check(
    "Ready row created the property on the new customer",
    createdAda?.properties.some((property) => property.addressLine1 === "1 Main St") === true,
  );
  check(
    "Default confirm does not create an extra A customer for the duplicate",
    (await prisma.customer.count({ where: { businessId: businessA.id } })) === customersBeforeA + 1,
  );
  check(
    "Default confirm does not attach the duplicate property",
    (await prisma.property.count({ where: { businessId: businessA.id } })) === propertiesBeforeA + 1,
  );
  check(
    "Existing customer name, phone, and GRANTED consent stay untouched without include",
    existingAfterDefault?.name === "Existing Ada" &&
      existingAfterDefault?.phone === "2395550100" &&
      existingAfterDefault?.smsConsentStatus === "GRANTED",
  );
  check(
    "Business B customer count is unchanged by A's confirm",
    (await prisma.customer.count({ where: { businessId: businessB.id } })) === customersBeforeB,
  );

  const confirmedAgain = await confirmCustomerCsvImport(prisma, ownerA, { importId: previewA.id });
  check("Retry confirm is idempotent", confirmedAgain.reused === true);
  check(
    "Retry confirm does not create a second customer",
    (await prisma.customer.count({ where: { businessId: businessA.id } })) === customersBeforeA + 1,
  );
  check(
    "Retry confirm does not create a second property",
    (await prisma.property.count({ where: { businessId: businessA.id } })) === propertiesBeforeA + 1,
  );

  const invalidB = previewB.rows.find((row) => row.previewStatus === "INVALID");
  await rejectCustomerCsvImportRow(prisma, ownerB, {
    importId: previewB.id,
    rowId: invalidB.id,
  });
  const betaAdaBefore = await prisma.customer.findFirst({
    where: { businessId: businessB.id, email: "ada@example.com" },
  });
  const withDupes = await confirmCustomerCsvImport(prisma, ownerB, {
    importId: previewB.id,
    includePossibleDuplicates: true,
  });
  const betaAdaAfter = await prisma.customer.findFirst({
    where: { id: betaAdaBefore.id },
    include: { properties: true },
  });
  check(
    "OWNER B may explicitly include same-business duplicates for B only",
    withDupes.preview.rows
      .filter(
        (row) =>
          row.previewStatus === "VALID" || row.previewStatus === "POSSIBLE_DUPLICATE",
      )
      .every((row) => row.createdCustomerId) &&
      withDupes.preview.rows
        .filter((row) => row.previewStatus === "REJECTED")
        .every((row) => !row.createdCustomerId),
  );
  check(
    "Included B duplicate reuses Beta Ada and does not overwrite name or consent",
    betaAdaAfter?.name === "Beta Ada" &&
      betaAdaAfter?.phone === "2393578199" &&
      betaAdaAfter?.smsConsentStatus === "GRANTED" &&
      betaAdaAfter?.properties.some((property) => property.addressLine1 === "1 Main St") === true,
  );
  check(
    "B confirm still creates no A rows",
    (await prisma.customer.count({ where: { businessId: businessA.id } })) === customersBeforeA + 1,
  );

  console.log("\nOVERWRITE — include-duplicate attaches property only");
  const includeCsv = Buffer.from(
    [
      "name,email,phone,label,street,city,region,postal,sms_consent",
      "Ada Changed,existing-ada@example.com,2395550199,New,100 New St,Naples,FL,34102,GRANTED",
    ].join("\n"),
  );
  const includePreview = await previewCustomerCsvUpload(prisma, ownerA, {
    filename: "include-existing.csv",
    bytes: includeCsv,
  });
  check(
    "Second file against Existing Ada is previewed as a possible duplicate",
    includePreview.possibleDuplicateCount === 1 && includePreview.validCount === 0,
  );
  const includeConfirm = await confirmCustomerCsvImport(prisma, ownerA, {
    importId: includePreview.id,
    includePossibleDuplicates: true,
  });
  const existingAfterInclude = await prisma.customer.findFirst({
    where: { id: existingAda.id },
    include: { properties: { orderBy: { createdAt: "asc" } } },
  });
  check(
    "Included duplicate reuses the existing customer id",
    includeConfirm.preview.rows[0]?.createdCustomerId === existingAda.id &&
      includeConfirm.preview.rows[0]?.reusedExistingCustomer === true,
  );
  check(
    "Included duplicate never overwrites name, phone, or SMS consent",
    existingAfterInclude?.name === "Existing Ada" &&
      existingAfterInclude?.phone === "2395550100" &&
      existingAfterInclude?.email === "existing-ada@example.com" &&
      existingAfterInclude?.smsConsentStatus === "GRANTED",
  );
  check(
    "Included duplicate attaches only the new property",
    existingAfterInclude?.properties.length === 2 &&
      existingAfterInclude?.properties.some((property) => property.addressLine1 === "9 Old St") ===
        true &&
      existingAfterInclude?.properties.some((property) => property.addressLine1 === "100 New St") ===
        true,
  );

  const includeAgain = await confirmCustomerCsvImport(prisma, ownerA, {
    importId: includePreview.id,
    includePossibleDuplicates: true,
  });
  check("Retry of included-duplicate confirm is idempotent", includeAgain.reused === true);
  check(
    "Retry of included-duplicate confirm does not add another property",
    (await prisma.property.count({ where: { customerId: existingAda.id, businessId: businessA.id } })) ===
      2,
  );

  console.log("\nREVIEW — correct invalid rows, reject, retry, no messages");
  const reviewCsv = Buffer.from(
    [
      "name,email,phone,street,city,region,postal",
      ",bad-email,2395550112,1 Review St,Naples,FL,34102",
    ].join("\n"),
  );
  const reviewPreview = await previewCustomerCsvUpload(prisma, ownerA, {
    filename: "review-customers.csv",
    bytes: reviewCsv,
  });
  const reviewInvalid = reviewPreview.rows.find((row) => row.previewStatus === "INVALID");
  const stillInvalid = await correctCustomerCsvImportRow(prisma, ownerA, {
    importId: reviewPreview.id,
    rowId: reviewInvalid.id,
    name: "",
    email: "still-bad",
    phone: "2395550112",
    street: "1 Review St",
    city: "Naples",
    region: "FL",
    postal: "34102",
  });
  check(
    "Correction that stays invalid remains staged",
    stillInvalid.rows[0]?.previewStatus === "INVALID",
  );
  const corrected = await correctCustomerCsvImportRow(prisma, ownerA, {
    importId: reviewPreview.id,
    rowId: reviewInvalid.id,
    name: "Review Ada",
    email: "review-ada@example.com",
    phone: "2395550112",
    street: "1 Review St",
    city: "Naples",
    region: "FL",
    postal: "34102",
  });
  check(
    "Owner correction can make a staged row ready",
    corrected.invalidCount === 0 &&
      corrected.rows[0]?.previewStatus === "VALID" &&
      corrected.rows[0]?.name === "Review Ada",
  );

  const confirmedReview = await confirmCustomerCsvImport(prisma, ownerA, {
    importId: reviewPreview.id,
  });
  const reviewCustomer = await prisma.customer.findFirst({
    where: { businessId: businessA.id, email: "review-ada@example.com" },
  });
  check(
    "Corrected row creates a customer only after confirm",
    Boolean(reviewCustomer) &&
      reviewCustomer.smsConsentStatus === "UNKNOWN" &&
      confirmedReview.preview.createdCount === 1,
  );

  try {
    await correctCustomerCsvImportRow(prisma, ownerA, {
      importId: reviewPreview.id,
      rowId: reviewInvalid.id,
      name: "Too Late",
    });
    check("Correction is closed after confirm", false);
  } catch (error) {
    check(
      "Correction is closed after confirm",
      error.message === "This preview was already confirmed." ||
        error.message === IMPORT_ROW_NOT_EDITABLE_MESSAGE,
    );
  }

  const rejectReviewCsv = Buffer.from(
    ["name,email", ",not-an-email"].join("\n"),
  );
  const rejectPreview = await previewCustomerCsvUpload(prisma, ownerA, {
    filename: "reject-customers.csv",
    bytes: rejectReviewCsv,
  });
  const rejectRow = rejectPreview.rows[0];
  const rejectedReview = await rejectCustomerCsvImportRow(prisma, ownerA, {
    importId: rejectPreview.id,
    rowId: rejectRow.id,
  });
  check(
    "Rejected review row is terminal",
    rejectedReview.preview.rows[0]?.previewStatus === "REJECTED",
  );
  try {
    await correctCustomerCsvImportRow(prisma, ownerA, {
      importId: rejectPreview.id,
      rowId: rejectRow.id,
      name: "Should Fail",
      email: "ok@example.com",
    });
    check("Rejected rows cannot be corrected", false);
  } catch (error) {
    check(
      "Rejected rows cannot be corrected",
      error.message === IMPORT_ROW_REJECTED_TERMINAL_MESSAGE,
    );
  }
  try {
    await correctCustomerCsvImportRow(prisma, adminA, {
      importId: rejectPreview.id,
      rowId: rejectRow.id,
      name: "Admin",
    });
    check("ADMIN cannot correct", false);
  } catch (error) {
    check("ADMIN cannot correct", error instanceof ForbiddenError);
  }
  try {
    await rejectCustomerCsvImportRow(prisma, memberA, {
      importId: rejectPreview.id,
      rowId: rejectRow.id,
    });
    check("MEMBER cannot reject", false);
  } catch (error) {
    check("MEMBER cannot reject", error instanceof ForbiddenError);
  }
  try {
    await correctCustomerCsvImportRow(prisma, ownerB, {
      importId: rejectPreview.id,
      rowId: rejectRow.id,
      name: "Beta",
    });
    check("Business B cannot correct Business A preview", false);
  } catch (error) {
    check(
      "Business B cannot correct Business A preview",
      error.message === IMPORT_NOT_AVAILABLE_MESSAGE,
    );
  }

  console.log("\nBATCH — same-file identity creates one customer and two properties");
  const batchCsv = Buffer.from(
    [
      "name,email,phone,label,street,city,region,postal",
      "Pat,pat@example.com,2395550188,Home,10 Oak St,Naples,FL,34102",
      "Pat,pat@example.com,2395550188,Shop,20 Pine St,Naples,FL,34102",
    ].join("\n"),
  );
  const batchPreview = await previewCustomerCsvUpload(prisma, ownerA, {
    filename: "batch-properties.csv",
    bytes: batchCsv,
  });
  check(
    "Same-file email without an existing customer stays ready on both rows",
    batchPreview.validCount === 2 && batchPreview.possibleDuplicateCount === 0,
  );
  await confirmCustomerCsvImport(prisma, ownerA, { importId: batchPreview.id });
  const pat = await prisma.customer.findMany({
    where: { businessId: businessA.id, email: "pat@example.com" },
    include: { properties: true },
  });
  check("Same-file identity creates exactly one customer", pat.length === 1);
  check(
    "Same-file identity attaches both distinct properties",
    pat[0]?.properties.length === 2 &&
      pat[0]?.properties.some((property) => property.addressLine1 === "10 Oak St") &&
      pat[0]?.properties.some((property) => property.addressLine1 === "20 Pine St"),
  );
  check("Same-file customer stays UNKNOWN for SMS consent", pat[0]?.smsConsentStatus === "UNKNOWN");

  console.log("\nRACE — two confirms at once create one customer and one property");
  const raceCsv = Buffer.from(
    [
      "name,email,phone,label,street,city,region,postal",
      "Race Ada,race-ada@example.com,2395550333,Home,33 Race St,Naples,FL,34102",
    ].join("\n"),
  );
  const racePreview = await previewCustomerCsvUpload(prisma, ownerA, {
    filename: "race-confirm.csv",
    bytes: raceCsv,
  });
  check(
    "Race preview has one ready row and no existing same-business customer",
    racePreview.validCount === 1 &&
      racePreview.possibleDuplicateCount === 0 &&
      racePreview.rows[0]?.createdCustomerId == null,
  );

  const raceRowId = racePreview.rows[0]?.id;
  check("Race row is staged for the lock-holder confirm", Boolean(raceRowId));

  const RACE_HOLDER_APP = "tbbt-csv-import-race-holder";
  const RACE_RACER_A_APP = "tbbt-csv-import-racer-a";
  const RACE_RACER_B_APP = "tbbt-csv-import-racer-b";
  const holder = trackClient(
    new PrismaClient({ datasourceUrl: dedicatedClientUrl(RACE_HOLDER_APP) }),
  );
  const racerA = trackClient(
    new PrismaClient({ datasourceUrl: dedicatedClientUrl(RACE_RACER_A_APP) }),
  );
  const racerB = trackClient(
    new PrismaClient({ datasourceUrl: dedicatedClientUrl(RACE_RACER_B_APP) }),
  );
  await holder.$executeRaw`SELECT set_config('application_name', ${RACE_HOLDER_APP}, false)`;
  await racerA.$executeRaw`SELECT set_config('application_name', ${RACE_RACER_A_APP}, false)`;
  await racerB.$executeRaw`SELECT set_config('application_name', ${RACE_RACER_B_APP}, false)`;

  let releaseHolderLock = () => {};
  const holderReleased = new Promise((resolve) => {
    releaseHolderLock = resolve;
  });
  let signalHolderLocked = () => {};
  const holderLocked = new Promise((resolve) => {
    signalHolderLocked = resolve;
  });
  const holderState = { pid: null };
  const holderObserved = observeSettled(
    holder.$transaction(
      async (tx) => {
        const pidRows = await tx.$queryRaw`SELECT pg_backend_pid()::int AS pid`;
        holderState.pid = pidRows[0]?.pid ?? null;
        const locked = await tx.$queryRaw`
          SELECT id
          FROM "CustomerCsvImportRow"
          WHERE id = ${raceRowId}
            AND "businessId" = ${businessA.id}
          FOR UPDATE
        `;
        if (!locked[0]?.id) {
          throw new Error("holder could not lock the race CustomerCsvImportRow");
        }
        signalHolderLocked();
        await holderReleased;
      },
      { maxWait: 5_000, timeout: 30_000 },
    ),
  );

  let raceResults = [];
  try {
    await withTimeout(holderLocked, 5_000, "holder FOR UPDATE");
    const racerAObserved = observeSettled(
      confirmCustomerCsvImport(racerA, ownerA, { importId: racePreview.id }),
    );
    const racerBObserved = observeSettled(
      confirmCustomerCsvImport(racerB, ownerA, { importId: racePreview.id }),
    );

    const waitDeadline = Date.now() + 10_000;
    let waitingCount = 0;
    while (Date.now() < waitDeadline) {
      const waited = await prisma.$queryRaw`
        SELECT COUNT(DISTINCT a.pid)::int AS n
        FROM pg_stat_activity a
        JOIN pg_locks w ON w.pid = a.pid AND NOT w.granted
        JOIN pg_locks h
          ON h.granted
         AND h.pid = ${holderState.pid}
         AND h.locktype = w.locktype
         AND h.database IS NOT DISTINCT FROM w.database
         AND h.relation IS NOT DISTINCT FROM w.relation
         AND h.page IS NOT DISTINCT FROM w.page
         AND h.tuple IS NOT DISTINCT FROM w.tuple
         AND h.virtualxid IS NOT DISTINCT FROM w.virtualxid
         AND h.transactionid IS NOT DISTINCT FROM w.transactionid
         AND h.classid IS NOT DISTINCT FROM w.classid
         AND h.objid IS NOT DISTINCT FROM w.objid
         AND h.objsubid IS NOT DISTINCT FROM w.objsubid
        WHERE a.datname = current_database()
          AND a.wait_event_type = 'Lock'
          AND a.application_name IN (${RACE_RACER_A_APP}, ${RACE_RACER_B_APP})
      `;
      waitingCount = waited[0]?.n ?? 0;
      if (waitingCount >= 2) break;
      await delay(25);
    }
    check(
      "Both racers wait on the held CustomerCsvImportRow lock",
      waitingCount >= 2,
    );
    if (waitingCount < 2) {
      throw new Error(
        `Expected both racers to wait on the held row lock (wait_event_type=Lock); saw ${waitingCount}`,
      );
    }

    releaseHolderLock();
    await withTimeout(holderObserved.settled, 5_000, "holder release");
    raceResults = await withTimeout(
      Promise.allSettled([racerAObserved.promise, racerBObserved.promise]),
      15_000,
      "concurrent confirms",
    );
  } finally {
    releaseHolderLock();
    await holderObserved.settled.catch(() => {});
  }
  check(
    "Both concurrent confirms settle and are observed",
    raceResults.length === 2 && raceResults.every((result) => result.status === "fulfilled"),
  );
  const raceCustomers = await prisma.customer.findMany({
    where: { businessId: businessA.id, email: "race-ada@example.com" },
    include: { properties: true },
  });
  check("Concurrent confirms create exactly one customer", raceCustomers.length === 1);
  check(
    "Concurrent confirms create exactly one property for that row",
    raceCustomers[0]?.properties.length === 1 &&
      raceCustomers[0].properties[0]?.addressLine1 === "33 Race St" &&
      raceCustomers[0].properties[0]?.businessId === businessA.id,
  );
  const raceRowAfter = await prisma.customerCsvImportRow.findFirst({
    where: { importId: racePreview.id, businessId: businessA.id },
  });
  check(
    "Both racers reuse the same created customer and property ids",
    raceRowAfter?.createdCustomerId === raceCustomers[0]?.id &&
      raceRowAfter?.createdPropertyId === raceCustomers[0]?.properties[0]?.id &&
      raceResults
        .filter((result) => result.status === "fulfilled")
        .every((result) => result.value.createdCustomerIds[0] === raceCustomers[0]?.id),
  );

  console.log("\nCustomer CSV import check complete.");
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  for (const client of clients) {
    await client.$disconnect().catch(() => {});
  }
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE)`);
  } finally {
    await cleanup.$disconnect().catch(() => {});
  }
}

if (failures > 0) {
  console.error(`\n${failures} customer CSV import check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("All customer CSV import checks passed.");
}

/**
 * OWNER-reviewed service catalog CSV import proofs.
 *
 * Proves authorization, tenant isolation, duplicate-name handling,
 * historical estimate-line preservation, retry safety, and size bounds
 * on a dedicated test database.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-service-catalog-import.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function isLocalDatabaseHost(urlString) {
  let parsedUrl;
  try {
    parsedUrl = new URL(urlString);
  } catch {
    try {
      parsedUrl = new URL(urlString.replace(/@\//, "@localhost/"));
    } catch {
      return false;
    }
  }
  const protocol = parsedUrl.protocol.replace(/:$/, "").toLowerCase();
  if (protocol !== "postgres" && protocol !== "postgresql") return false;
  const hostParam = (parsedUrl.searchParams.get("host") || "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (hostParam) {
    return (
      hostParam === "localhost" ||
      hostParam === "127.0.0.1" ||
      hostParam === "::1" ||
      hostParam.startsWith("/")
    );
  }
  const host = (parsedUrl.hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  if (host.startsWith("/")) return true;
  return !host;
}

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}
if (!isLocalDatabaseHost(baseUrl)) {
  console.error(
    "Refusing pg_terminate_backend / DROP DATABASE / prisma migrate deploy: DATABASE_URL host is not localhost, 127.0.0.1, ::1, or a local socket. Preview shares Production's DATABASE_URL.",
  );
  process.exit(1);
}

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for service catalog import checks.");
  process.exit(generateEarly.status ?? 1);
}

const { ForbiddenError, requireBusinessRole } = await import("@/lib/authorization");
const { APP_NAV } = await import("@/lib/nav");
const { businessScope, assertBusinessRecord } = await import("@/lib/access-scope");
const { isHourlyUnitLabel } = await import("@/lib/estimate-calculators/unit-registry");
const { PRICING_MODES } = await import("@/lib/pricing-mode");
const {
  applyCatalogImportContext,
  CATALOG_IMPORT_ALREADY_CONFIRMED_MESSAGE,
  CATALOG_IMPORT_CSV_REQUIRED_MESSAGE,
  CATALOG_IMPORT_EMPTY_MESSAGE,
  CATALOG_IMPORT_FILE_TOO_LARGE_MESSAGE,
  CATALOG_IMPORT_CONFIRMING_LEASE_MS,
  CATALOG_IMPORT_IN_PROGRESS_MESSAGE,
  CATALOG_IMPORT_MISSING_NAME_HEADER_MESSAGE,
  CATALOG_IMPORT_NAME_MATCH_MESSAGE,
  CATALOG_IMPORT_NO_HISTORY_REWRITE_MESSAGE,
  CATALOG_IMPORT_NO_HOURLY_MESSAGE,
  CATALOG_IMPORT_NOT_AVAILABLE_MESSAGE,
  CATALOG_IMPORT_NOT_CSV_MESSAGE,
  CATALOG_IMPORT_PRICE_REQUIRED_MESSAGE,
  CATALOG_IMPORT_PRICING_MODE_REQUIRED_MESSAGE,
  CATALOG_IMPORT_RESOLVE_INVALID_MESSAGE,
  CATALOG_IMPORT_STALE_MATCHES_MESSAGE,
  CATALOG_IMPORT_TOO_MANY_ROWS_MESSAGE,
  isCatalogImportConfirmingLeaseStale,
  catalogImportOverLengthMessage,
  catalogImportRowFingerprint,
  catalogRowBecameStale,
  catalogNameKey,
  decodeCatalogCsvBytes,
  evaluateCatalogImportRow,
  hashCatalogCsvBytes,
  MAX_SERVICE_CATALOG_IMPORT_BYTES,
  MAX_SERVICE_CATALOG_IMPORT_CATEGORY,
  MAX_SERVICE_CATALOG_IMPORT_DESCRIPTION,
  MAX_SERVICE_CATALOG_IMPORT_NAME,
  MAX_SERVICE_CATALOG_IMPORT_ROWS,
  MAX_SERVICE_CATALOG_IMPORT_UNIT,
  OWNER_ONLY_CATALOG_IMPORT_MESSAGE,
  parseCatalogCsv,
  parseCatalogPricingMode,
  pickDeterministicCatalogMatch,
  parseServiceCatalogCsv,
  sanitizeCatalogImportText,
  sanitizeCatalogSourceFilename,
  SERVICE_CATALOG_IMPORT_ROUTE,
  ServiceCatalogImportError,
} = await import("@/lib/service-catalog-import");
const importModule = await import("@/lib/service-catalog-import");
const opsModule = await import("@/lib/service-catalog-import-ops");
const {
  confirmServiceCatalogImport,
  loadOwnedCatalogImport,
  previewServiceCatalogCsvUpload,
} = opsModule;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function readSrc(relative) {
  return readFileSync(join(root, relative), "utf8");
}

const featureFiles = [
  "src/lib/service-catalog-import-copy.ts",
  "src/lib/service-catalog-import.ts",
  "src/lib/service-catalog-import-ops.ts",
  "src/app/actions/service-catalog-import.ts",
  "src/app/(app)/services/import-catalog/page.tsx",
  "src/app/(app)/services/import-catalog/[importId]/page.tsx",
  "src/components/catalog/import-catalog-form.tsx",
  "src/components/catalog/import-catalog-preview.tsx",
];
const featureSource = featureFiles.map(readSrc).join("\n");
const uiSource = [
  "src/app/(app)/services/import-catalog/page.tsx",
  "src/app/(app)/services/import-catalog/[importId]/page.tsx",
  "src/components/catalog/import-catalog-form.tsx",
  "src/components/catalog/import-catalog-preview.tsx",
]
  .map(readSrc)
  .join("\n");
const opsSource = readSrc("src/lib/service-catalog-import-ops.ts");
const parseSource = readSrc("src/lib/service-catalog-import.ts");
const previewUiSource = readSrc("src/components/catalog/import-catalog-preview.tsx");
const formSource = readSrc("src/components/catalog/import-catalog-form.tsx");
const migrationSource = readSrc(
  "prisma/migrations/20260929010200_service_catalog_import/migration.sql",
);
const scriptSource = readSrc("scripts/check-service-catalog-import.mjs");

const testDbName = "tbbt_service_catalog_import_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

async function dropTestDatabase() {
  const { PrismaClient: AdminPrisma } = createRequire(import.meta.url)("@prisma/client");
  const admin = new AdminPrisma({ datasourceUrl: baseUrl });
  try {
    await admin.$queryRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      testDbName,
    );
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await admin.$disconnect();
  }
}

await dropTestDatabase();
{
  const { PrismaClient: AdminPrisma } = createRequire(import.meta.url)("@prisma/client");
  const admin = new AdminPrisma({ datasourceUrl: baseUrl });
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${testDbName}"`);
  } finally {
    await admin.$disconnect();
  }
}

const migrate = spawnSync("npx", ["prisma", "migrate", "deploy"], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: testUrl },
});
if (migrate.status !== 0) {
  console.error("Failed to migrate the service catalog import test database.");
  await dropTestDatabase();
  process.exit(migrate.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

async function expectError(label, fn, predicate) {
  try {
    await fn();
    console.error(`FAIL - ${label} (no error thrown)`);
    failures += 1;
  } catch (error) {
    if (predicate(error)) {
      console.log(`  ok  - ${label}`);
    } else {
      console.error(`FAIL - ${label}`, error);
      failures += 1;
    }
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
  return [
    "name,description,pricingMode,price,category,tradeCode,unitLabel,recurrenceEligible,active",
    ...rows,
  ].join("\n");
}

try {
  console.log("\nSTATIC — bounds, wording, files, limits");
  check("File bound is 256 KB", MAX_SERVICE_CATALOG_IMPORT_BYTES === 256 * 1024);
  check("Row bound is 200", MAX_SERVICE_CATALOG_IMPORT_ROWS === 200);
  check(
    "Dedicated route is /services/import-catalog",
    SERVICE_CATALOG_IMPORT_ROUTE === "/services/import-catalog",
  );
  check(
    "Owner-only copy is present",
    OWNER_ONLY_CATALOG_IMPORT_MESSAGE.includes("business owner"),
  );
  check(
    "Hourly-rate refusal copy is present",
    CATALOG_IMPORT_NO_HOURLY_MESSAGE.includes("hourly rates"),
  );
  check(
    "Historical estimate preservation copy is present",
    CATALOG_IMPORT_NO_HISTORY_REWRITE_MESSAGE.includes("Historical estimate lines"),
  );
  check(
    "Duplicate-name copy is present",
    CATALOG_IMPORT_NAME_MATCH_MESSAGE.includes("name matches"),
  );
  check(
    "Global nav does not add an import destination",
    APP_NAV.every((item) => item.href !== SERVICE_CATALOG_IMPORT_ROUTE) &&
      !readSrc("src/lib/nav.ts").includes("import-catalog"),
  );
  check(
    "Client forms do not import Node crypto modules",
    !uiSource.includes("service-catalog-import.ts") &&
      uiSource.includes("service-catalog-import-copy") &&
      !readSrc("src/lib/service-catalog-import-copy.ts").includes("node:"),
  );
  check(
    "Ops require OWNER and scope every load by businessId",
    opsSource.includes('requireBusinessRole(access, "OWNER")') &&
      opsSource.includes("businessId: access.businessId"),
  );
  check(
    "Confirm writes ServiceCatalogItem only after explicit confirmation",
    opsSource.includes("confirmServiceCatalogImport") &&
      readSrc("src/app/actions/service-catalog-import.ts").includes(
        "confirmServiceCatalogImport",
      ) &&
      opsSource.includes("serviceCatalogItem.create") &&
      opsSource.includes("serviceCatalogItem.update"),
  );
  check(
    "Ops never write LineItem or EstimateVersionLineItem",
    !opsSource.includes("lineItem.") &&
      !opsSource.includes("lineItem.create") &&
      !opsSource.includes("lineItem.update") &&
      !opsSource.includes("estimateVersionLineItem"),
  );
  check(
    "Feature files do not publish hourly rates",
    !/pricingMode:\s*"HOURLY"/.test(featureSource) &&
      featureSource.includes("CATALOG_IMPORT_NO_HOURLY_MESSAGE") &&
      isHourlyUnitLabel("hour") &&
      !PRICING_MODES.includes("HOURLY"),
  );
  check(
    "Migration is additive and names the LineItem / hourly bounds",
    migrationSource.includes("CREATE TABLE IF NOT EXISTS") &&
      !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migrationSource) &&
      migrationSource.includes("never LineItem") &&
      migrationSource.includes("hourly"),
  );
  check(
    "Exact feature files are the dedicated catalog CSV slice",
    featureFiles.every((file) => readSrc(file).length > 0) &&
      readSrc("package.json").includes("test:service-catalog-import"),
  );
  check(
    "Server-side owner CSV URL fetch is disabled",
    !featureSource.includes("fetchOwnerSuppliedCsv") &&
      !featureSource.includes("sourceUrl") &&
      !featureSource.includes("node:dns") &&
      CATALOG_IMPORT_CSV_REQUIRED_MESSAGE.includes("does not fetch") &&
      !("fetchOwnerSuppliedCsv" in importModule) &&
      !("previewOwnerSourceUrl" in opsModule),
  );
  check(
    "Name-match copy says update-only and blank cells keep existing values",
    CATALOG_IMPORT_NAME_MATCH_MESSAGE.includes("only when you pick update") &&
      CATALOG_IMPORT_NAME_MATCH_MESSAGE.includes("Blank cells keep") &&
      previewUiSource.includes('value="SKIP"') &&
      previewUiSource.includes('value="UPDATE"') &&
      previewUiSource.includes('value="ADD_NEW"') &&
      previewUiSource.includes("matchDecision:${row.rowNumber}") &&
      previewUiSource.includes("Current") &&
      previewUiSource.includes("Incoming") &&
      previewUiSource.includes("Keep existing"),
  );
  check(
    "Upload form requires pricingMode and price except Custom Quote",
    formSource.includes("pricingMode is required") &&
      formSource.includes("price is required except for Custom Quote") &&
      CATALOG_IMPORT_PRICING_MODE_REQUIRED_MESSAGE.includes("pricingMode is required") &&
      CATALOG_IMPORT_PRICE_REQUIRED_MESSAGE.includes("except for Custom Quote"),
  );
  check(
    "Confirm claims with a lease and writes every row in one transaction",
    opsSource.includes("confirmingAt") &&
      opsSource.includes("pg_advisory_xact_lock") &&
      opsSource.includes("CATALOG_IMPORT_CONFIRM_FAILED_MESSAGE") &&
      opsSource.includes("writeEligibleRow") &&
      opsSource.includes("claimed.count !== 1") &&
      opsSource.includes("finished.count !== 1"),
  );
  check(
    "Confirm rematches live catalog and recovers only stale CONFIRMING leases",
    opsSource.includes("catalogRowBecameStale") &&
      opsSource.includes("CATALOG_IMPORT_STALE_MATCHES_MESSAGE") &&
      opsSource.includes("isCatalogImportConfirmingLeaseStale") &&
      opsSource.includes("refreshPreviewMatchesTx") &&
      opsSource.includes("$transaction"),
  );
  check(
    "P2002 websiteSlug maps to a readable conflict",
    opsSource.includes("P2002") &&
      opsSource.includes("CATALOG_IMPORT_SLUG_CONFLICT_MESSAGE"),
  );
  check(
    "Matching is deterministic by createdAt then id",
    parseSource.includes("pickDeterministicCatalogMatch") &&
      parseSource.includes("createdAt") &&
      typeof pickDeterministicCatalogMatch === "function",
  );
  const generateAt = scriptSource.indexOf('spawnSync("npx", ["prisma", "generate"]');
  const terminateAt = scriptSource.indexOf("pg_terminate_backend");
  const dropAt = scriptSource.indexOf("DROP DATABASE");
  const migrateAt = scriptSource.indexOf('["prisma", "migrate", "deploy"]');
  const guardAt = scriptSource.indexOf("isLocalDatabaseHost(baseUrl)");
  check(
    "Destructive test DB steps refuse unless DATABASE_URL is local, before Prisma",
    guardAt > 0 &&
      generateAt > guardAt &&
      terminateAt > guardAt &&
      dropAt > guardAt &&
      migrateAt > guardAt &&
      scriptSource.includes('["prisma", "migrate", "deploy"]') &&
      scriptSource.includes("dropTestDatabase") &&
      isLocalDatabaseHost("postgresql://tbbt:tbbt@127.0.0.1:5432/tbbt") &&
      isLocalDatabaseHost("postgresql://tbbt:tbbt@/tbbt?host=/var/run/postgresql") &&
      !isLocalDatabaseHost("postgresql://tbbt:tbbt@/tbbt?host=db.example.com") &&
      !isLocalDatabaseHost("postgresql://tbbt:tbbt@127.0.0.1/tbbt?host=db.example.com") &&
      !isLocalDatabaseHost("postgresql://tbbt:tbbt@db.example.com:5432/tbbt"),
  );
  check(
    "Migration timestamp is 20260929010200 and names matchDecision skip default",
    migrationSource.includes("20260929010200") &&
      migrationSource.includes('"matchDecision" TEXT NOT NULL DEFAULT \'SKIP\'') &&
      scriptSource.includes("20260929010200_service_catalog_import/migration.sql"),
  );

  console.log("\nSTATIC — parse, sanitize, upload bounds");
  const quoted = parseCatalogCsv('name,description\n"Fan, 52""","Replace, now"');
  check(
    "CSV parser keeps quoted commas",
    quoted[1][0] === 'Fan, 52"' && quoted[1][1] === "Replace, now",
  );
  check(
    "Sanitize strips tags and control characters without truncating",
    sanitizeCatalogImportText("Fan\u0000<script>x</script> Swap") === "Fan Swap" &&
      parseSource.includes("catalogImportFieldOverLength") &&
      !/export function sanitizeCatalogImportText\([^)]*max/.test(parseSource),
  );
  const longName = "N".repeat(MAX_SERVICE_CATALOG_IMPORT_NAME + 1);
  const overLength = evaluateCatalogImportRow(2, {
    name: longName,
    pricingMode: "FIXED",
    price: "10",
  });
  check(
    "Over-length name is invalid and not truncated",
    overLength.previewStatus === "INVALID" &&
      overLength.name === longName &&
      overLength.invalidReason ===
        catalogImportOverLengthMessage("Name", MAX_SERVICE_CATALOG_IMPORT_NAME),
  );
  const overDescription = evaluateCatalogImportRow(2, {
    name: "Fan",
    description: "D".repeat(MAX_SERVICE_CATALOG_IMPORT_DESCRIPTION + 1),
    pricingMode: "FIXED",
    price: "10",
  });
  check(
    "Over-length description is invalid",
    overDescription.previewStatus === "INVALID" &&
      overDescription.invalidReason ===
        catalogImportOverLengthMessage(
          "Description",
          MAX_SERVICE_CATALOG_IMPORT_DESCRIPTION,
        ),
  );
  const overCategory = evaluateCatalogImportRow(2, {
    name: "Fan",
    pricingMode: "FIXED",
    price: "10",
    category: "C".repeat(MAX_SERVICE_CATALOG_IMPORT_CATEGORY + 1),
  });
  check(
    "Over-length category is invalid",
    overCategory.previewStatus === "INVALID" &&
      overCategory.invalidReason ===
        catalogImportOverLengthMessage("Category", MAX_SERVICE_CATALOG_IMPORT_CATEGORY),
  );
  const overUnit = evaluateCatalogImportRow(2, {
    name: "Fan",
    pricingMode: "VARIABLE",
    price: "10",
    unitLabel: "U".repeat(MAX_SERVICE_CATALOG_IMPORT_UNIT + 1),
  });
  check(
    "Over-length unit label is invalid",
    overUnit.previewStatus === "INVALID" &&
      overUnit.invalidReason ===
        catalogImportOverLengthMessage("Unit label", MAX_SERVICE_CATALOG_IMPORT_UNIT),
  );
  const missingMode = evaluateCatalogImportRow(2, {
    name: "Fan",
    price: "10",
  });
  check(
    "Missing pricingMode is invalid",
    missingMode.previewStatus === "INVALID" &&
      missingMode.invalidReason === CATALOG_IMPORT_PRICING_MODE_REQUIRED_MESSAGE,
  );
  const missingPrice = evaluateCatalogImportRow(2, {
    name: "Fan",
    pricingMode: "FIXED",
  });
  check(
    "Missing price is invalid except Custom Quote",
    missingPrice.previewStatus === "INVALID" &&
      missingPrice.invalidReason === CATALOG_IMPORT_PRICE_REQUIRED_MESSAGE,
  );
  check(
    "Filename is sanitized",
    sanitizeCatalogSourceFilename("../../bought rates!.csv") === "bought_rates_.csv",
  );
  const missingName = evaluateCatalogImportRow(2, {
    name: "",
    pricingMode: "FIXED",
    price: "75",
  });
  check("Missing name is invalid", missingName.previewStatus === "INVALID");
  const hourlyMode = evaluateCatalogImportRow(2, {
    name: "Hourly Labor",
    pricingMode: "HOURLY",
    price: "85",
  });
  check(
    "Hourly pricing mode is invalid",
    hourlyMode.previewStatus === "INVALID" &&
      hourlyMode.invalidReason === CATALOG_IMPORT_NO_HOURLY_MESSAGE,
  );
  check(
    "parseCatalogPricingMode flags hourly aliases",
    parseCatalogPricingMode("per hour").hourly &&
      parseCatalogPricingMode("/hr").hourly &&
      parseCatalogPricingMode("hourly").hourly,
  );
  const hourlyUnit = evaluateCatalogImportRow(2, {
    name: "Deck Wash",
    pricingMode: "VARIABLE",
    price: "2.50",
    unitLabel: "hour",
  });
  check(
    "Hourly unit labels are invalid",
    hourlyUnit.previewStatus === "INVALID" &&
      hourlyUnit.invalidReason === CATALOG_IMPORT_NO_HOURLY_MESSAGE,
  );
  try {
    parseServiceCatalogCsv("price,category\n75,Doors");
    check("CSV without a name column is rejected", false);
  } catch (error) {
    check(
      "CSV without a name column is rejected",
      error.message === CATALOG_IMPORT_MISSING_NAME_HEADER_MESSAGE,
    );
  }
  try {
    const many = [
      "name,pricingMode,price",
      ...Array.from({ length: 201 }, (_, i) => `N${i},FIXED,10`),
    ].join("\n");
    parseServiceCatalogCsv(many);
    check("Row bound rejects 201 data rows", false);
  } catch (error) {
    check(
      "Row bound rejects 201 data rows",
      error.message === CATALOG_IMPORT_TOO_MANY_ROWS_MESSAGE,
    );
  }
  try {
    decodeCatalogCsvBytes(Buffer.alloc(MAX_SERVICE_CATALOG_IMPORT_BYTES + 1));
    check("Byte bound rejects oversized buffers", false);
  } catch (error) {
    check(
      "Byte bound rejects oversized buffers",
      error.message === CATALOG_IMPORT_FILE_TOO_LARGE_MESSAGE,
    );
  }
  try {
    decodeCatalogCsvBytes(Buffer.from("<html>price list</html>"));
    check("HTML upload is rejected as not CSV", false);
  } catch (error) {
    check(
      "HTML upload is rejected as not CSV",
      error.message === CATALOG_IMPORT_NOT_CSV_MESSAGE,
    );
  }
  try {
    parseServiceCatalogCsv("name,pricingMode,price\n");
    check("Empty CSV is rejected", false);
  } catch (error) {
    check("Empty CSV is rejected", error.message === CATALOG_IMPORT_EMPTY_MESSAGE);
  }

  const sameBusinessMatches = applyCatalogImportContext(
    parseServiceCatalogCsv(
      csv(["Door Knob,Swap,FIXED,75,Doors & Locks,HANDYMAN,,,yes"]),
    ),
    {
      businessId: "biz-a",
      primaryTrade: "HANDYMAN",
      activeTradeCodes: ["HANDYMAN"],
      existingItems: [
        {
          id: "cat-a",
          businessId: "biz-a",
          name: "Door Knob",
          tradeCode: "HANDYMAN",
        },
      ],
    },
  );
  check(
    "Same-business same-trade name is a NAME_MATCH before writing",
    sameBusinessMatches[0].previewStatus === "NAME_MATCH" &&
      sameBusinessMatches[0].matchedCatalogItemId === "cat-a",
  );
  const otherBusinessSameName = applyCatalogImportContext(
    parseServiceCatalogCsv(
      csv(["Door Knob,Swap,FIXED,75,Doors & Locks,HANDYMAN,,,yes"]),
    ),
    {
      businessId: "biz-a",
      primaryTrade: "HANDYMAN",
      activeTradeCodes: ["HANDYMAN"],
      existingItems: [
        {
          id: "cat-b",
          businessId: "biz-b",
          name: "Door Knob",
          tradeCode: "HANDYMAN",
        },
      ],
    },
  );
  check(
    "Other-business names are not treated as matches",
    otherBusinessSameName[0].previewStatus === "VALID" &&
      otherBusinessSameName[0].matchedCatalogItemId == null,
  );
  const intraDupes = applyCatalogImportContext(
    parseServiceCatalogCsv(
      csv([
        "Door Knob,Swap,FIXED,75,Doors & Locks,HANDYMAN,,,yes",
        "Door Knob,Other,FIXED,80,Doors & Locks,HANDYMAN,,,yes",
      ]),
    ),
    {
      businessId: "biz-a",
      primaryTrade: "HANDYMAN",
      activeTradeCodes: ["HANDYMAN"],
      existingItems: [],
    },
  );
  check(
    "Intra-CSV duplicate names are invalid",
    intraDupes[0].previewStatus === "VALID" &&
      intraDupes[1].previewStatus === "INVALID",
  );
  check(
    "Fingerprint is stable for the same sanitized row",
    catalogImportRowFingerprint({
      name: "Door Knob",
      tradeCode: "HANDYMAN",
      pricingMode: "FIXED",
      price: new Prisma.Decimal(75),
      category: "Doors",
      description: "Swap",
    }) ===
      catalogImportRowFingerprint({
        name: "Door Knob",
        tradeCode: "HANDYMAN",
        pricingMode: "FIXED",
        price: new Prisma.Decimal(75),
        category: "Doors",
        description: "Swap",
      }),
  );
  check(
    "Name key is case-insensitive per trade",
    catalogNameKey("Door Knob", "handyman") === catalogNameKey("door knob", "HANDYMAN"),
  );
  const duplicateCatalogMatches = applyCatalogImportContext(
    parseServiceCatalogCsv(
      csv(["Door Knob,Swap,FIXED,75,Doors & Locks,HANDYMAN,,,yes"]),
    ),
    {
      businessId: "biz-a",
      primaryTrade: "HANDYMAN",
      activeTradeCodes: ["HANDYMAN"],
      existingItems: [
        {
          id: "cat-newer",
          businessId: "biz-a",
          name: "Door Knob",
          tradeCode: "HANDYMAN",
          createdAt: new Date("2026-09-02T00:00:00.000Z"),
        },
        {
          id: "cat-older",
          businessId: "biz-a",
          name: "Door Knob",
          tradeCode: "HANDYMAN",
          createdAt: new Date("2026-09-01T00:00:00.000Z"),
        },
      ],
    },
  );
  check(
    "VALID becoming INVALID is stale",
    catalogRowBecameStale(
      { previewStatus: "VALID", matchedCatalogItemId: null },
      { previewStatus: "INVALID", matchedCatalogItemId: null },
    ),
  );
  check(
    "Duplicate catalog names match the oldest createdAt then id",
    duplicateCatalogMatches[0].previewStatus === "NAME_MATCH" &&
      duplicateCatalogMatches[0].matchedCatalogItemId === "cat-older" &&
      pickDeterministicCatalogMatch([
        {
          id: "z-id",
          businessId: "biz-a",
          name: "Door Knob",
          tradeCode: "HANDYMAN",
          createdAt: new Date("2026-09-01T00:00:00.000Z"),
        },
        {
          id: "a-id",
          businessId: "biz-a",
          name: "Door Knob",
          tradeCode: "HANDYMAN",
          createdAt: new Date("2026-09-01T00:00:00.000Z"),
        },
      ])?.id === "a-id",
  );

  const businessA = await prisma.business.create({
    data: { name: "Alpha Catalog", slug: `alpha-sci-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Catalog", slug: `beta-sci-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
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

  await prisma.businessTrade.createMany({
    data: [
      { businessId: businessA.id, tradeCode: "HANDYMAN", status: "ACTIVE" },
      { businessId: businessB.id, tradeCode: "HANDYMAN", status: "ACTIVE" },
    ],
  });

  const existingA = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "Existing Door Knob",
      description: "Original catalog scope",
      pricingMode: "STARTING_AT",
      price: new Prisma.Decimal(70),
      category: "Doors & Locks",
      tradeCode: "HANDYMAN",
    },
  });
  await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessB.id,
      name: "Existing Door Knob",
      description: "Other tenant catalog",
      pricingMode: "FIXED",
      price: new Prisma.Decimal(999),
      category: "Doors & Locks",
      tradeCode: "HANDYMAN",
    },
  });

  const estimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      total: new Prisma.Decimal(140),
      publicToken: randomUUID(),
      status: "SENT",
    },
  });
  const historicalLine = await prisma.lineItem.create({
    data: {
      businessId: businessA.id,
      estimateId: estimate.id,
      serviceCatalogItemId: existingA.id,
      description: "Existing Door Knob\n\nScope / Included Work:\nOriginal catalog scope",
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(70),
      total: new Prisma.Decimal(70),
      type: "LABOR",
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
    requireBusinessRole(memberA, "OWNER");
    check("MEMBER fails the OWNER role floor", false);
  } catch (error) {
    check("MEMBER fails the OWNER role floor", error instanceof ForbiddenError);
  }
  await expectError(
    "ADMIN cannot preview a catalog CSV",
    () =>
      previewServiceCatalogCsvUpload(prisma, adminA, {
        filename: "admin.csv",
        bytes: Buffer.from(csv(["New Fan,Install,FIXED,125,Fans & Fixtures,HANDYMAN,,,yes"])),
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot preview a catalog CSV",
    () =>
      previewServiceCatalogCsvUpload(prisma, memberA, {
        filename: "member.csv",
        bytes: Buffer.from(csv(["New Fan,Install,FIXED,125,Fans & Fixtures,HANDYMAN,,,yes"])),
      }),
    (error) => error instanceof ForbiddenError,
  );

  console.log("\nPREVIEW — validation errors and name matches before writing");
  const previewBytes = Buffer.from(
    csv([
      "New Fan,Install a fan,FIXED,125,Fans & Fixtures,HANDYMAN,,,yes",
      "Existing Door Knob,Updated scope,FIXED,90,Doors & Locks,HANDYMAN,,,yes",
      "Hourly Wash,Wash,HOURLY,85,Exterior,HANDYMAN,hour,,yes",
    ]),
  );
  const preview = await previewServiceCatalogCsvUpload(prisma, ownerA, {
    filename: "catalog.csv",
    bytes: previewBytes,
  });
  check("Preview stays PREVIEW until confirm", preview.status === "PREVIEW");
  check("Preview does not write catalog rows yet", preview.writtenCount === 0);
  const catalogCountAfterPreview = await prisma.serviceCatalogItem.count({
    where: { businessId: businessA.id },
  });
  check(
    "Preview leaves the catalog unchanged",
    catalogCountAfterPreview === 1 &&
      (await prisma.serviceCatalogItem.findFirst({
        where: { id: existingA.id },
      }))?.price.toString() === "70",
  );
  check(
    "New row is VALID / ready to add",
    preview.rows.some(
      (row) => row.name === "New Fan" && row.previewStatus === "VALID",
    ),
  );
  check(
    "Existing same-business name is NAME_MATCH with the owned item id",
    preview.rows.some(
      (row) =>
        row.name === "Existing Door Knob" &&
        row.previewStatus === "NAME_MATCH" &&
        row.matchedCatalogItemId === existingA.id,
    ),
  );
  check(
    "Hourly row is INVALID and shown before writing",
    preview.invalidCount === 1 &&
      preview.rows.some(
        (row) =>
          row.name === "Hourly Wash" &&
          row.previewStatus === "INVALID" &&
          row.invalidReason === CATALOG_IMPORT_NO_HOURLY_MESSAGE,
      ),
  );

  await expectError(
    "Confirm is blocked while invalid rows remain",
    () => confirmServiceCatalogImport(prisma, ownerA, { importId: preview.id }),
    (error) =>
      error instanceof ServiceCatalogImportError &&
      error.message === CATALOG_IMPORT_RESOLVE_INVALID_MESSAGE,
  );

  console.log("\nISOLATION — other tenants cannot load or write this preview");
  await expectError(
    "Other-business OWNER cannot load this preview",
    () => loadOwnedCatalogImport(prisma, ownerB, preview.id),
    (error) =>
      error instanceof ServiceCatalogImportError &&
      error.message === CATALOG_IMPORT_NOT_AVAILABLE_MESSAGE,
  );
  await expectError(
    "Other-business OWNER cannot confirm this preview",
    () => confirmServiceCatalogImport(prisma, ownerB, { importId: preview.id }),
    (error) =>
      error instanceof ServiceCatalogImportError &&
      error.message === CATALOG_IMPORT_NOT_AVAILABLE_MESSAGE,
  );

  const retryPreview = await previewServiceCatalogCsvUpload(prisma, ownerA, {
    filename: "catalog-again.csv",
    bytes: previewBytes,
  });
  check(
    "Retry of the same CSV bytes reuses the preview (hash)",
    retryPreview.id === preview.id &&
      retryPreview.contentSha256 === hashCatalogCsvBytes(previewBytes),
  );

  console.log("\nCONFIRM — skip default, explicit update, history, retry");
  const cleanBytes = Buffer.from(
    csv([
      "New Fan,Install a fan,FIXED,125,Fans & Fixtures,HANDYMAN,,,yes",
      "Existing Door Knob,Updated scope,FIXED,90,Doors & Locks,HANDYMAN,,,yes",
    ]),
  );
  const cleanPreview = await previewServiceCatalogCsvUpload(prisma, ownerA, {
    filename: "clean-catalog.csv",
    bytes: cleanBytes,
  });
  check(
    "Clean preview has zero validation errors and one name match defaulting to skip",
    cleanPreview.invalidCount === 0 &&
      cleanPreview.validCount === 1 &&
      cleanPreview.nameMatchCount === 1 &&
      cleanPreview.rows.some(
        (row) =>
          row.previewStatus === "NAME_MATCH" && row.matchDecision === "SKIP",
      ),
  );

  const skipped = await confirmServiceCatalogImport(prisma, ownerA, {
    importId: cleanPreview.id,
  });
  check("Confirm marks the batch CONFIRMED", skipped.preview.status === "CONFIRMED");
  check(
    "Confirm adds VALID rows and skips NAME_MATCH unless marked update",
    skipped.addedCount === 1 && skipped.updatedCount === 0,
  );
  const added = await prisma.serviceCatalogItem.findFirst({
    where: { businessId: businessA.id, name: "New Fan" },
  });
  const skippedExisting = await prisma.serviceCatalogItem.findFirst({
    where: { id: existingA.id },
  });
  check("New service was added on this business", Boolean(added) && added.price.toString() === "125");
  check(
    "Skip default left the matching catalog item unchanged",
    skippedExisting?.price.toString() === "70" &&
      skippedExisting.description === "Original catalog scope" &&
      skippedExisting.pricingMode === "STARTING_AT",
  );

  const updateBytes = Buffer.from(
    csv(["Existing Door Knob,Updated scope,FIXED,90,Doors & Locks,HANDYMAN,,,yes"]),
  );
  const updatePreview = await previewServiceCatalogCsvUpload(prisma, ownerA, {
    filename: "update-catalog.csv",
    bytes: updateBytes,
  });
  const updateRow = updatePreview.rows.find(
    (row) => row.previewStatus === "NAME_MATCH" && row.matchedCatalogItemId === existingA.id,
  );
  const updatedConfirm = await confirmServiceCatalogImport(prisma, ownerA, {
    importId: updatePreview.id,
    matchDecisions: updateRow ? { [updateRow.rowNumber]: "UPDATE" } : {},
  });
  const updated = await prisma.serviceCatalogItem.findFirst({
    where: { id: existingA.id },
  });
  check(
    "Confirm updates only the NAME_MATCH row marked update",
    updatedConfirm.addedCount === 0 &&
      updatedConfirm.updatedCount === 1 &&
      updated?.price.toString() === "90" &&
      updated.description.includes("Updated scope") &&
      updated.pricingMode === "FIXED",
  );

  const otherTenant = await prisma.serviceCatalogItem.findFirst({
    where: { businessId: businessB.id, name: "Existing Door Knob" },
  });
  check(
    "Other-business catalog with the same name was not updated",
    otherTenant?.price.toString() === "999" &&
      otherTenant.description === "Other tenant catalog",
  );

  const lineAfter = await prisma.lineItem.findFirst({
    where: { id: historicalLine.id, businessId: businessA.id },
  });
  check(
    "Historical estimate line description is unchanged",
    lineAfter?.description === historicalLine.description,
  );
  check(
    "Historical estimate line unit price is unchanged",
    lineAfter?.unitPrice.toString() === "70",
  );
  check(
    "Historical estimate line total is unchanged",
    lineAfter?.total.toString() === "70",
  );
  check(
    "Historical estimate line still points at the catalog item",
    lineAfter?.serviceCatalogItemId === existingA.id,
  );

  const confirmRetry = await confirmServiceCatalogImport(prisma, ownerA, {
    importId: cleanPreview.id,
  });
  check("Confirm retry is reused and does not double-write", confirmRetry.reused === true);
  const catalogAfterRetry = await prisma.serviceCatalogItem.count({
    where: { businessId: businessA.id, name: "New Fan" },
  });
  check("Retry did not create a second New Fan", catalogAfterRetry === 1);

  await expectError(
    "ADMIN cannot confirm an OWNER preview",
    () => confirmServiceCatalogImport(prisma, adminA, { importId: cleanPreview.id }),
    (error) => error instanceof ForbiddenError,
  );

  const alreadyConfirmedCopy = CATALOG_IMPORT_ALREADY_CONFIRMED_MESSAGE;
  check(
    "Already-confirmed copy exists for UI",
    alreadyConfirmedCopy.includes("already confirmed"),
  );

  console.log("\nCONFIRM — blank keep, archived active, rematch, concurrency");
  const archived = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "Archived Fan",
      description: "Keep archived description",
      pricingMode: "STARTING_AT",
      price: new Prisma.Decimal(30),
      category: "Fans & Fixtures",
      tradeCode: "HANDYMAN",
      unitLabel: "each",
      recurrenceEligible: false,
      active: false,
    },
  });
  const blankKeepBytes = Buffer.from(
    csv(["Archived Fan,,FIXED,99,,HANDYMAN,,,"]),
  );
  const blankKeepPreview = await previewServiceCatalogCsvUpload(prisma, ownerA, {
    filename: "blank-keep.csv",
    bytes: blankKeepBytes,
  });
  const blankKeepRow = blankKeepPreview.rows.find(
    (row) => row.matchedCatalogItemId === archived.id,
  );
  check(
    "Blank optional cells stay null on the NAME_MATCH preview row",
    blankKeepRow?.previewStatus === "NAME_MATCH" &&
      blankKeepRow.description == null &&
      blankKeepRow.category == null &&
      blankKeepRow.active == null,
  );
  await confirmServiceCatalogImport(prisma, ownerA, {
    importId: blankKeepPreview.id,
    matchDecisions: blankKeepRow ? { [blankKeepRow.rowNumber]: "UPDATE" } : {},
  });
  const archivedAfter = await prisma.serviceCatalogItem.findFirst({
    where: { id: archived.id, businessId: businessA.id },
  });
  check(
    "Update with blank cells keeps description, category, and archived active",
    archivedAfter?.price.toString() === "99" &&
      archivedAfter.pricingMode === "FIXED" &&
      archivedAfter.description === "Keep archived description" &&
      archivedAfter.category === "Fans & Fixtures" &&
      archivedAfter.unitLabel === "each" &&
      archivedAfter.active === false,
  );

  const firstXBytes = Buffer.from(csv(["X,First scope,FIXED,10,Other Services,HANDYMAN,,,yes"]));
  const secondXBytes = Buffer.from(csv(["X,Second scope,FIXED,11,Other Services,HANDYMAN,,,yes"]));
  const firstXPreview = await previewServiceCatalogCsvUpload(prisma, ownerA, {
    filename: "x-first.csv",
    bytes: firstXBytes,
  });
  const secondXPreview = await previewServiceCatalogCsvUpload(prisma, ownerA, {
    filename: "x-second.csv",
    bytes: secondXBytes,
  });
  check(
    "Two previews both contain a VALID X before either confirm",
    firstXPreview.rows.some((row) => row.name === "X" && row.previewStatus === "VALID") &&
      secondXPreview.rows.some((row) => row.name === "X" && row.previewStatus === "VALID"),
  );
  await confirmServiceCatalogImport(prisma, ownerA, { importId: firstXPreview.id });
  await expectError(
    "Second preview of X rematches the live catalog instead of writing another X",
    () => confirmServiceCatalogImport(prisma, ownerA, { importId: secondXPreview.id }),
    (error) =>
      error instanceof ServiceCatalogImportError &&
      error.message === CATALOG_IMPORT_STALE_MATCHES_MESSAGE,
  );
  const xCount = await prisma.serviceCatalogItem.count({
    where: { businessId: businessA.id, name: "X" },
  });
  const secondXAfter = await loadOwnedCatalogImport(prisma, ownerA, secondXPreview.id);
  check("Sequential confirms of X leave exactly one X", xCount === 1);
  check(
    "Stale second preview returns to reviewable PREVIEW with a name match",
    secondXAfter.status === "PREVIEW" &&
      secondXAfter.rows.some(
        (row) => row.name === "X" && row.previewStatus === "NAME_MATCH",
      ),
  );

  await prisma.businessTrade.create({
    data: { businessId: businessA.id, tradeCode: "PRESSURE_WASHING", status: "ACTIVE" },
  });
  const inactiveTradeBytes = Buffer.from(
    csv(["Gutter Soft Wash,Wash,FIXED,120,Exterior,PRESSURE_WASHING,,,yes"]),
  );
  const inactiveTradePreview = await previewServiceCatalogCsvUpload(prisma, ownerA, {
    filename: "gutter-wash.csv",
    bytes: inactiveTradeBytes,
  });
  check(
    "Pressure-washing row is VALID while that trade is active",
    inactiveTradePreview.rows.some(
      (row) => row.name === "Gutter Soft Wash" && row.previewStatus === "VALID",
    ),
  );
  await prisma.businessTrade.updateMany({
    where: { businessId: businessA.id, tradeCode: "PRESSURE_WASHING" },
    data: { status: "INACTIVE" },
  });
  await expectError(
    "VALID row whose trade became inactive is stale instead of writing",
    () => confirmServiceCatalogImport(prisma, ownerA, { importId: inactiveTradePreview.id }),
    (error) =>
      error instanceof ServiceCatalogImportError &&
      error.message === CATALOG_IMPORT_STALE_MATCHES_MESSAGE,
  );
  const gutterCount = await prisma.serviceCatalogItem.count({
    where: { businessId: businessA.id, name: "Gutter Soft Wash" },
  });
  const gutterAfter = await loadOwnedCatalogImport(prisma, ownerA, inactiveTradePreview.id);
  check("Inactive-trade rematch writes no catalog row", gutterCount === 0);
  check(
    "Inactive-trade rematch returns a reviewable PREVIEW INVALID row",
    gutterAfter.status === "PREVIEW" &&
      gutterAfter.rows.some(
        (row) => row.name === "Gutter Soft Wash" && row.previewStatus === "INVALID",
      ),
  );

  const unknownDecisionPreview = await previewServiceCatalogCsvUpload(prisma, ownerA, {
    filename: "unknown-decision.csv",
    bytes: Buffer.from(csv(["Decision Fan,Install,FIXED,22,Fans & Fixtures,HANDYMAN,,,yes"])),
  });
  await expectError(
    "Unknown matchDecision rowNumber is a stale preview, not a silent skip",
    () =>
      confirmServiceCatalogImport(prisma, ownerA, {
        importId: unknownDecisionPreview.id,
        matchDecisions: { 9999: "UPDATE" },
      }),
    (error) =>
      error instanceof ServiceCatalogImportError &&
      error.message === CATALOG_IMPORT_STALE_MATCHES_MESSAGE,
  );

  const recoverBytes = Buffer.from(
    csv(["Recover Fan,Install,FIXED,40,Fans & Fixtures,HANDYMAN,,,yes"]),
  );
  const recoverPreview = await previewServiceCatalogCsvUpload(prisma, ownerA, {
    filename: "recover.csv",
    bytes: recoverBytes,
  });
  await prisma.serviceCatalogImport.update({
    where: { id: recoverPreview.id },
    data: { status: "CONFIRMING", confirmingAt: new Date() },
  });
  await expectError(
    "Re-upload of a fresh CONFIRMING lease is refused",
    () =>
      previewServiceCatalogCsvUpload(prisma, ownerA, {
        filename: "recover-again.csv",
        bytes: recoverBytes,
      }),
    (error) =>
      error instanceof ServiceCatalogImportError &&
      error.message === CATALOG_IMPORT_IN_PROGRESS_MESSAGE,
  );
  const freshLock = await loadOwnedCatalogImport(prisma, ownerA, recoverPreview.id);
  check(
    "Fresh CONFIRMING lease is not reset by re-upload",
    freshLock.status === "CONFIRMING" && !freshLock.confirmingRecoverable,
  );
  await prisma.serviceCatalogImport.update({
    where: { id: recoverPreview.id },
    data: {
      status: "CONFIRMING",
      confirmingAt: new Date(Date.now() - 2 * CATALOG_IMPORT_CONFIRMING_LEASE_MS),
    },
  });
  const recovered = await previewServiceCatalogCsvUpload(prisma, ownerA, {
    filename: "recover-stale.csv",
    bytes: recoverBytes,
  });
  check(
    "Re-upload resets only a stale CONFIRMING lease to PREVIEW",
    recovered.id === recoverPreview.id && recovered.status === "PREVIEW",
  );

  const crashBytes = Buffer.from(
    csv([
      "Crash Alpha,Install,FIXED,15,Fans & Fixtures,HANDYMAN,,,yes",
      "Crash Beta,Install,FIXED,16,Fans & Fixtures,HANDYMAN,,,yes",
    ]),
  );
  const crashPreview = await previewServiceCatalogCsvUpload(prisma, ownerA, {
    filename: "crash.csv",
    bytes: crashBytes,
  });
  await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "Crash Alpha",
      description: "Partial write leftover",
      pricingMode: "FIXED",
      price: new Prisma.Decimal(15),
      category: "Fans & Fixtures",
      tradeCode: "HANDYMAN",
    },
  });
  await prisma.serviceCatalogImport.update({
    where: { id: crashPreview.id },
    data: {
      status: "CONFIRMING",
      confirmingAt: new Date(Date.now() - 2 * CATALOG_IMPORT_CONFIRMING_LEASE_MS),
    },
  });
  await expectError(
    "Crash-midway stale confirm rematches instead of duplicating Crash Alpha",
    () => confirmServiceCatalogImport(prisma, ownerA, { importId: crashPreview.id }),
    (error) =>
      error instanceof ServiceCatalogImportError &&
      error.message === CATALOG_IMPORT_STALE_MATCHES_MESSAGE,
  );
  const crashAlpha = await prisma.serviceCatalogItem.count({
    where: { businessId: businessA.id, name: "Crash Alpha" },
  });
  const crashBeta = await prisma.serviceCatalogItem.count({
    where: { businessId: businessA.id, name: "Crash Beta" },
  });
  const crashAfter = await loadOwnedCatalogImport(prisma, ownerA, crashPreview.id);
  check("Crash-midway recovery does not create a second Crash Alpha", crashAlpha === 1);
  check("Crash-midway recovery does not write Crash Beta before review", crashBeta === 0);
  check(
    "Crash-midway import is reviewable PREVIEW with Crash Alpha matched",
    crashAfter.status === "PREVIEW" &&
      crashAfter.confirmingRecoverable === false &&
      crashAfter.rows.some(
        (row) => row.name === "Crash Alpha" && row.previewStatus === "NAME_MATCH",
      ),
  );
  check(
    "Stale confirmingAt is treated as expired",
    isCatalogImportConfirmingLeaseStale(
      new Date(Date.now() - 2 * CATALOG_IMPORT_CONFIRMING_LEASE_MS),
    ),
  );

  function raceTogether(fns) {
    let remaining = fns.length;
    let release;
    const barrier = new Promise((resolve) => {
      release = resolve;
    });
    return Promise.allSettled(
      fns.map(async (fn) => {
        remaining -= 1;
        if (remaining === 0) release();
        await barrier;
        return fn();
      }),
    );
  }

  const prismaRace = new PrismaClient({ datasourceUrl: testUrl });
  try {
    const concurrentBytes = Buffer.from(
      csv([
        "Concurrent One,Install,FIXED,15,Fans & Fixtures,HANDYMAN,,,yes",
        "Concurrent Two,Install,FIXED,16,Fans & Fixtures,HANDYMAN,,,yes",
      ]),
    );
    const concurrentPreview = await previewServiceCatalogCsvUpload(prisma, ownerA, {
      filename: "concurrent.csv",
      bytes: concurrentBytes,
    });
    const sameImportRace = await raceTogether([
      () => confirmServiceCatalogImport(prisma, ownerA, { importId: concurrentPreview.id }),
      () =>
        confirmServiceCatalogImport(prismaRace, ownerA, { importId: concurrentPreview.id }),
    ]);
    const sameWriters = sameImportRace.filter(
      (result) => result.status === "fulfilled" && result.value.reused === false,
    );
    const sameOther = sameImportRace.filter(
      (result) =>
        (result.status === "fulfilled" && result.value.reused === true) ||
        (result.status === "rejected" &&
          result.reason instanceof ServiceCatalogImportError &&
          result.reason.message === CATALOG_IMPORT_IN_PROGRESS_MESSAGE),
    );
    check("Same-import barrier race has exactly one writer", sameWriters.length === 1);
    check(
      "Same-import barrier race has exactly one reused or in-progress loser",
      sameOther.length === 1,
    );
    const concurrentOne = await prisma.serviceCatalogItem.count({
      where: { businessId: businessA.id, name: "Concurrent One" },
    });
    const concurrentTwo = await prisma.serviceCatalogItem.count({
      where: { businessId: businessA.id, name: "Concurrent Two" },
    });
    check(
      "Two simultaneous confirms leave exactly one new item per VALID row",
      concurrentOne === 1 && concurrentTwo === 1,
    );

    const sharedOneBytes = Buffer.from(
      csv(["Shared Race,First,FIXED,10,Other Services,HANDYMAN,,,yes"]),
    );
    const sharedTwoBytes = Buffer.from(
      csv(["Shared Race,Second,FIXED,11,Other Services,HANDYMAN,,,yes"]),
    );
    const sharedOne = await previewServiceCatalogCsvUpload(prisma, ownerA, {
      filename: "shared-one.csv",
      bytes: sharedOneBytes,
    });
    const sharedTwo = await previewServiceCatalogCsvUpload(prisma, ownerA, {
      filename: "shared-two.csv",
      bytes: sharedTwoBytes,
    });
    const sharedRace = await raceTogether([
      () => confirmServiceCatalogImport(prisma, ownerA, { importId: sharedOne.id }),
      () => confirmServiceCatalogImport(prismaRace, ownerA, { importId: sharedTwo.id }),
    ]);
    const sharedWriters = sharedRace.filter(
      (result) => result.status === "fulfilled" && result.value.reused === false,
    );
    const sharedStale = sharedRace.filter(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof ServiceCatalogImportError &&
        result.reason.message === CATALOG_IMPORT_STALE_MATCHES_MESSAGE,
    );
    const sharedCount = await prisma.serviceCatalogItem.count({
      where: { businessId: businessA.id, name: "Shared Race" },
    });
    check(
      "Two-import same-name barrier race has exactly one writer",
      sharedWriters.length === 1,
    );
    check("Two-import same-name barrier race rematches the loser", sharedStale.length === 1);
    check("Two-import same-name barrier race leaves exactly one Shared Race", sharedCount === 1);

    const reloadBytes = Buffer.from(
      csv(["Reload Fan,Install,FIXED,18,Fans & Fixtures,HANDYMAN,,,yes"]),
    );
    const reloadPreview = await previewServiceCatalogCsvUpload(prisma, ownerA, {
      filename: "reload.csv",
      bytes: reloadBytes,
    });
    await raceTogether([
      () => confirmServiceCatalogImport(prisma, ownerA, { importId: reloadPreview.id }),
      () =>
        previewServiceCatalogCsvUpload(prismaRace, ownerA, {
          filename: "reload-again.csv",
          bytes: reloadBytes,
        }),
    ]);
    const reloadCount = await prisma.serviceCatalogItem.count({
      where: { businessId: businessA.id, name: "Reload Fan" },
    });
    const reloadAfter = await loadOwnedCatalogImport(prisma, ownerA, reloadPreview.id);
    check("Re-upload during in-flight confirm leaves exactly one Reload Fan", reloadCount === 1);
    check(
      "Re-upload during in-flight confirm does not leave a torn CONFIRMING import",
      reloadAfter.status === "CONFIRMED" || reloadAfter.status === "PREVIEW",
    );
    if (reloadAfter.status === "PREVIEW") {
      await confirmServiceCatalogImport(prisma, ownerA, { importId: reloadPreview.id });
      const reloadFinal = await prisma.serviceCatalogItem.count({
        where: { businessId: businessA.id, name: "Reload Fan" },
      });
      check("Follow-up confirm after raced re-upload still writes one Reload Fan", reloadFinal === 1);
    }
  } finally {
    await prismaRace.$disconnect();
  }

  console.log(
    failures === 0
      ? "\nAll service catalog import checks passed."
      : `\n${failures} service catalog import check(s) failed.`,
  );
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  try {
    await prisma.$disconnect();
  } catch {
    // The dedicated client may already be closed.
  }
  try {
    await dropTestDatabase();
  } catch (error) {
    console.error(error);
    failures += 1;
  }
}

process.exit(failures === 0 ? 0 : 1);

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
  CATALOG_IMPORT_MISSING_NAME_HEADER_MESSAGE,
  CATALOG_IMPORT_NAME_MATCH_MESSAGE,
  CATALOG_IMPORT_NO_HISTORY_REWRITE_MESSAGE,
  CATALOG_IMPORT_NO_HOURLY_MESSAGE,
  CATALOG_IMPORT_NOT_AVAILABLE_MESSAGE,
  CATALOG_IMPORT_NOT_CSV_MESSAGE,
  CATALOG_IMPORT_RESOLVE_INVALID_MESSAGE,
  CATALOG_IMPORT_TOO_MANY_ROWS_MESSAGE,
  catalogImportRowFingerprint,
  catalogNameKey,
  decodeCatalogCsvBytes,
  evaluateCatalogImportRow,
  hashCatalogCsvBytes,
  MAX_SERVICE_CATALOG_IMPORT_BYTES,
  MAX_SERVICE_CATALOG_IMPORT_ROWS,
  OWNER_ONLY_CATALOG_IMPORT_MESSAGE,
  parseCatalogCsv,
  parseCatalogPricingMode,
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
const migrationSource = readSrc(
  "prisma/migrations/20260929010000_service_catalog_import/migration.sql",
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_service_catalog_import_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

{
  const { PrismaClient: AdminPrisma } = createRequire(import.meta.url)("@prisma/client");
  const admin = new AdminPrisma({ datasourceUrl: baseUrl });
  await admin.$queryRawUnsafe(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    testDbName,
  );
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  await admin.$disconnect();
}

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for service catalog import test database.");
  process.exit(push.status ?? 1);
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

  console.log("\nSTATIC — parse, sanitize, upload bounds");
  const quoted = parseCatalogCsv('name,description\n"Fan, 52""","Replace, now"');
  check(
    "CSV parser keeps quoted commas",
    quoted[1][0] === 'Fan, 52"' && quoted[1][1] === "Replace, now",
  );
  check(
    "Sanitize strips tags and control characters",
    sanitizeCatalogImportText("Fan\u0000<script>x</script> Swap", 80) === "Fan Swap",
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

  console.log("\nCONFIRM — add, update, history, retry");
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
    "Clean preview has zero validation errors and one name match",
    cleanPreview.invalidCount === 0 &&
      cleanPreview.validCount === 1 &&
      cleanPreview.nameMatchCount === 1,
  );

  const confirmed = await confirmServiceCatalogImport(prisma, ownerA, {
    importId: cleanPreview.id,
  });
  check("Confirm marks the batch CONFIRMED", confirmed.preview.status === "CONFIRMED");
  check(
    "Confirm added one and updated one",
    confirmed.addedCount === 1 && confirmed.updatedCount === 1,
  );
  const added = await prisma.serviceCatalogItem.findFirst({
    where: { businessId: businessA.id, name: "New Fan" },
  });
  const updated = await prisma.serviceCatalogItem.findFirst({
    where: { id: existingA.id },
  });
  check("New service was added on this business", Boolean(added) && added.price.toString() === "125");
  check(
    "Matching name updated this business's catalog item",
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
    where: { businessId: businessA.id },
  });
  check("Retry did not create a second New Fan", catalogAfterRetry === 2);

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

  console.log(
    failures === 0
      ? "\nAll service catalog import checks passed."
      : `\n${failures} service catalog import check(s) failed.`,
  );
  process.exit(failures === 0 ? 0 : 1);
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}

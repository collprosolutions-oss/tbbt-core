/**
 * Focused verification for Step 3 — Persistent Service Categories (see
 * prisma/schema.prisma ServiceCatalogItem.category,
 * prisma/migrations/20260829120000_add_service_catalog_item_category,
 * src/lib/service-catalog-category.ts, src/lib/handyman-starter-catalog.ts,
 * and src/app/actions/catalog.ts).
 *
 * This script proves two separate things:
 *
 *   1. The SHIPPED migration SQL (not a reimplementation of it) correctly
 *      backfills category onto data that existed BEFORE the category
 *      column existed, using a temporary copy of prisma/migrations with
 *      the newest migration folder removed, applied via a real
 *      `prisma migrate deploy`, followed by re-adding it and deploying
 *      again -- so the exact migration.sql that ships in this repo is what
 *      gets exercised.
 *   2. The application-level behavior on top of that persisted column:
 *      starter-catalog install stores category directly, grouping uses
 *      the persisted column (not name matching), a custom/future-trade
 *      category works without any TBBT Core change, duplicate-install
 *      protection still works, and pricing modes/prices are untouched.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-service-categories.mjs
 */
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, cpSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HANDYMAN_CATALOG_CATEGORIES,
  HANDYMAN_STARTER_SERVICES,
  OTHER_SERVICES_CATEGORY,
  planStarterCatalogInstall,
  starterPricingMode,
} from "../src/lib/handyman-starter-catalog.ts";
import {
  DEFAULT_SERVICE_CATEGORY,
  groupServiceCatalogItemsByCategory,
  normalizeServiceCategory,
} from "../src/lib/service-catalog-category.ts";

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error(
    "DATABASE_URL must be set (pointing at a reachable Postgres server) to run this check.",
  );
  process.exit(1);
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const testDbName = "tbbt_service_categories_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

console.log(
  "\nSTATIC — Fallback category constants stay in sync across modules",
);
if (OTHER_SERVICES_CATEGORY !== DEFAULT_SERVICE_CATEGORY) {
  console.error(
    `FAIL - handyman-starter-catalog.ts OTHER_SERVICES_CATEGORY (${JSON.stringify(
      OTHER_SERVICES_CATEGORY,
    )}) must equal service-catalog-category.ts DEFAULT_SERVICE_CATEGORY (${JSON.stringify(
      DEFAULT_SERVICE_CATEGORY,
    )})`,
  );
  process.exit(1);
}
console.log(
  `  ok  - OTHER_SERVICES_CATEGORY === DEFAULT_SERVICE_CATEGORY (${JSON.stringify(DEFAULT_SERVICE_CATEGORY)})`,
);

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

const NEW_MIGRATION = "20260829120000_add_service_catalog_item_category";

// --- Set up a temp Prisma project pointing at a copy of prisma/migrations
// with the newest migration removed, so we can apply "everything before
// Step 3" with a real `prisma migrate deploy`, then re-add the real
// migration folder and deploy again to run the ACTUAL shipped SQL. ---
const tmpRoot = mkdtempSync(path.join(tmpdir(), "tbbt-category-migration-"));
const tmpPrismaDir = path.join(tmpRoot, "prisma");
mkdirSync(tmpPrismaDir);
cpSync(
  path.join(repoRoot, "prisma", "schema.prisma"),
  path.join(tmpPrismaDir, "schema.prisma"),
);
cpSync(
  path.join(repoRoot, "prisma", "migrations"),
  path.join(tmpPrismaDir, "migrations"),
  { recursive: true },
);
const tmpNewMigrationDir = path.join(tmpPrismaDir, "migrations", NEW_MIGRATION);
const realNewMigrationDir = path.join(
  repoRoot,
  "prisma",
  "migrations",
  NEW_MIGRATION,
);
rmSync(tmpNewMigrationDir, { recursive: true, force: true });

function migrateDeploy(schemaPath) {
  return spawnSync(
    "npx",
    ["prisma", "migrate", "deploy", "--schema", schemaPath],
    { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
  );
}

const tmpSchemaPath = path.join(tmpPrismaDir, "schema.prisma");

console.log("\nSetup — applying every pre-Step-3 migration to a fresh database");
const preStep3 = migrateDeploy(tmpSchemaPath);
if (preStep3.status !== 0) {
  console.error("Failed to apply pre-Step-3 migrations.");
  process.exit(preStep3.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

try {
  // Legacy data inserted BEFORE the category column exists, via raw SQL
  // (the generated Prisma Client is for the FINAL schema and would refuse
  // to omit a required field, but Postgres itself has no such column yet
  // at this point, so plain SQL is required here).
  const business = await prisma.business.create({
    data: { name: "Legacy Handyman", slug: "legacy-handyman-cat", tradeCode: "HANDYMAN" },
  });

  const knownStarterName = "Ceiling Fan Replacement"; // category: Fans & Fixtures
  const knownStarterName2 = "Tub / Shower Recaulk"; // category: Bathroom / Caulking / Accessories
  const knownStarterNameWithCase = "  standard door knob replacement  "; // Doors & Locks, mixed case + padding
  const customUnmappedName = "Backyard Chicken Coop Repair";

  const legacyIds = {};
  async function insertLegacyRow(key, name, price, pricingMode) {
    const id = randomUUID();
    legacyIds[key] = id;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "ServiceCatalogItem" (id, "businessId", name, "pricingMode", price, active, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5::numeric, true, now(), now())`,
      id,
      business.id,
      name,
      pricingMode,
      price,
    );
  }
  await insertLegacyRow("knownFan", knownStarterName, "150", "STARTING_AT");
  await insertLegacyRow("knownBath", knownStarterName2, "150", "STARTING_AT");
  await insertLegacyRow("knownDoorMixedCase", knownStarterNameWithCase, "75", "STARTING_AT");
  await insertLegacyRow("customUnmapped", customUnmappedName, "999", "FIXED");

  const legacyCountBefore = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS count FROM "ServiceCatalogItem" WHERE "businessId" = $1`,
    business.id,
  );

  console.log(
    "\nApplying the REAL shipped Step 3 migration (schema change + backfill)",
  );
  cpSync(realNewMigrationDir, tmpNewMigrationDir, { recursive: true });
  const step3 = migrateDeploy(tmpSchemaPath);
  if (step3.status !== 0) {
    console.error("Failed to apply the Step 3 migration.");
    process.exit(step3.status ?? 1);
  }

  console.log(
    "\nTEST 1 — Existing Handyman starter services retain their expected categories after migration/backfill",
  );
  const afterMigration = await prisma.serviceCatalogItem.findMany({
    where: { businessId: business.id },
  });
  const legacyCountAfter = afterMigration.length;
  check(
    "No existing rows were lost by the migration",
    legacyCountAfter === legacyCountBefore[0].count && legacyCountAfter === 4,
  );

  const byId = Object.fromEntries(afterMigration.map((row) => [row.id, row]));
  check(
    "Known starter service (exact name) backfilled to its real category (Fans & Fixtures)",
    byId[legacyIds.knownFan]?.category === "Fans & Fixtures",
  );
  check(
    "Known starter service (exact name) backfilled to its real category (Bathroom / Caulking / Accessories)",
    byId[legacyIds.knownBath]?.category === "Bathroom / Caulking / Accessories",
  );
  check(
    "Known starter service matched case-insensitively / trimmed (padded, lowercased name) still backfilled to Doors & Locks",
    byId[legacyIds.knownDoorMixedCase]?.category === "Doors & Locks",
  );
  check(
    "Custom/unmapped existing service falls back to the safe neutral 'Other Services' category (matches the app's pre-existing OTHER_SERVICES_CATEGORY fallback), not a guess",
    byId[legacyIds.customUnmapped]?.category === DEFAULT_SERVICE_CATEGORY,
  );
  check(
    "Migration did not touch price or pricingMode while backfilling category",
    byId[legacyIds.knownFan]?.price.toString() === "150" &&
      byId[legacyIds.knownFan]?.pricingMode === "STARTING_AT" &&
      byId[legacyIds.customUnmapped]?.price.toString() === "999" &&
      byId[legacyIds.customUnmapped]?.pricingMode === "FIXED",
  );

  console.log(
    "\nTEST 2 — New starter-catalog import stores categories persistently (mirrors installHandymanStarterCatalog())",
  );
  /** Mirrors src/app/actions/catalog.ts installHandymanStarterCatalog(). */
  async function mirrorInstallStarterCatalog(businessId) {
    const existing = await prisma.serviceCatalogItem.findMany({
      where: { businessId },
      select: { name: true },
    });
    const plan = planStarterCatalogInstall(existing.map((item) => item.name));
    if (plan.add.length > 0) {
      await prisma.$transaction(
        plan.add.map((service) =>
          prisma.serviceCatalogItem.create({
            data: {
              businessId,
              name: service.name,
              description: service.description,
              pricingMode: starterPricingMode(service),
              price:
                service.startingPrice == null
                  ? null
                  : new Prisma.Decimal(service.startingPrice),
              category: service.category,
              active: true,
            },
          }),
        ),
      );
    }
    return plan;
  }

  const freshBusiness = await prisma.business.create({
    data: { name: "Fresh Handyman", slug: "fresh-handyman-cat", tradeCode: "HANDYMAN" },
  });
  const installPlan = await mirrorInstallStarterCatalog(freshBusiness.id);
  const installedItems = await prisma.serviceCatalogItem.findMany({
    where: { businessId: freshBusiness.id },
  });
  check(
    "Installing the starter catalog on a fresh business added every importable starter service",
    installPlan.skip.length === 0 && installedItems.length === installPlan.add.length,
  );
  const mismatchedCategory = installedItems.find((item) => {
    const template = HANDYMAN_STARTER_SERVICES.find((s) => s.name === item.name);
    return !template || template.category !== item.category;
  });
  check(
    "Every newly-installed starter service's persisted category exactly matches its template's own category field (stored directly, not derived later)",
    mismatchedCategory === undefined,
  );

  console.log(
    "\nTEST 3 — Services page groups using persisted category data, not service-name matching",
  );
  // Deliberately mismatched: an item literally named after a Doors & Locks
  // starter service, but whose PERSISTED category is something else
  // entirely. If grouping used name matching (the old behavior), this
  // would land under "Doors & Locks"; grouping by the persisted column
  // must land it under its actual stored category instead.
  const mismatchItem = {
    id: "mismatch-1",
    name: "Deadbolt Replacement",
    category: "Custom Renovation Add-Ons",
  };
  const groupedMismatch = groupServiceCatalogItemsByCategory([mismatchItem]);
  check(
    "An item literally named after a known starter service groups under its OWN persisted category, not the name-derived one",
    groupedMismatch.length === 1 &&
      groupedMismatch[0].category === "Custom Renovation Add-Ons" &&
      groupedMismatch[0].items[0].id === "mismatch-1",
  );
  check(
    "...and it does NOT get grouped under the name-derived 'Doors & Locks' bucket",
    !groupedMismatch.some((group) => group.category === "Doors & Locks"),
  );

  const realGrouped = groupServiceCatalogItemsByCategory(
    installedItems,
    HANDYMAN_CATALOG_CATEGORIES,
  );
  const flattenedRealGrouped = realGrouped.flatMap((group) =>
    group.items.map((item) => ({ id: item.id, category: group.category })),
  );
  const groupingMismatch = flattenedRealGrouped.find((entry) => {
    const row = installedItems.find((item) => item.id === entry.id);
    return row.category !== entry.category;
  });
  check(
    "Grouping a real installed catalog list places every item under exactly its own persisted category column",
    groupingMismatch === undefined &&
      flattenedRealGrouped.length === installedItems.length,
  );

  console.log(
    "\nTEST 4 — A custom service can exist with a category without changing TBBT Core",
  );
  const futureTradeCategory = "Move-In / Move-Out Cleaning Checklist";
  const customService = await prisma.serviceCatalogItem.create({
    data: {
      businessId: freshBusiness.id,
      name: "Whole-Home Deep Clean",
      pricingMode: "FIXED",
      price: new Prisma.Decimal(300),
      category: futureTradeCategory,
    },
  });
  check(
    "An arbitrary, non-Handyman category string persists exactly as given (no enum rejects it)",
    customService.category === futureTradeCategory,
  );
  const groupedWithFutureTrade = groupServiceCatalogItemsByCategory([
    customService,
  ]);
  check(
    "That future-trade-style category groups correctly using the same generic, trade-agnostic helper",
    groupedWithFutureTrade.length === 1 &&
      groupedWithFutureTrade[0].category === futureTradeCategory,
  );
  check(
    "normalizeServiceCategory() only ever falls back for blank/missing values, never rewrites a real custom category",
    normalizeServiceCategory(futureTradeCategory) === futureTradeCategory &&
      normalizeServiceCategory("   ") === DEFAULT_SERVICE_CATEGORY &&
      normalizeServiceCategory(null) === DEFAULT_SERVICE_CATEGORY,
  );

  console.log("\nTEST 5 — Duplicate starter-catalog protection still works");
  const secondInstallPlan = await mirrorInstallStarterCatalog(freshBusiness.id);
  const itemsAfterSecondInstall = await prisma.serviceCatalogItem.findMany({
    where: { businessId: freshBusiness.id },
  });
  check(
    "Re-running starter-catalog install on the same business adds nothing new (every starter name already present is skipped)",
    secondInstallPlan.add.length === 0 &&
      secondInstallPlan.skip.length === installPlan.add.length,
  );
  check(
    "No duplicate rows were created by the second install",
    itemsAfterSecondInstall.length === installedItems.length + 1, // +1 for the custom service added in TEST 4
  );

  console.log("\nTEST 6 — Existing pricing modes remain unchanged");
  const fixedExample = installedItems.find((item) => item.pricingMode === "FIXED");
  const startingAtExample = installedItems.find(
    (item) => item.pricingMode === "STARTING_AT",
  );
  const customQuoteExample = installedItems.find(
    (item) => item.pricingMode === "CUSTOM_QUOTE",
  );
  check(
    "Starter catalog still installs FIXED / STARTING_AT / CUSTOM_QUOTE pricing modes exactly as before (category is additive, not a replacement for pricing mode)",
    fixedExample === undefined && // no starter service is FIXED today; this documents that, not a category bug
      startingAtExample !== undefined &&
      customQuoteExample !== undefined &&
      customQuoteExample.price === null,
  );
  check(
    "A STARTING_AT starter item keeps a non-null price alongside its persisted category",
    startingAtExample.price !== null && startingAtExample.category.length > 0,
  );

  console.log(
    failures === 0
      ? "\nAll service-category checks passed."
      : `\n${failures} service-category check(s) failed.`,
  );
} finally {
  await prisma.$disconnect();
  rmSync(tmpRoot, { recursive: true, force: true });
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${testDbName}' AND pid <> pg_backend_pid()`,
    );
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

process.exit(failures === 0 ? 0 : 1);

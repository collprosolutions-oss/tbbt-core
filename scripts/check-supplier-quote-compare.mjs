/**
 * OWNER dated supplier-quote comparison.
 *
 * Proves unit conversions, stale quotes, tenant isolation, concurrent
 * selection, exact totals, append-only original quotes, and that
 * selecting a quote never rewrites estimate or invoice snapshots.
 * No retailer scraping or live ordering. Dedicated local test DB.
 *
 * Run with:
 *   npm run test:supplier-quote-compare
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const parsed = new URL(baseUrl);
if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
  console.error("Refusing to run supplier-quote compare checks against a non-local DATABASE_URL host.");
  process.exit(1);
}

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError } = await import("@/lib/authorization");
const { createEstimateVersionSnapshot } = await import("@/lib/estimate-version");
const {
  addPurchaseListItem,
  businessLocalQuoteDateInput,
  canSelectSupplierQuoteForPurchaseItem,
  classifySupplierQuoteFreshness,
  compareSupplierQuotes,
  convertMaterialQuoteUnits,
  createMaterialCatalogItem,
  createPurchaseOrder,
  createSupplier,
  ensurePurchaseList,
  getSupplierCommerceAdapter,
  linkPurchaseItemToExpense,
  listSupplierQuotes,
  MATERIAL_SUPPLIER_QUOTE_SCHEMA_SOURCE,
  MATERIALS_SUPPLIERS_SCHEMA_SOURCE,
  parseQuotedAt,
  quoteCostForNeededQuantity,
  recordSupplierQuote,
  selectSupplierQuoteForPurchaseList,
  SUPPLIER_COMMERCE_DISCONNECTED_LIMITATION,
  SUPPLIER_INTEGRATION_LICENSING_NOTICE,
  updatePurchaseListItem,
} = await import("@/lib/materials");

const testDbName = "tbbt_supplier_quote_compare_test";
const testParsed = new URL(baseUrl);
testParsed.pathname = `/${testDbName}`;
const testUrl = testParsed.toString();
process.env.DATABASE_URL = testUrl;

const adminUrl = new URL(baseUrl);
adminUrl.search = "";

function dropTestDatabase() {
  const terminate = spawnSync(
    "psql",
    [
      adminUrl.toString(),
      "-c",
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${testDbName}' AND pid <> pg_backend_pid()`,
    ],
    { encoding: "utf8" },
  );
  if (terminate.status !== 0) {
    throw new Error(terminate.stderr || terminate.stdout || "Failed to terminate test-db connections.");
  }
  const drop = spawnSync(
    "psql",
    [adminUrl.toString(), "-c", `DROP DATABASE IF EXISTS "${testDbName}"`],
    { encoding: "utf8" },
  );
  if (drop.status !== 0) {
    throw new Error(drop.stderr || drop.stdout || "Failed to drop the supplier-quote compare test database.");
  }
}

const terminateExisting = spawnSync(
  "psql",
  [
    adminUrl.toString(),
    "-c",
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${testDbName}' AND pid <> pg_backend_pid()`,
  ],
  { encoding: "utf8" },
);
if (terminateExisting.status !== 0) {
  console.warn(terminateExisting.stderr || terminateExisting.stdout);
}
const dropExisting = spawnSync(
  "psql",
  [adminUrl.toString(), "-c", `DROP DATABASE IF EXISTS "${testDbName}"`],
  { encoding: "utf8" },
);
if (dropExisting.status !== 0) {
  console.warn(dropExisting.stderr || dropExisting.stdout);
}
const createDb = spawnSync("psql", [adminUrl.toString(), "-c", `CREATE DATABASE "${testDbName}"`], {
  encoding: "utf8",
});
if (createDb.status !== 0 && !/already exists/i.test(`${createDb.stderr}${createDb.stdout}`)) {
  console.error(createDb.stderr || createDb.stdout);
  process.exit(createDb.status ?? 1);
}

const migrate = spawnSync("npx", ["prisma", "migrate", "deploy"], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: testUrl },
});
if (migrate.status !== 0) {
  console.error("Failed to migrate the supplier-quote compare test database.");
  try {
    dropTestDatabase();
  } catch (error) {
    console.error(error);
  }
  process.exit(migrate.status ?? 1);
}

const require = createRequire(import.meta.url);
const { Prisma, PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });
const prismaRace = new PrismaClient({ datasourceUrl: testUrl });
const prismaHold = new PrismaClient({ datasourceUrl: testUrl });

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
    workspace: { role, membership: { id: membershipId }, business: { id: businessId } },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

async function waitUntil(predicate, timeoutMs, message) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(message);
}

async function waitForGrantedPurchaseListItemLock(client) {
  return waitUntil(
    async () => {
      const rows = await client.$queryRaw`
        SELECT l.pid
        FROM pg_locks l
        JOIN pg_class c ON c.oid = l.relation
        JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE c.relname = 'MaterialPurchaseListItem'
          AND l.granted
          AND a.datname = current_database()
          AND a.state IN ('active', 'idle in transaction')
          AND a.pid <> pg_backend_pid()
      `;
      return rows[0]?.pid ?? null;
    },
    10000,
    "Timed out waiting for contender A to hold the purchase-list item lock",
  );
}

async function waitForBlockedByPid(client, blockerPid) {
  return waitUntil(
    async () => {
      const rows = await client.$queryRaw`
        SELECT pid
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND pid <> pg_backend_pid()
          AND ${blockerPid} = ANY (pg_blocking_pids(pid))
      `;
      return rows[0]?.pid ?? null;
    },
    10000,
    `Timed out waiting for contender B to block on pid ${blockerPid}`,
  );
}

try {
  console.log("\nSTATIC — Append-only quotes, no scrape, reserved migration");
  const quotesSrc = readRepo("src/lib/materials/quotes.ts");
  const unitsSrc = readRepo("src/lib/materials/units.ts");
  const typesSrc = readRepo("src/lib/materials/types.ts");
  const adapterSrc = readRepo("src/lib/materials/adapter.ts");
  const actionsSrc = readRepo("src/app/actions/materials.ts");
  const purchaseSrc = readRepo("src/lib/materials/purchase.ts");
  const expenseLinkSrc = readRepo("src/lib/materials/expense-link.ts");
  const schema = readRepo("prisma/schema.prisma");
  const migration = readRepo(
    "prisma/migrations/20261002181000_material_supplier_quotes/migration.sql",
  );
  const materialsSchema = readRepo("src/lib/materials/schema.ts");
  check(
    "Reserved migration timestamp is exactly 20261002181000_material_supplier_quotes",
    materialsSchema.includes("20261002181000_material_supplier_quotes") &&
      !materialsSchema.includes("20261002180000_material_supplier_quotes") &&
      migration.includes('CREATE TABLE IF NOT EXISTS "MaterialSupplierQuote"') &&
      migration.includes('ADD COLUMN IF NOT EXISTS "selectedQuoteId"'),
  );
  check(
    "Quote migration is additive and stores no credentials",
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migration) &&
      !/"password"/i.test(migration) &&
      !/"apiSecret"/i.test(migration),
  );
  check(
    "Quote rows are append-only creates and never rewrite snapshots",
    quotesSrc.includes("materialSupplierQuote.create") &&
      !quotesSrc.includes("materialSupplierQuote.update") &&
      !quotesSrc.includes("materialSupplierQuote.delete") &&
      !quotesSrc.includes("supplierPriceRecord") &&
      !quotesSrc.includes("estimateVersion") &&
      !quotesSrc.includes("createInvoice") &&
      !quotesSrc.includes("createCartHandoff") &&
      quotesSrc.includes("never rewrites") &&
      schema.includes("model MaterialSupplierQuote") &&
      schema.includes("Append-only"),
  );
  check(
    "Request paths execute no schema DDL and stay migrate-authored",
    MATERIAL_SUPPLIER_QUOTE_SCHEMA_SOURCE === "prisma-migrate" &&
      MATERIALS_SUPPLIERS_SCHEMA_SOURCE === "prisma-migrate" &&
      !quotesSrc.includes("$executeRawUnsafe") &&
      !quotesSrc.includes("CREATE TABLE") &&
      !actionsSrc.includes('readString(formData, "businessId")') &&
      actionsSrc.includes("requireBusinessRole(operating.access, \"OWNER\")"),
  );
  check(
    "No retailer scrape or live order path in quote/unit code",
    !quotesSrc.includes("cheerio") &&
      !quotesSrc.includes("puppeteer") &&
      !unitsSrc.includes("cheerio") &&
      adapterSrc.includes('connectionState: "DISCONNECTED"') &&
      adapterSrc.includes("TBBT does not scrape"),
  );
  const workspaceSrc = readRepo("src/components/materials/materials-workspace.tsx");
  const compareViewSrc = readRepo("src/components/materials/supplier-quote-compare.tsx");
  check(
    "Converted unit price is not rounded to cents before multiplication",
    !unitsSrc.includes("unitPrice.div(factor).toDecimalPlaces(2)") &&
      unitsSrc.includes("quoteCostForNeededQuantity") &&
      quotesSrc.includes("quoteCostForNeededQuantity") &&
      quotesSrc.includes("priced.plannedUnitCost"),
  );
  check(
    "Quote dates use the business timezone and reject the future",
    quotesSrc.includes("parseCivilDateInTimeZone") &&
      quotesSrc.includes("Quote date cannot be in the future") &&
      workspaceSrc.includes("quoteDateDefault") &&
      !workspaceSrc.includes("toISOString().slice(0, 10)") &&
      compareViewSrc.includes("quotedOnLabel") &&
      !compareViewSrc.includes("toLocaleDateString"),
  );
  check(
    "Quote selection is limited to NEEDED/PLANNED items with no active PO line",
    typesSrc.includes('"NEEDED"') &&
      typesSrc.includes('"PLANNED"') &&
      !/PURCHASE_ITEM_QUOTE_SELECTABLE_STATUSES = \[[^\]]*ORDERED/.test(typesSrc) &&
      quotesSrc.includes("already on a purchase order") &&
      quotesSrc.includes('status: { not: "CANCELLED" }'),
  );
  check(
    "Edit-save keeps quoted plannedCost and expense-link uses plannedCost / quantity",
    purchaseSrc.includes("postedDecimalEqualsStored") &&
      purchaseSrc.includes("quoteCostForNeededQuantity") &&
      purchaseSrc.includes("clearSelectedQuote") &&
      expenseLinkSrc.includes("plannedCost.div(item.quantityNeeded)"),
  );
  check(
    "createPurchaseOrder locks candidate items FOR UPDATE in a transaction",
    purchaseSrc.includes("lockTenantOwnedPurchaseListItem") &&
      purchaseSrc.includes("$transaction") &&
      purchaseSrc.includes('item.supplierId !== input.supplierId'),
  );

  const liveAdapter = getSupplierCommerceAdapter();
  const lookup = await liveAdapter.lookupProduct("lumber");
  const quote = await liveAdapter.quotePrice("any");
  const availability = await liveAdapter.checkAvailability("any");
  const handoff = await liveAdapter.createCartHandoff({ productIds: ["any"] });
  check(
    "Runtime adapter stays DISCONNECTED and places no order",
    liveAdapter.connectionState === "DISCONNECTED" &&
      liveAdapter.limitation === SUPPLIER_COMMERCE_DISCONNECTED_LIMITATION &&
      liveAdapter.licensingNotice === SUPPLIER_INTEGRATION_LICENSING_NOTICE &&
      lookup === null &&
      quote.price === null &&
      availability.available === null &&
      handoff.placed === false,
  );

  console.log("\nTEST — Unit conversions");
  const ydToFt = convertMaterialQuoteUnits({
    quantity: "2",
    unitPrice: "12.00",
    fromUnit: "yd",
    toUnit: "ft",
  });
  check(
    "Yards convert to feet with exact unit-price division",
    ydToFt.quantity.toString() === "6" &&
      ydToFt.unitPrice.toString() === "4" &&
      ydToFt.factor.toString() === "3",
  );
  const inchesToFt = convertMaterialQuoteUnits({
    quantity: "36",
    unitPrice: "0.50",
    fromUnit: "in",
    toUnit: "ft",
  });
  check(
    "36 inches convert to exactly 3 feet",
    inchesToFt.quantity.toString() === "3" && inchesToFt.unitPrice.toString() === "6",
  );
  const cyToCf = convertMaterialQuoteUnits({
    quantity: "1",
    unitPrice: "135.00",
    fromUnit: "cy",
    toUnit: "cf",
  });
  check(
    "1 cubic yard is 27 cubic feet at $5.00/cf",
    cyToCf.quantity.toString() === "27" && cyToCf.unitPrice.toString() === "5",
  );
  const bagToEach = convertMaterialQuoteUnits({
    quantity: "2",
    unitPrice: "8.00",
    fromUnit: "bag",
    toUnit: "ea",
    packSize: "80",
  });
  check(
    "Pack size converts bag quotes to each",
    bagToEach.quantity.toString() === "160" && bagToEach.unitPrice.toString() === "0.1",
  );
  await expectError(
    "Incompatible units are refused",
    async () =>
      convertMaterialQuoteUnits({
        quantity: "1",
        unitPrice: "4.00",
        fromUnit: "ft",
        toUnit: "bag",
      }),
    (error) => /cannot be converted/i.test(String(error.message)),
  );

  const tenPerYard = convertMaterialQuoteUnits({
    quantity: "1",
    unitPrice: "10.00",
    fromUnit: "yd",
    toUnit: "ft",
  });
  const yardNeed = quoteCostForNeededQuantity({
    unitPrice: "10.00",
    fromUnit: "yd",
    toUnit: "ft",
    neededQuantity: "300",
    deliveryCost: "0",
  });
  const inchNeed = quoteCostForNeededQuantity({
    unitPrice: "1.00",
    fromUnit: "in",
    toUnit: "ft",
    neededQuantity: "10",
    deliveryCost: "0",
  });
  const bagNeed = quoteCostForNeededQuantity({
    unitPrice: "1.00",
    fromUnit: "bag",
    toUnit: "ea",
    neededQuantity: "8000",
    deliveryCost: "0",
    packSize: "80",
  });
  const tonNeed = quoteCostForNeededQuantity({
    unitPrice: "1.00",
    fromUnit: "ton",
    toUnit: "lb",
    neededQuantity: "20000",
    deliveryCost: "0",
  });
  check(
    "Non-terminating yd→ft keeps the unrounded unit price and exact $1000 total",
    tenPerYard.unitPrice.toString() !== "3.33" &&
      tenPerYard.unitPrice.eq(new Prisma.Decimal(10).div(3)) &&
      yardNeed.plannedCost.toString() === "1000" &&
      yardNeed.plannedUnitCost.eq(yardNeed.materialCost.div(300)) &&
      !yardNeed.plannedUnitCost.eq(new Prisma.Decimal("3.33")),
  );
  check(
    "in→ft, bag→ea at $1, and ton→lb round once at the landed total",
    inchNeed.plannedCost.toString() === "120" &&
      bagNeed.plannedCost.toString() === "100" &&
      bagNeed.plannedUnitCost.toString() === "0.0125" &&
      tonNeed.plannedCost.toString() === "10" &&
      tonNeed.plannedUnitCost.toString() === "0.0005",
  );

  const now = new Date("2026-10-02T17:00:00.000Z");
  const lateEveningUtc = new Date("2026-10-03T01:00:00.000Z");
  check(
    "Quotes older than 7 days are stale",
    classifySupplierQuoteFreshness(new Date("2026-09-20T17:00:00.000Z"), now) === "stale" &&
      classifySupplierQuoteFreshness(new Date("2026-10-02T12:00:00.000Z"), now) === "current" &&
      classifySupplierQuoteFreshness(new Date("2026-09-28T17:00:00.000Z"), now) === "recently_checked",
  );
  check(
    "Future-dated quotes are stale, not current",
    classifySupplierQuoteFreshness(new Date("2099-01-01T00:00:00.000Z"), now) === "stale" &&
      classifySupplierQuoteFreshness("2099-01-01", now) === "stale",
  );
  const storedCivil = parseQuotedAt("2026-10-02", "America/New_York", now);
  check(
    "Date-only quotes store the business-local civil day, not UTC midnight",
    storedCivil.toISOString() === "2026-10-02T04:00:00.000Z" &&
      storedCivil.toISOString() !== new Date("2026-10-02").toISOString(),
  );
  check(
    "Form default is the business-local date after 8pm ET",
    businessLocalQuoteDateInput(lateEveningUtc, "America/New_York") === "2026-10-02" &&
      lateEveningUtc.toISOString().slice(0, 10) === "2026-10-03",
  );
  await expectError(
    "Future quote dates are rejected",
    async () => parseQuotedAt("2099-01-01", "America/New_York", now),
    (error) => /future/i.test(String(error.message)),
  );
  await expectError(
    "Invalid civil date 2026-02-30 is rejected instead of rolling to March 2",
    async () => parseQuotedAt("2026-02-30", "America/New_York", now),
    (error) => /valid quote date/i.test(String(error.message)),
  );

  const ownerUser = await prisma.user.create({
    data: { name: "Quote Owner", email: `quote-owner-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Quote Admin", email: `quote-admin-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Quote Member", email: `quote-member-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Quote Beta", email: `quote-beta-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const businessA = await prisma.business.create({
    data: { name: "Alpha Quotes", slug: `alpha-quote-${randomUUID().slice(0, 8)}` },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Quotes", slug: `beta-quote-${randomUUID().slice(0, 8)}` },
  });
  const ownerMem = await prisma.membership.create({
    data: { businessId: businessA.id, userId: ownerUser.id, role: "OWNER" },
  });
  const adminMem = await prisma.membership.create({
    data: { businessId: businessA.id, userId: adminUser.id, role: "ADMIN" },
  });
  const memberMem = await prisma.membership.create({
    data: { businessId: businessA.id, userId: memberUser.id, role: "MEMBER" },
  });
  const betaMem = await prisma.membership.create({
    data: { businessId: businessB.id, userId: betaUser.id, role: "OWNER" },
  });
  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaMem.id);

  const depot = await createSupplier(prisma, ownerA, { name: "Sparks Building Supply", preferred: true });
  const yard = await createSupplier(prisma, ownerA, { name: "Reno Lumber Yard" });
  const betaSupplier = await createSupplier(prisma, ownerB, { name: "Beta Hardware" });
  const lumber = await createMaterialCatalogItem(prisma, ownerA, {
    name: "Pressure-treated 2x4",
    unit: "ft",
    packSize: "1",
    preferredSupplierId: depot.id,
    lastKnownCost: "4.25",
    category: "Lumber",
  });
  const bags = await createMaterialCatalogItem(prisma, ownerA, {
    name: "Concrete bags",
    unit: "ea",
    packSize: "1",
    lastKnownCost: "6.47",
  });
  const betaLumber = await createMaterialCatalogItem(prisma, ownerB, {
    name: "Beta 2x4",
    unit: "ft",
    lastKnownCost: "3.00",
  });

  console.log("\nTEST — OWNER records two or more dated quotes");
  const currentQuote = await recordSupplierQuote(prisma, ownerA, {
    materialId: lumber.id,
    supplierId: depot.id,
    quotedAt: "2026-10-02",
    unit: "yd",
    unitPrice: "12.00",
    quantity: "10",
    deliveryCost: "15.00",
    availability: "IN_STOCK",
    notes: "Counter quote",
  });
  const cheaperQuote = await recordSupplierQuote(prisma, ownerA, {
    materialId: lumber.id,
    supplierId: yard.id,
    quotedAt: "2026-10-01",
    unit: "ft",
    unitPrice: "3.80",
    quantity: "30",
    deliveryCost: "25.00",
    availability: "LIMITED",
  });
  const staleQuote = await recordSupplierQuote(prisma, ownerA, {
    materialId: lumber.id,
    supplierId: depot.id,
    quotedAt: "2026-09-10",
    unit: "ft",
    unitPrice: "3.50",
    quantity: "30",
    deliveryCost: "10.00",
    availability: "IN_STOCK",
    notes: "Last month",
  });
  const bagQuote = await recordSupplierQuote(prisma, ownerA, {
    materialId: bags.id,
    supplierId: depot.id,
    quotedAt: "2026-10-02",
    unit: "bag",
    unitPrice: "6.47",
    quantity: "20",
    deliveryCost: "0",
    availability: "IN_STOCK",
  });
  const quotesAfterRecord = await listSupplierQuotes(prisma, ownerA, lumber.id);
  check(
    "Two or more dated quotes exist for the same material and keep original amounts",
    quotesAfterRecord.length === 3 &&
      quotesAfterRecord.some((row) => row.id === currentQuote.id && row.unitPrice.toString() === "12") &&
      quotesAfterRecord.some((row) => row.id === cheaperQuote.id && row.deliveryCost.toString() === "25") &&
      quotesAfterRecord.some((row) => row.id === staleQuote.id && row.notes === "Last month"),
  );

  await expectError(
    "ADMIN cannot record a supplier quote",
    () =>
      recordSupplierQuote(prisma, adminA, {
        materialId: lumber.id,
        supplierId: depot.id,
        quotedAt: "2026-10-02",
        unit: "ft",
        unitPrice: "9.99",
        quantity: "1",
      }),
    (error) => error instanceof ForbiddenError || error.name === "ForbiddenError",
  );
  await expectError(
    "MEMBER cannot record a supplier quote",
    () =>
      recordSupplierQuote(prisma, memberA, {
        materialId: lumber.id,
        supplierId: depot.id,
        quotedAt: "2026-10-02",
        unit: "ft",
        unitPrice: "9.99",
        quantity: "1",
      }),
    (error) => error instanceof ForbiddenError || error.name === "ForbiddenError",
  );

  console.log("\nTEST — Compare unit price, quantity, delivery, availability");
  const compared = await compareSupplierQuotes(prisma, ownerA, {
    materialId: lumber.id,
    targetUnit: "ft",
    neededQuantity: "30",
    now: new Date("2026-10-02T17:00:00.000Z"),
  });
  const currentRow = compared.find((row) => row.quoteId === currentQuote.id);
  const cheaperRow = compared.find((row) => row.quoteId === cheaperQuote.id);
  const staleRow = compared.find((row) => row.quoteId === staleQuote.id);
  check(
    "Comparison converts unit price and quantity and keeps delivery plus availability",
    currentRow?.comparableUnitPrice === "4" &&
      currentRow?.comparableQuantity === "30" &&
      currentRow?.deliveryCost === "15" &&
      currentRow?.availability === "IN_STOCK" &&
      currentRow?.quoteLandedTotal === "135" &&
      currentRow?.neededLandedTotal === "135" &&
      cheaperRow?.neededLandedTotal === "139" &&
      cheaperRow?.availability === "LIMITED" &&
      currentRow?.lowestLanded === true,
  );
  check(
    "Stale quote is flagged and still compared",
    staleRow?.stale === true &&
      staleRow?.freshness === "stale" &&
      staleRow?.neededLandedTotal === "115",
  );
  check(
    "Compared quote dates stay on the business-local civil day",
    currentRow?.quotedOn === "2026-10-02" &&
      currentRow?.quotedOnLabel.includes("Oct 2") &&
      cheaperRow?.quotedOn === "2026-10-01",
  );

  const longStock = await createMaterialCatalogItem(prisma, ownerA, {
    name: "Long stock",
    unit: "ft",
    packSize: "1",
  });
  const yardTen = await recordSupplierQuote(prisma, ownerA, {
    materialId: longStock.id,
    supplierId: depot.id,
    quotedAt: "2026-10-02",
    unit: "yd",
    unitPrice: "10.00",
    quantity: "1",
    deliveryCost: "0",
    availability: "IN_STOCK",
  });
  const footThreeThirtyThree = await recordSupplierQuote(prisma, ownerA, {
    materialId: longStock.id,
    supplierId: yard.id,
    quotedAt: "2026-10-02",
    unit: "ft",
    unitPrice: "3.33",
    quantity: "1",
    deliveryCost: "0",
    availability: "IN_STOCK",
  });
  const longCompared = await compareSupplierQuotes(prisma, ownerA, {
    materialId: longStock.id,
    targetUnit: "ft",
    neededQuantity: "300",
    now,
  });
  const yardTenRow = longCompared.find((row) => row.quoteId === yardTen.id);
  const footRow = longCompared.find((row) => row.quoteId === footThreeThirtyThree.id);
  check(
    "$10/yd for 300 ft is $1000.00 and does not tie $3.33/ft at $999.00",
    yardTenRow?.neededLandedTotal === "1000" &&
      yardTenRow?.comparableUnitPrice === "3.33" &&
      yardTenRow?.lowestLanded === false &&
      footRow?.neededLandedTotal === "999" &&
      footRow?.lowestLanded === true,
  );

  const bagPacks = await createMaterialCatalogItem(prisma, ownerA, {
    name: "Mortar bags",
    unit: "ea",
    packSize: "80",
  });
  const cheapBag = await recordSupplierQuote(prisma, ownerA, {
    materialId: bagPacks.id,
    supplierId: depot.id,
    quotedAt: "2026-10-02",
    unit: "bag",
    unitPrice: "1.00",
    quantity: "1",
    deliveryCost: "0",
    availability: "IN_STOCK",
  });
  const bagCompared = await compareSupplierQuotes(prisma, ownerA, {
    materialId: bagPacks.id,
    targetUnit: "ea",
    neededQuantity: "8000",
    now,
  });
  check(
    "$1/bag pack 80 for 8000 ea is $100.00, not $80.00",
    bagCompared[0]?.quoteId === cheapBag.id && bagCompared[0]?.neededLandedTotal === "100",
  );

  const gravel = await createMaterialCatalogItem(prisma, ownerA, {
    name: "Gravel",
    unit: "lb",
  });
  const tonQuote = await recordSupplierQuote(prisma, ownerA, {
    materialId: gravel.id,
    supplierId: depot.id,
    quotedAt: "2026-10-02",
    unit: "ton",
    unitPrice: "1.00",
    quantity: "1",
    deliveryCost: "0",
    availability: "IN_STOCK",
  });
  const tonCompared = await compareSupplierQuotes(prisma, ownerA, {
    materialId: gravel.id,
    targetUnit: "lb",
    neededQuantity: "20000",
    now,
  });
  check(
    "$1/ton for 20000 lb is $10.00, not $0.00",
    tonCompared[0]?.quoteId === tonQuote.id && tonCompared[0]?.neededLandedTotal === "10",
  );

  console.log("\nTEST — Tenant isolation");
  await expectError(
    "Business B cannot list Business A quotes",
    () => listSupplierQuotes(prisma, ownerB, lumber.id),
    (error) => error instanceof Error,
  );
  await expectError(
    "Business B cannot record a quote on Business A material",
    () =>
      recordSupplierQuote(prisma, ownerB, {
        materialId: lumber.id,
        supplierId: betaSupplier.id,
        quotedAt: "2026-10-02",
        unit: "ft",
        unitPrice: "1.00",
        quantity: "1",
      }),
    (error) => error instanceof Error,
  );
  const betaQuote = await recordSupplierQuote(prisma, ownerB, {
    materialId: betaLumber.id,
    supplierId: betaSupplier.id,
    quotedAt: "2026-10-02",
    unit: "ft",
    unitPrice: "2.00",
    quantity: "10",
    deliveryCost: "5",
    availability: "IN_STOCK",
  });
  const aQuotes = await listSupplierQuotes(prisma, ownerA, lumber.id);
  const bQuotes = await listSupplierQuotes(prisma, ownerB, betaLumber.id);
  check(
    "Each tenant only sees its own quotes",
    aQuotes.every((row) => row.businessId === businessA.id) &&
      bQuotes.every((row) => row.businessId === businessB.id) &&
      !aQuotes.some((row) => row.id === betaQuote.id) &&
      !bQuotes.some((row) => row.id === currentQuote.id),
  );

  console.log("\nTEST — Exact totals, snapshot freeze, original quotes preserved");
  const customer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Pat", email: `pat-quote-${randomUUID()}@example.com` },
  });
  const estimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "DRAFT",
      publicToken: randomUUID(),
      total: 400,
    },
  });
  const estimateLine = await prisma.lineItem.create({
    data: {
      businessId: businessA.id,
      estimateId: estimate.id,
      description: "Framing lumber",
      quantity: 1,
      unitPrice: 400,
      total: 400,
      type: "LABOR",
    },
  });
  await prisma.estimate.update({
    where: { id: estimate.id },
    data: { status: "SENT" },
  });
  const version = await createEstimateVersionSnapshot(prisma, {
    estimateId: estimate.id,
    businessId: businessA.id,
  });
  const frozenVersionLines = await prisma.estimateVersionLineItem.findMany({
    where: { estimateVersionId: version.id, businessId: businessA.id },
  });
  const job = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      estimateId: estimate.id,
      assignedMembershipId: memberMem.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      jobId: job.id,
      status: "SENT",
      total: 400,
    },
  });
  const invoiceLine = await prisma.lineItem.create({
    data: {
      businessId: businessA.id,
      invoiceId: invoice.id,
      description: "Framing lumber",
      quantity: 1,
      unitPrice: 400,
      total: 400,
      type: "LABOR",
    },
  });
  const list = await ensurePurchaseList(prisma, ownerA, { estimateId: estimate.id });
  await prisma.materialPurchaseList.update({
    where: { id: list.id },
    data: { jobId: job.id },
  });
  const listItem = await addPurchaseListItem(prisma, ownerA, {
    purchaseListId: list.id,
    materialId: lumber.id,
    name: lumber.name,
    quantityNeeded: "30",
    unit: "ft",
    plannedUnitCost: "4.25",
  });
  const priceRecordsBefore = await prisma.supplierPriceRecord.count({
    where: { businessId: businessA.id },
  });
  const historyBefore = await prisma.materialPriceHistory.findMany({
    where: { businessId: businessA.id, materialId: lumber.id },
    orderBy: { createdAt: "asc" },
  });

  await expectError(
    "Stale quote cannot be selected without explicit acceptance",
    () =>
      selectSupplierQuoteForPurchaseList(prisma, ownerA, {
        purchaseListItemId: listItem.id,
        quoteId: staleQuote.id,
        expectedSelectedQuoteId: null,
        now: new Date("2026-10-02T17:00:00.000Z"),
      }),
    (error) => /stale/i.test(String(error.message)),
  );

  const selected = await selectSupplierQuoteForPurchaseList(prisma, ownerA, {
    purchaseListItemId: listItem.id,
    quoteId: currentQuote.id,
    expectedSelectedQuoteId: null,
    now: new Date("2026-10-02T17:00:00.000Z"),
  });
  const itemAfter = await prisma.materialPurchaseListItem.findUnique({
    where: { id: listItem.id },
  });
  check(
    "Selection applies converted unit price plus delivery as an exact landed total",
    selected.plannedUnitCost.toString() === "4" &&
      selected.plannedCost.toString() === "135" &&
      itemAfter.selectedQuoteId === currentQuote.id &&
      itemAfter.supplierId === depot.id &&
      itemAfter.plannedUnitCost.toString() === "4" &&
      itemAfter.plannedCost.toString() === "135" &&
      itemAfter.status === "PLANNED" &&
      itemAfter.quantityNeeded.toString() === "30",
  );

  const quotesAfterSelect = await prisma.materialSupplierQuote.findMany({
    where: { id: { in: [currentQuote.id, cheaperQuote.id, staleQuote.id] } },
    orderBy: { createdAt: "asc" },
  });
  const versionAfter = await prisma.estimateVersion.findUnique({
    where: { id: version.id },
    include: { lineItems: true },
  });
  const invoiceAfter = await prisma.invoice.findUnique({
    where: { id: invoice.id },
  });
  const invoiceLineAfter = await prisma.lineItem.findUnique({
    where: { id: invoiceLine.id },
  });
  const estimateLineAfter = await prisma.lineItem.findUnique({
    where: { id: estimateLine.id },
  });
  const priceRecordsAfter = await prisma.supplierPriceRecord.count({
    where: { businessId: businessA.id },
  });
  const historyAfter = await prisma.materialPriceHistory.findMany({
    where: { businessId: businessA.id, materialId: lumber.id },
    orderBy: { createdAt: "asc" },
  });
  check(
    "Original quote rows are unchanged after selection",
    quotesAfterSelect.length === 3 &&
      quotesAfterSelect.every((row) => {
        const before = [currentQuote, cheaperQuote, staleQuote].find((quoteRow) => quoteRow.id === row.id);
        return (
          before &&
          row.unitPrice.toString() === before.unitPrice.toString() &&
          row.quantity.toString() === before.quantity.toString() &&
          row.deliveryCost.toString() === before.deliveryCost.toString() &&
          row.quotedAt.toISOString() === before.quotedAt.toISOString() &&
          row.availability === before.availability
        );
      }),
  );
  check(
    "Sent estimate snapshot and invoice snapshot stay frozen",
    versionAfter.lineItems.length === frozenVersionLines.length &&
      versionAfter.lineItems.every((row, index) => {
        const before = frozenVersionLines[index];
        return (
          row.description === before.description &&
          row.unitPrice.toString() === before.unitPrice.toString() &&
          row.total.toString() === before.total.toString()
        );
      }) &&
      invoiceAfter.total.toString() === "400" &&
      invoiceLineAfter.unitPrice.toString() === "400" &&
      invoiceLineAfter.total.toString() === "400" &&
      estimateLineAfter.unitPrice.toString() === "400" &&
      estimateLineAfter.total.toString() === "400",
  );
  check(
    "Selection does not write SupplierPriceRecord or rewrite price history",
    priceRecordsBefore === 0 &&
      priceRecordsAfter === 0 &&
      historyAfter.length === historyBefore.length &&
      historyAfter.every((row, index) => row.id === historyBefore[index].id && row.price.toString() === historyBefore[index].price.toString()),
  );

  await expectError(
    "ADMIN cannot select a quote onto a purchase list",
    () =>
      selectSupplierQuoteForPurchaseList(prisma, adminA, {
        purchaseListItemId: listItem.id,
        quoteId: cheaperQuote.id,
        expectedSelectedQuoteId: currentQuote.id,
        now: new Date("2026-10-02T17:00:00.000Z"),
      }),
    (error) => error instanceof ForbiddenError || error.name === "ForbiddenError",
  );
  await expectError(
    "Business B cannot select Business A quote",
    () =>
      selectSupplierQuoteForPurchaseList(prisma, ownerB, {
        purchaseListItemId: listItem.id,
        quoteId: currentQuote.id,
        expectedSelectedQuoteId: currentQuote.id,
      }),
    (error) => error instanceof Error,
  );

  const staleAccepted = await selectSupplierQuoteForPurchaseList(prisma, ownerA, {
    purchaseListItemId: listItem.id,
    quoteId: staleQuote.id,
    expectedSelectedQuoteId: currentQuote.id,
    acceptStale: true,
    now: new Date("2026-10-02T17:00:00.000Z"),
  });
  check(
    "Explicit stale acceptance applies exact totals without rewriting the quote",
    staleAccepted.plannedUnitCost.toString() === "3.5" &&
      staleAccepted.plannedCost.toString() === "115" &&
      staleAccepted.quote.unitPrice.toString() === "3.5",
  );

  const bagList = await ensurePurchaseList(prisma, ownerA, {
    estimateId: (
      await prisma.estimate.create({
        data: {
          businessId: businessA.id,
          customerId: customer.id,
          status: "DRAFT",
          publicToken: randomUUID(),
        },
      })
    ).id,
  });
  const bagItem = await addPurchaseListItem(prisma, ownerA, {
    purchaseListId: bagList.id,
    materialId: bags.id,
    name: bags.name,
    quantityNeeded: "20",
    unit: "ea",
  });
  const bagSelected = await selectSupplierQuoteForPurchaseList(prisma, ownerA, {
    purchaseListItemId: bagItem.id,
    quoteId: bagQuote.id,
    expectedSelectedQuoteId: null,
    now: new Date("2026-10-02T17:00:00.000Z"),
  });
  check(
    "Zero delivery keeps an exact material-only total",
    bagSelected.plannedUnitCost.toString() === "6.47" &&
      bagSelected.plannedCost.toString() === "129.4",
  );

  const longList = await ensurePurchaseList(prisma, ownerA, {
    estimateId: (
      await prisma.estimate.create({
        data: {
          businessId: businessA.id,
          customerId: customer.id,
          status: "DRAFT",
          publicToken: randomUUID(),
        },
      })
    ).id,
  });
  const longItem = await addPurchaseListItem(prisma, ownerA, {
    purchaseListId: longList.id,
    materialId: longStock.id,
    name: longStock.name,
    quantityNeeded: "300",
    unit: "ft",
  });
  const longSelected = await selectSupplierQuoteForPurchaseList(prisma, ownerA, {
    purchaseListItemId: longItem.id,
    quoteId: yardTen.id,
    expectedSelectedQuoteId: null,
    now,
  });
  check(
    "Selection stores exact $1000 plannedCost and a unit cost derived from that total",
    longSelected.plannedCost.toString() === "1000" &&
      longSelected.plannedUnitCost.eq(new Prisma.Decimal(1000).div(300)) &&
      !longSelected.plannedUnitCost.eq(new Prisma.Decimal("3.33")),
  );

  const bagPackItem = await addPurchaseListItem(prisma, ownerA, {
    purchaseListId: longList.id,
    materialId: bagPacks.id,
    name: bagPacks.name,
    quantityNeeded: "8000",
    unit: "ea",
  });
  const bagPackSelected = await selectSupplierQuoteForPurchaseList(prisma, ownerA, {
    purchaseListItemId: bagPackItem.id,
    quoteId: cheapBag.id,
    expectedSelectedQuoteId: null,
    now,
  });
  check(
    "Selection of $1/bag for 8000 ea stores $100.00, not $80.00",
    bagPackSelected.plannedCost.toString() === "100" &&
      bagPackSelected.plannedUnitCost.toString() === "0.0125",
  );

  await expectError(
    "Future-dated quote cannot be recorded",
    () =>
      recordSupplierQuote(prisma, ownerA, {
        materialId: lumber.id,
        supplierId: depot.id,
        quotedAt: "2099-01-01",
        unit: "ft",
        unitPrice: "1.00",
        quantity: "1",
      }),
    (error) => /future/i.test(String(error.message)),
  );

  console.log("\nTEST — Edit-save keeps quoted plannedCost");
  const landedYard = await recordSupplierQuote(prisma, ownerA, {
    materialId: longStock.id,
    supplierId: depot.id,
    quotedAt: "2026-10-02",
    unit: "yd",
    unitPrice: "10.00",
    quantity: "1",
    deliveryCost: "5.00",
    availability: "IN_STOCK",
  });
  const saveItem = await addPurchaseListItem(prisma, ownerA, {
    purchaseListId: longList.id,
    materialId: longStock.id,
    name: longStock.name,
    quantityNeeded: "300",
    unit: "ft",
  });
  const saveSelected = await selectSupplierQuoteForPurchaseList(prisma, ownerA, {
    purchaseListItemId: saveItem.id,
    quoteId: landedYard.id,
    expectedSelectedQuoteId: null,
    now,
  });
  const afterNotes = await updatePurchaseListItem(prisma, ownerA, {
    itemId: saveItem.id,
    name: longStock.name,
    quantityNeeded: "300",
    unit: "ft",
    plannedUnitCost: saveSelected.plannedUnitCost.toString(),
    supplierId: depot.id,
    status: "PLANNED",
    notes: "notes only",
  });
  check(
    "Notes-only save after $10/yd + $5 delivery keeps plannedCost 1005.00",
    saveSelected.plannedCost.toString() === "1005" &&
      afterNotes.plannedCost.toString() === "1005" &&
      afterNotes.plannedUnitCost.eq(saveSelected.plannedUnitCost) &&
      afterNotes.selectedQuoteId === landedYard.id &&
      afterNotes.notes === "notes only",
  );
  const afterRoundedPost = await updatePurchaseListItem(prisma, ownerA, {
    itemId: saveItem.id,
    name: longStock.name,
    quantityNeeded: "300",
    unit: "ft",
    plannedUnitCost: "3.33",
    supplierId: depot.id,
    status: "PLANNED",
    notes: "still notes",
  });
  check(
    "Cents-rounded posted unit cost does not collapse a selected quote",
    afterRoundedPost.plannedCost.toString() === "1005" &&
      afterRoundedPost.selectedQuoteId === landedYard.id,
  );
  const afterSupplierEdit = await updatePurchaseListItem(prisma, ownerA, {
    itemId: saveItem.id,
    name: longStock.name,
    quantityNeeded: "300",
    unit: "ft",
    plannedUnitCost: afterRoundedPost.plannedUnitCost.toString(),
    supplierId: yard.id,
    status: "PLANNED",
    notes: "changed supplier",
  });
  check(
    "Changing supplierId clears the stale selectedQuoteId and keeps plannedCost",
    afterSupplierEdit.selectedQuoteId === null &&
      afterSupplierEdit.supplierId === yard.id &&
      afterSupplierEdit.plannedCost.toString() === "1005",
  );
  const expenseItem = await addPurchaseListItem(prisma, ownerA, {
    purchaseListId: longList.id,
    materialId: longStock.id,
    name: longStock.name,
    quantityNeeded: "300",
    unit: "ft",
  });
  await selectSupplierQuoteForPurchaseList(prisma, ownerA, {
    purchaseListItemId: expenseItem.id,
    quoteId: landedYard.id,
    expectedSelectedQuoteId: null,
    now,
  });
  const linkedExpense = await linkPurchaseItemToExpense(prisma, ownerA, {
    itemId: expenseItem.id,
    createExpense: true,
    occurredOn: "2026-10-02",
    quantityPurchased: "300",
  });
  check(
    "Expense-link uses plannedCost / quantity so delivery is not dropped",
    linkedExpense.actualCost.toString() === "1005",
  );

  console.log("\nTEST — Selection refuses items already on a purchase order");
  check(
    "ORDERED items are not quote-selectable",
    canSelectSupplierQuoteForPurchaseItem("NEEDED") &&
      canSelectSupplierQuoteForPurchaseItem("PLANNED") &&
      !canSelectSupplierQuoteForPurchaseItem("ORDERED") &&
      !canSelectSupplierQuoteForPurchaseItem("PURCHASED"),
  );
  const poItem = await addPurchaseListItem(prisma, ownerA, {
    purchaseListId: longList.id,
    materialId: lumber.id,
    name: lumber.name,
    quantityNeeded: "30",
    unit: "ft",
    plannedUnitCost: "4.00",
    supplierId: depot.id,
  });
  const poSelected = await selectSupplierQuoteForPurchaseList(prisma, ownerA, {
    purchaseListItemId: poItem.id,
    quoteId: currentQuote.id,
    expectedSelectedQuoteId: null,
    now,
  });
  const draftPo = await createPurchaseOrder(prisma, ownerA, {
    purchaseListId: longList.id,
    supplierId: depot.id,
    itemIds: [poItem.id],
  });
  const itemOnPo = await prisma.materialPurchaseListItem.findUnique({
    where: { id: poItem.id },
  });
  const poLineBefore = await prisma.materialPurchaseOrderItem.findFirst({
    where: { purchaseOrderId: draftPo.id, purchaseListItemId: poItem.id },
  });
  await expectError(
    "Selecting a different quote is refused while the item is on a DRAFT PO",
    () =>
      selectSupplierQuoteForPurchaseList(prisma, ownerA, {
        purchaseListItemId: poItem.id,
        quoteId: cheaperQuote.id,
        expectedSelectedQuoteId: currentQuote.id,
        now,
      }),
    (error) => /already on a purchase order/i.test(String(error.message)),
  );
  const itemAfterPoBlock = await prisma.materialPurchaseListItem.findUnique({
    where: { id: poItem.id },
  });
  const poAfterBlock = await prisma.materialPurchaseOrder.findUnique({
    where: { id: draftPo.id },
  });
  const poLineAfter = await prisma.materialPurchaseOrderItem.findFirst({
    where: { purchaseOrderId: draftPo.id, purchaseListItemId: poItem.id },
  });
  check(
    "PO membership keeps supplier A and the recorded unit cost",
    poSelected.plannedUnitCost.toString() === "4" &&
      itemOnPo.supplierId === depot.id &&
      itemAfterPoBlock.supplierId === depot.id &&
      itemAfterPoBlock.selectedQuoteId === currentQuote.id &&
      itemAfterPoBlock.plannedUnitCost.toString() === "4" &&
      itemAfterPoBlock.plannedCost.toString() === "135" &&
      poAfterBlock.supplierId === depot.id &&
      poLineBefore.unitCost.toString() === "4" &&
      poLineAfter.unitCost.toString() === "4",
  );

  await prisma.materialPurchaseListItem.update({
    where: { id: longItem.id },
    data: { status: "ORDERED" },
  });
  await expectError(
    "ORDERED items cannot take a supplier quote even without a PO line",
    () =>
      selectSupplierQuoteForPurchaseList(prisma, ownerA, {
        purchaseListItemId: longItem.id,
        quoteId: footThreeThirtyThree.id,
        expectedSelectedQuoteId: yardTen.id,
        now,
      }),
    (error) => /needed and planned/i.test(String(error.message)),
  );

  console.log("\nTEST — Concurrent selection uses a real lock barrier");
  const raceEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "DRAFT",
      publicToken: randomUUID(),
    },
  });
  const raceList = await ensurePurchaseList(prisma, ownerA, { estimateId: raceEstimate.id });
  const raceItem = await addPurchaseListItem(prisma, ownerA, {
    purchaseListId: raceList.id,
    materialId: lumber.id,
    name: lumber.name,
    quantityNeeded: "30",
    unit: "ft",
  });
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION tbbt_quote_select_race_pause() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_sleep(1);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await prisma.$executeRawUnsafe(`
    DROP TRIGGER IF EXISTS tbbt_quote_select_race_pause ON "MaterialPurchaseListItem"
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER tbbt_quote_select_race_pause
    BEFORE UPDATE OF "selectedQuoteId" ON "MaterialPurchaseListItem"
    FOR EACH ROW
    WHEN (NEW."selectedQuoteId" IS DISTINCT FROM OLD."selectedQuoteId")
    EXECUTE FUNCTION tbbt_quote_select_race_pause()
  `);
  let raceAPid = 0;
  let raceBPid = 0;
  let raceResults = [];
  const raceA = selectSupplierQuoteForPurchaseList(prisma, ownerA, {
    purchaseListItemId: raceItem.id,
    quoteId: currentQuote.id,
    expectedSelectedQuoteId: null,
    now: new Date("2026-10-02T17:00:00.000Z"),
  });
  const racePending = [raceA];
  try {
    raceAPid = await waitForGrantedPurchaseListItemLock(prismaHold);
    const raceB = selectSupplierQuoteForPurchaseList(prismaRace, ownerA, {
      purchaseListItemId: raceItem.id,
      quoteId: cheaperQuote.id,
      expectedSelectedQuoteId: null,
      now: new Date("2026-10-02T17:00:00.000Z"),
    });
    racePending.push(raceB);
    raceBPid = await waitForBlockedByPid(prismaHold, raceAPid);
    raceResults = await Promise.allSettled(racePending);
  } catch (error) {
    raceResults = await Promise.allSettled(racePending);
    throw error;
  } finally {
    await prisma.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS tbbt_quote_select_race_pause ON "MaterialPurchaseListItem"`,
    );
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS tbbt_quote_select_race_pause()`);
  }
  const raceOk = raceResults.filter((row) => row.status === "fulfilled");
  const raceFailed = raceResults.filter((row) => row.status === "rejected");
  const raceItemAfter = await prisma.materialPurchaseListItem.findUnique({
    where: { id: raceItem.id },
  });
  const winner = raceOk[0]?.value;
  check(
    "Exactly one concurrent selection wins and totals match that quote",
    raceOk.length === 1 &&
      raceFailed.length === 1 &&
      /already has a different selected quote/i.test(String(raceFailed[0].reason?.message ?? "")) &&
      raceItemAfter.selectedQuoteId === currentQuote.id &&
      raceItemAfter.plannedUnitCost.toString() === "4" &&
      raceItemAfter.plannedCost.toString() === "135" &&
      winner?.quote.id === currentQuote.id &&
      Number(raceAPid) > 0 &&
      Number(raceBPid) > 0 &&
      Number(raceBPid) !== Number(raceAPid),
  );
  const quotesAfterRace = await prisma.materialSupplierQuote.findMany({
    where: { id: { in: [currentQuote.id, cheaperQuote.id] } },
  });
  check(
    "Losing concurrent selection does not rewrite either original quote",
    quotesAfterRace.every((row) => {
      const before = [currentQuote, cheaperQuote].find((quoteRow) => quoteRow.id === row.id);
      return before && row.unitPrice.toString() === before.unitPrice.toString();
    }),
  );

  console.log("\nTEST — Select vs create-PO race loses one side");
  async function installPauseTrigger(name, table, whenClause) {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_sleep(1);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER ${name}
      ${whenClause}
      EXECUTE FUNCTION ${name}()
    `);
  }
  async function dropPauseTrigger(name, table) {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
  }

  const poRaceEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "DRAFT",
      publicToken: randomUUID(),
    },
  });
  const poRaceList = await ensurePurchaseList(prisma, ownerA, { estimateId: poRaceEstimate.id });

  async function seedQuotedItem() {
    const item = await addPurchaseListItem(prisma, ownerA, {
      purchaseListId: poRaceList.id,
      materialId: lumber.id,
      name: lumber.name,
      quantityNeeded: "30",
      unit: "ft",
    });
    await selectSupplierQuoteForPurchaseList(prisma, ownerA, {
      purchaseListItemId: item.id,
      quoteId: currentQuote.id,
      expectedSelectedQuoteId: null,
      now,
    });
    return item;
  }

  const selectFirstItem = await seedQuotedItem();
  let selectFirstResults = [];
  const selectFirstPending = [];
  await installPauseTrigger(
    "tbbt_quote_select_vs_po_pause",
    `"MaterialPurchaseListItem"`,
    `BEFORE UPDATE OF "selectedQuoteId" ON "MaterialPurchaseListItem"
     FOR EACH ROW
     WHEN (NEW."selectedQuoteId" IS DISTINCT FROM OLD."selectedQuoteId")`,
  );
  try {
    const selectFirst = selectSupplierQuoteForPurchaseList(prisma, ownerA, {
      purchaseListItemId: selectFirstItem.id,
      quoteId: cheaperQuote.id,
      expectedSelectedQuoteId: currentQuote.id,
      now,
    });
    selectFirstPending.push(selectFirst);
    const selectPid = await waitForGrantedPurchaseListItemLock(prismaHold);
    const poWhileSelect = createPurchaseOrder(prismaRace, ownerA, {
      purchaseListId: poRaceList.id,
      supplierId: depot.id,
      itemIds: [selectFirstItem.id],
    });
    selectFirstPending.push(poWhileSelect);
    const poBlockedPid = await waitForBlockedByPid(prismaHold, selectPid);
    selectFirstResults = await Promise.allSettled(selectFirstPending);
    check(
      "Select-first race blocks create-PO on the item lock",
      Number(selectPid) > 0 && Number(poBlockedPid) > 0 && Number(poBlockedPid) !== Number(selectPid),
    );
  } catch (error) {
    selectFirstResults = await Promise.allSettled(selectFirstPending);
    throw error;
  } finally {
    await dropPauseTrigger("tbbt_quote_select_vs_po_pause", `"MaterialPurchaseListItem"`);
  }
  const selectFirstOk = selectFirstResults.filter((row) => row.status === "fulfilled");
  const selectFirstFailed = selectFirstResults.filter((row) => row.status === "rejected");
  const selectFirstAfter = await prisma.materialPurchaseListItem.findUnique({
    where: { id: selectFirstItem.id },
  });
  const selectFirstPo = await prisma.materialPurchaseOrderItem.findFirst({
    where: {
      purchaseListItemId: selectFirstItem.id,
      purchaseOrder: { status: { not: "CANCELLED" } },
    },
    include: { purchaseOrder: true },
  });
  check(
    "Select-first: quote B wins and create-PO for supplier A loses",
    selectFirstOk.length === 1 &&
      selectFirstFailed.length === 1 &&
      selectFirstAfter.selectedQuoteId === cheaperQuote.id &&
      selectFirstAfter.supplierId === yard.id &&
      !selectFirstPo &&
      /same supplier|already on a purchase order/i.test(String(selectFirstFailed[0].reason?.message ?? "")),
  );

  const poFirstItem = await seedQuotedItem();
  let poFirstResults = [];
  const poFirstPending = [];
  await installPauseTrigger(
    "tbbt_po_create_vs_quote_pause",
    `"MaterialPurchaseOrder"`,
    `BEFORE INSERT ON "MaterialPurchaseOrder" FOR EACH ROW`,
  );
  try {
    const poFirst = createPurchaseOrder(prisma, ownerA, {
      purchaseListId: poRaceList.id,
      supplierId: depot.id,
      itemIds: [poFirstItem.id],
    });
    poFirstPending.push(poFirst);
    const poPid = await waitForGrantedPurchaseListItemLock(prismaHold);
    const selectWhilePo = selectSupplierQuoteForPurchaseList(prismaRace, ownerA, {
      purchaseListItemId: poFirstItem.id,
      quoteId: cheaperQuote.id,
      expectedSelectedQuoteId: currentQuote.id,
      now,
    });
    poFirstPending.push(selectWhilePo);
    const selectBlockedPid = await waitForBlockedByPid(prismaHold, poPid);
    poFirstResults = await Promise.allSettled(poFirstPending);
    check(
      "Create-PO-first race blocks select on the item lock",
      Number(poPid) > 0 && Number(selectBlockedPid) > 0 && Number(selectBlockedPid) !== Number(poPid),
    );
  } catch (error) {
    poFirstResults = await Promise.allSettled(poFirstPending);
    throw error;
  } finally {
    await dropPauseTrigger("tbbt_po_create_vs_quote_pause", `"MaterialPurchaseOrder"`);
  }
  const poFirstOk = poFirstResults.filter((row) => row.status === "fulfilled");
  const poFirstFailed = poFirstResults.filter((row) => row.status === "rejected");
  const poFirstAfter = await prisma.materialPurchaseListItem.findUnique({
    where: { id: poFirstItem.id },
  });
  const poFirstLine = await prisma.materialPurchaseOrderItem.findFirst({
    where: {
      purchaseListItemId: poFirstItem.id,
      purchaseOrder: { status: { not: "CANCELLED" } },
    },
    include: { purchaseOrder: true },
  });
  check(
    "Create-PO-first: supplier A PO wins and select of quote B loses",
    poFirstOk.length === 1 &&
      poFirstFailed.length === 1 &&
      poFirstAfter.selectedQuoteId === currentQuote.id &&
      poFirstAfter.supplierId === depot.id &&
      poFirstLine?.purchaseOrder.supplierId === depot.id &&
      /already on a purchase order/i.test(String(poFirstFailed[0].reason?.message ?? "")),
  );

  if (failures) {
    console.error(`\n${failures} supplier-quote compare check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll supplier-quote compare checks passed.");
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect().catch(() => {});
  await prismaRace.$disconnect().catch(() => {});
  await prismaHold.$disconnect().catch(() => {});
  try {
    dropTestDatabase();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

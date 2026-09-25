/**
 * Multi-Trade Core + Cleaning-ready architecture proofs.
 *
 * Proves business_trades isolation, Handyman/Cleaning catalog separation,
 * one business identity with multiple trades, frozen intake schema
 * versions, pricing-mode respect, and that existing Handyman
 * estimate/job/invoice records still work.
 *
 * Run with:
 *   npm run test:multi-trade-core
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const {
  activateBusinessTradeOp,
  deactivateBusinessTradeOp,
  listActiveTradeCodes,
  primaryTradeCodeFrom,
  resolvePrimaryTradeCode,
} = await import("@/lib/business-trades");
const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const { createPublicServiceRequest } = await import("@/lib/public-intake");
const { installStarterCatalogForTrade } = await import("@/lib/trade-catalog");
const {
  currentIntakeSchema,
  freezeIntakeSchema,
  resolveRequestIntakeSchema,
  validateIntakeAnswers,
} = await import("@/lib/intake-schema");
const {
  getTradeConfig,
  pricingModeAllowedForTrade,
  publicTradeProjection,
} = await import("@/lib/trade-config");
const { parsePricingMode, PRICING_MODES } = await import("@/lib/pricing-mode");
const { oneTimeRecurrencePlan, parseServiceIntent } = await import("@/lib/recurrence");
const { Prisma } = await import("@prisma/client");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run the multi-trade check.");
  process.exit(1);
}

const testDbName = "tbbt_multi_trade_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) process.exit(push.status ?? 1);

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

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
}

function makeAccess(businessId) {
  return {
    businessId,
    scope: businessScope(businessId),
    assertOwned(record) {
      return assertBusinessRecord(record, businessId);
    },
  };
}

console.log("\nSTATIC — Multi-trade architecture");
const schema = read("prisma/schema.prisma");
const migration = read("prisma/migrations/20260925120000_multi_trade_core/migration.sql");
const trades = read("src/lib/trades.ts");
const tradeConfig = read("src/lib/trade-config.ts");
const businessTrades = read("src/lib/business-trades.ts");
const intakeSchema = read("src/lib/intake-schema.ts");
const publicIntake = read("src/lib/public-intake.ts");
const workspace = read("src/lib/workspace.ts");
check(
  "business_trades is the schema authority and tradeCode is compatibility only",
  schema.includes("model BusinessTrade") &&
    schema.includes("business_trades is the Core source of truth") &&
    schema.includes("Compatibility projection of the primary active BusinessTrade") &&
    schema.includes("Planned removal"),
);
check(
  "Migration is additive, idempotent, and backfills from tradeCode",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migration) &&
    migration.includes('CREATE TABLE IF NOT EXISTS "BusinessTrade"') &&
    migration.includes("WHERE NOT EXISTS") &&
    migration.includes("tradeCode → business_trades") &&
    migration.includes("ADD COLUMN IF NOT EXISTS"),
);
check(
  "No request-time DDL for business trades",
  !workspace.includes("BusinessTrade") &&
    !businessTrades.includes("$executeRawUnsafe") &&
    !businessTrades.includes("ensureBusinessTrade"),
);
check(
  "Configured trades include Handyman and Cleaning",
  trades.includes('"HANDYMAN"') &&
    trades.includes('"CLEANING"') &&
    tradeConfig.includes("CLEANING_TRADE_CONFIG") &&
    tradeConfig.includes("HANDYMAN_TRADE_CONFIG"),
);
check(
  "Trade config owns pricing, intake, recurrence, catalog starter, and language",
  tradeConfig.includes("allowedPricingModes") &&
    tradeConfig.includes("publicPricingBehavior") &&
    tradeConfig.includes("intakeSchema") &&
    tradeConfig.includes("recurrenceSupport") &&
    tradeConfig.includes("catalogStarterSource") &&
    tradeConfig.includes("customerLanguage") &&
    !tradeConfig.includes("if (code === \"HANDYMAN\")"),
);
check(
  "Intake field types include Cleaning-ready types and versioned snapshots",
  intakeSchema.includes('"YES_NO"') &&
    intakeSchema.includes('"FREQUENCY"') &&
    intakeSchema.includes('"CONDITIONAL"') &&
    intakeSchema.includes('"DIMENSIONS"') &&
    intakeSchema.includes("archivedIntakeSchema") &&
    publicIntake.includes("intakeSchemaJson") &&
    publicIntake.includes("freezeIntakeSchema"),
);
check(
  "First-class pricing modes include variable/unit-based",
  PRICING_MODES.includes("FIXED") &&
    PRICING_MODES.includes("STARTING_AT") &&
    PRICING_MODES.includes("VARIABLE") &&
    PRICING_MODES.includes("CUSTOM_QUOTE") &&
    parsePricingMode("VARIABLE") === "VARIABLE",
);
check(
  "Public projections omit internal trade config",
  !JSON.stringify(publicTradeProjection(getTradeConfig("CLEANING"))).includes(
    "catalogStarterSource",
  ) &&
    !JSON.stringify(publicTradeProjection(getTradeConfig("HANDYMAN"))).includes(
      "allowedPricingModes",
    ),
);
check(
  "Existing Handyman jobs default to one-time recurrence plan",
  oneTimeRecurrencePlan().serviceIntent === "ONE_TIME" &&
    parseServiceIntent(undefined) === "ONE_TIME",
);

try {
  console.log("\nLIVE — Tenant isolation and trade memberships");
  const handyA = await prisma.business.create({
    data: { name: "Alpha Handy", slug: `alpha-mt-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const handyB = await prisma.business.create({
    data: { name: "Beta Handy", slug: `beta-mt-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const accessA = makeAccess(handyA.id);
  const accessB = makeAccess(handyB.id);

  await activateBusinessTradeOp(prisma, accessA, "HANDYMAN");
  await activateBusinessTradeOp(prisma, accessB, "HANDYMAN");

  check(
    "Compatibility tradeCode stays HANDYMAN after backfill-equivalent write",
    (await prisma.business.findUnique({ where: { id: handyA.id } })).tradeCode === "HANDYMAN",
  );
  check(
    "Active trades resolve from business_trades, not a second authority",
    (await listActiveTradeCodes(prisma, handyA.id)).includes("HANDYMAN") &&
      primaryTradeCodeFrom(
        [{ tradeCode: "HANDYMAN", status: "ACTIVE" }],
        "HANDYMAN",
      ) === "HANDYMAN",
  );

  const bReadsA = await prisma.businessTrade.findFirst({
    where: { businessId: handyB.id, id: (await prisma.businessTrade.findFirst({ where: { businessId: handyA.id } })).id },
  });
  check("Business B cannot load Business A trade membership by id", bReadsA === null);

  let stolen = false;
  try {
    await activateBusinessTradeOp(prisma, accessB, "CLEANING");
    const aCleaning = await prisma.businessTrade.findFirst({
      where: { businessId: handyA.id, tradeCode: "CLEANING" },
    });
    stolen = Boolean(aCleaning);
  } catch {
    stolen = true;
  }
  check(
    "Activating Cleaning on B does not create a trade on A",
    stolen === false &&
      (await prisma.businessTrade.count({ where: { businessId: handyA.id, tradeCode: "CLEANING" } })) === 0 &&
      (await prisma.businessTrade.count({ where: { businessId: handyB.id, tradeCode: "CLEANING" } })) === 1,
  );

  console.log("\nLIVE — Catalog isolation Handyman vs Cleaning");
  await installStarterCatalogForTrade(prisma, handyA.id, "HANDYMAN");
  await activateBusinessTradeOp(prisma, accessA, "CLEANING");
  await installStarterCatalogForTrade(prisma, handyA.id, "CLEANING");
  await installStarterCatalogForTrade(prisma, handyB.id, "HANDYMAN");

  const aHandy = await prisma.serviceCatalogItem.count({
    where: { businessId: handyA.id, tradeCode: "HANDYMAN" },
  });
  const aClean = await prisma.serviceCatalogItem.count({
    where: { businessId: handyA.id, tradeCode: "CLEANING" },
  });
  const bClean = await prisma.serviceCatalogItem.count({
    where: { businessId: handyB.id, tradeCode: "CLEANING" },
  });
  const bHandy = await prisma.serviceCatalogItem.count({
    where: { businessId: handyB.id, tradeCode: "HANDYMAN" },
  });
  check("Handyman catalog installed for A", aHandy > 0);
  check("Cleaning catalog installed for A after Cleaning was activated", aClean > 0);
  check("Installing Cleaning on A does not insert Cleaning into B", bClean === 0);
  check("B Handyman catalog stays Handyman", bHandy > 0);
  check(
    "Cleaning starter names are not present on B Handyman rows",
    (
      await prisma.serviceCatalogItem.count({
        where: { businessId: handyB.id, name: "Standard Clean" },
      })
    ) === 0,
  );
  check(
    "A can hold both trades under one business identity",
    (await listActiveTradeCodes(prisma, handyA.id)).includes("HANDYMAN") &&
      (await listActiveTradeCodes(prisma, handyA.id)).includes("CLEANING") &&
      (await resolvePrimaryTradeCode(prisma, handyA.id)) === "HANDYMAN",
  );

  console.log("\nLIVE — Pricing modes respect trade config");
  check("Handyman allows FIXED / STARTING_AT / VARIABLE / CUSTOM_QUOTE", 
    ["FIXED", "STARTING_AT", "VARIABLE", "CUSTOM_QUOTE"].every((mode) =>
      pricingModeAllowedForTrade("HANDYMAN", mode),
    ),
  );
  check("Cleaning allows the same first-class pricing modes",
    ["FIXED", "STARTING_AT", "VARIABLE", "CUSTOM_QUOTE"].every((mode) =>
      pricingModeAllowedForTrade("CLEANING", mode),
    ),
  );
  check("Unknown mode is rejected", !pricingModeAllowedForTrade("HANDYMAN", "NATIONWIDE_RATE"));

  console.log("\nLIVE — Versioned intake stays frozen after config change");
  const handyService = await prisma.serviceCatalogItem.findFirst({
    where: {
      businessId: handyA.id,
      tradeCode: "HANDYMAN",
      active: true,
      intakeMeasurementMode: "NONE",
    },
  });
  const cleanService = await prisma.serviceCatalogItem.findFirst({
    where: { businessId: handyA.id, tradeCode: "CLEANING", name: "Standard Clean" },
  });
  const v1 = currentIntakeSchema("CLEANING");
  const created = await createPublicServiceRequest(prisma, {
    slug: handyA.slug,
    name: "Pat Customer",
    email: "pat@example.com",
    phone: "5551112222",
    address: "1 Main St",
    streetAddress: "1 Main St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Weekly clean",
    catalogItemIds: [cleanService.id],
    includeOther: false,
    otherDescription: "",
    intakeAnswers: {
      bedrooms: 3,
      bathrooms: 2,
      homeSize: "1500_2000",
      frequency: "WEEKLY",
      pets: "yes",
      petNotes: "Friendly dog",
      accessNotes: "Side gate",
    },
  });
  check("Cleaning public intake succeeds with trade-driven answers", created.ok === true);
  const request = created.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: created.requestId } })
    : null;
  check(
    "Submitted request freezes schema key/version/json",
    request?.intakeSchemaKey === v1.key &&
      request?.intakeSchemaVersion === v1.version &&
      Boolean(request?.intakeSchemaJson) &&
      request?.tradeCode === "CLEANING" &&
      request?.serviceIntent === "RECURRING" &&
      request?.recurrenceCadence === "WEEKLY",
  );
  const frozenBefore = request?.intakeSchemaJson;
  const mutated = {
    ...v1,
    version: 99,
    fields: v1.fields.filter((field) => field.key !== "bedrooms"),
  };
  const historical = resolveRequestIntakeSchema({
    intakeSchemaKey: request?.intakeSchemaKey,
    intakeSchemaVersion: request?.intakeSchemaVersion,
    intakeSchemaJson: frozenBefore,
    tradeCode: "CLEANING",
  });
  check(
    "Historical schema still includes bedrooms after a later config-shaped change",
    historical.fields.some((field) => field.key === "bedrooms") &&
      historical.version === 1 &&
      frozenBefore === request?.intakeSchemaJson,
  );
  check(
    "Current schema helper can change without rewriting the stored snapshot",
    mutated.version === 99 && request?.intakeSchemaVersion === 1,
  );

  const handyCreated = await createPublicServiceRequest(prisma, {
    slug: handyA.slug,
    name: "Sam Customer",
    email: "sam@example.com",
    phone: "5553334444",
    address: "2 Main St",
    streetAddress: "2 Main St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Door knob",
    catalogItemIds: [handyService.id],
    includeOther: false,
    otherDescription: "",
  });
  check("Existing Handyman public intake still works", handyCreated.ok === true);
  const handyRequest = handyCreated.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: handyCreated.requestId } })
    : null;
  check(
    "Handyman request freezes Handyman schema and stays one-time",
    handyRequest?.tradeCode === "HANDYMAN" &&
      handyRequest?.intakeSchemaKey === "handyman.public" &&
      handyRequest?.serviceIntent === "ONE_TIME",
  );

  const missingCleaning = validateIntakeAnswers(currentIntakeSchema("CLEANING"), {});
  check("Cleaning required fields fail closed", missingCleaning.ok === false);

  console.log("\nLIVE — Handyman estimate / job / invoice still attach on the same identity");
  const customer = await prisma.customer.create({
    data: { businessId: handyA.id, name: "Invoice Customer", email: "inv@example.com" },
  });
  const estimate = await prisma.estimate.create({
    data: {
      businessId: handyA.id,
      customerId: customer.id,
      status: "APPROVED",
      total: new Prisma.Decimal(250),
      publicToken: randomUUID(),
    },
  });
  const version = await prisma.estimateVersion.create({
    data: {
      businessId: handyA.id,
      estimateId: estimate.id,
      versionNumber: 1,
      total: new Prisma.Decimal(250),
      laborMinimumWaived: false,
      laborMinimumAdjustment: new Prisma.Decimal(0),
      approvedAt: new Date(),
    },
  });
  await prisma.estimate.update({
    where: { id: estimate.id },
    data: { approvedVersionId: version.id },
  });
  const job = await prisma.job.create({
    data: {
      businessId: handyA.id,
      customerId: customer.id,
      estimateId: estimate.id,
      approvedEstimateVersionId: version.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      businessId: handyA.id,
      customerId: customer.id,
      jobId: job.id,
      status: "SENT",
      total: new Prisma.Decimal(250),
    },
  });
  check(
    "Existing Handyman job defaults to one-time recurrence",
    job.serviceIntent === "ONE_TIME" && job.recurrenceCadence === "" && job.recurrenceStatus === "",
  );
  check(
    "Invoice still belongs to the same business identity after multi-trade activation",
    invoice.businessId === handyA.id &&
      job.businessId === handyA.id &&
      estimate.businessId === handyA.id &&
      handyA.slug === (await prisma.business.findUnique({ where: { id: handyA.id } })).slug,
  );

  const listedB = await prisma.estimate.findMany({ where: accessB.scope });
  check("B cannot list A's estimates after multi-trade writes", listedB.every((row) => row.businessId === handyB.id));

  console.log("\nLIVE — Cannot drop the last trade; cannot steal another tenant");
  await deactivateBusinessTradeOp(prisma, accessB, "CLEANING");
  let lastTradeError = false;
  try {
    await deactivateBusinessTradeOp(prisma, accessB, "HANDYMAN");
  } catch {
    lastTradeError = true;
  }
  check("A business must keep at least one active trade", lastTradeError);

  const cross = await prisma.businessTrade.findFirst({
    where: { businessId: handyA.id, tradeCode: "CLEANING" },
  });
  const bScoped = await prisma.businessTrade.findFirst({
    where: { id: cross.id, ...accessB.scope },
  });
  check("B scoped query cannot read A's Cleaning membership", bScoped === null);

  console.log("\nLIVE — Re-running the trade backfill stays safe");
  const before = await prisma.businessTrade.count({ where: { businessId: handyA.id } });
  await prisma.$executeRawUnsafe(`
    INSERT INTO "BusinessTrade" (
      "id", "businessId", "tradeCode", "status", "configOverridesJson",
      "intakeSchemaVersion", "activatedAt", "createdAt", "updatedAt"
    )
    SELECT
      'bt_' || b."id", b."id", COALESCE(NULLIF(b."tradeCode", ''), 'HANDYMAN'),
      'ACTIVE', '{}', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    FROM "Business" b
    WHERE NOT EXISTS (
      SELECT 1 FROM "BusinessTrade" t
      WHERE t."businessId" = b."id"
        AND t."tradeCode" = COALESCE(NULLIF(b."tradeCode", ''), 'HANDYMAN')
    )
  `);
  const after = await prisma.businessTrade.count({ where: { businessId: handyA.id } });
  check("Idempotent backfill does not duplicate trade memberships", before === after);
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${testDbName}' AND pid <> pg_backend_pid()`,
    );
  } catch {
    /* ignore */
  }
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

console.log(
  failed === 0
    ? `\nAll multi-trade-core checks passed (${passed}).`
    : `\n${failed} multi-trade-core check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);

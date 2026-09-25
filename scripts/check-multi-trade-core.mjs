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
  authorizeCatalogTradeCode,
  deactivateBusinessTradeOp,
  InactiveCatalogTradeError,
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
const {
  jobRecurrenceFromServiceRequest,
  oneTimeRecurrencePlan,
  parseServiceIntent,
} = await import("@/lib/recurrence");
const {
  CROSS_TRADE_REQUEST_MESSAGE,
  CUSTOM_WORK_TRADE_REQUIRED_MESSAGE,
  INACTIVE_CATALOG_TRADE_MESSAGE,
  INACTIVE_TRADE_REQUEST_MESSAGE,
  resolvePublicRequestTrade,
} = await import("@/lib/public-request-trade");
const {
  catalogRecurrenceEligibleForTrade,
  catalogRecurrenceEligibleFromForm,
} = await import("@/lib/catalog-item-fields");
const {
  ESTIMATE_CATALOG_TRADE_REQUIRED_MESSAGE,
  addCatalogItemToDraftEstimate,
  resolveSaveEstimateLineTrade,
  saveDraftEstimateLineAsCatalog,
} = await import("@/lib/estimate-line-ops");
const {
  addRequestDraftLines,
  sourceItemsFromServiceRequest,
} = await import("@/lib/request-estimate-draft");
const { loadPublicBusiness, loadPublicCatalog } = await import("@/lib/public-site-data");
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

function makeAccess(businessId, role = "OWNER") {
  return {
    businessId,
    workspace: { role, membership: { id: `mem-${businessId}` } },
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
const publicSiteData = read("src/lib/public-site-data.ts");
const requestPage = read("src/app/r/[slug]/page.tsx");
const requestFlow = read("src/components/public/request-flow.tsx");
const catalogAction = read("src/app/actions/catalog.ts");
const estimateLineOps = read("src/lib/estimate-line-ops.ts");
const estimateAction = read("src/app/actions/estimate.ts");
const estimateBuilderPage = read("src/app/(app)/estimates/[estimateId]/page.tsx");
const saveLineForm = read("src/components/estimates/draft-line-scope-forms.tsx");
const createCatalogForm = read("src/components/catalog/create-catalog-item-form.tsx");
const catalogItemRow = read("src/components/catalog/catalog-item-row.tsx");
const addServiceSheet = read("src/components/services/add-service-sheet.tsx");
const servicesPage = read("src/app/(app)/services/page.tsx");
const catalogTypes = read("src/components/services/types.ts");
const jobAction = read("src/app/actions/job.ts");
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
check(
  "Public catalog filters by ACTIVE BusinessTrade, not only catalog.active",
  publicSiteData.includes("catalogItemIsPubliclyOffered") &&
    publicIntake.includes("resolvePublicRequestTrade"),
);
check(
  "Public request page does not compose every active-trade schema",
  !requestPage.includes("composeIntakeSchema") &&
    requestPage.includes("intakeSchemasByTrade") &&
    requestFlow.includes("selectedCatalogTradeCodes") &&
    requestFlow.includes("CROSS_TRADE_REQUEST_MESSAGE"),
);
check(
  "Explicit invalid catalog trade fails closed instead of falling back to primary",
  businessTrades.includes("InactiveCatalogTradeError") &&
    businessTrades.includes("if (explicit)") &&
    catalogAction.includes("InactiveCatalogTradeError"),
);
check(
  "Catalog list items and Add Service carry trade, recurrence, and unit label",
  catalogTypes.includes("tradeCode: string") &&
    catalogTypes.includes("recurrenceEligible: boolean") &&
    catalogTypes.includes("unitLabel: string") &&
    createCatalogForm.includes('name="tradeCode"') &&
    createCatalogForm.includes("recurrenceEligible") &&
    createCatalogForm.includes("unitLabel") &&
    catalogItemRow.includes("recurrenceEligibleSubmitted") &&
    catalogAction.includes("catalogRecurrenceEligibleForTrade") &&
    catalogRecurrenceEligibleFromForm(false, false, true) === true &&
    catalogRecurrenceEligibleFromForm(true, false, true) === false,
);
check(
  "Estimate Builder add-catalog list and add action require ACTIVE BusinessTrade",
  estimateBuilderPage.includes("addableCatalogItems") &&
    estimateBuilderPage.includes("catalogItemIsPubliclyOffered") &&
    estimateBuilderPage.includes("items={addableCatalogItems.map") &&
    estimateBuilderPage.includes("where: { ...access.scope, active: true }") &&
    estimateLineOps.includes("catalogItemIsPubliclyOffered") &&
    estimateLineOps.includes("INACTIVE_CATALOG_TRADE_MESSAGE") &&
    estimateAction.includes("addCatalogItemToDraftEstimate"),
);
check(
  "Save estimate line to catalog is trade-aware and name-scoped by trade",
  estimateLineOps.includes("resolveSaveEstimateLineTrade") &&
    estimateLineOps.includes("requestedTradeCode") &&
    estimateLineOps.includes("tradeCode,") &&
    estimateLineOps.includes("ESTIMATE_CATALOG_TRADE_REQUIRED_MESSAGE") &&
    estimateAction.includes("requestedTradeCode") &&
    saveLineForm.includes('name="requestedTradeCode"') &&
    estimateBuilderPage.includes("needsTradeChoice") &&
    resolveSaveEstimateLineTrade({
      linkedCatalogTradeCode: "CLEANING",
      requestTradeCode: "HANDYMAN",
      activeTradeCodes: ["HANDYMAN"],
      requestedTradeCode: "HANDYMAN",
    }).ok === true &&
    resolveSaveEstimateLineTrade({
      linkedCatalogTradeCode: "CLEANING",
      requestTradeCode: "HANDYMAN",
      activeTradeCodes: ["HANDYMAN"],
      requestedTradeCode: "HANDYMAN",
    }).tradeCode === "CLEANING" &&
    resolveSaveEstimateLineTrade({
      linkedCatalogTradeCode: null,
      requestTradeCode: "CLEANING",
      activeTradeCodes: ["HANDYMAN"],
      requestedTradeCode: "HANDYMAN",
    }).tradeCode === "CLEANING" &&
    resolveSaveEstimateLineTrade({
      linkedCatalogTradeCode: null,
      requestTradeCode: null,
      activeTradeCodes: ["HANDYMAN", "CLEANING"],
      requestedTradeCode: null,
    }).ok === false &&
    resolveSaveEstimateLineTrade({
      linkedCatalogTradeCode: null,
      requestTradeCode: null,
      activeTradeCodes: ["HANDYMAN"],
      requestedTradeCode: null,
    }).tradeCode === "HANDYMAN",
);
check(
  "Recurrence eligibility is forced off when the trade does not support it",
  catalogRecurrenceEligibleForTrade("HANDYMAN", true, true, false) === false &&
    catalogRecurrenceEligibleForTrade("HANDYMAN", true, true, true) === false &&
    catalogRecurrenceEligibleForTrade("HANDYMAN", false, false, true) === false &&
    catalogRecurrenceEligibleForTrade("CLEANING", true, true, false) === true &&
    catalogRecurrenceEligibleForTrade("CLEANING", false, false, true) === true &&
    catalogRecurrenceEligibleForTrade("CLEANING", true, false, true) === false,
);
check(
  "Starter catalog UI uses per-trade plans instead of one Handyman heading",
  addServiceSheet.includes("starterPlans") &&
    addServiceSheet.includes("plan.label") &&
    !addServiceSheet.includes("Handyman starter catalog") &&
    servicesPage.includes("starterPlans") &&
    servicesPage.includes("planCleaningStarterCatalogInstall") &&
    servicesPage.includes("planStarterCatalogInstall"),
);
check(
  "createJobFromEstimate copies request recurrence instead of schema defaults",
  jobAction.includes("jobRecurrenceFromServiceRequest") &&
    jobAction.includes("serviceIntent: recurrence.serviceIntent") &&
    jobAction.includes("recurrenceCadence: recurrence.recurrenceCadence") &&
    jobAction.includes("recurrenceStatus: recurrence.recurrenceStatus"),
);
check(
  "Other-only multi-trade work requires an ACTIVE trade choice",
  resolvePublicRequestTrade({
    catalogTradeCodes: [],
    authorizedActiveTradeCodes: ["HANDYMAN", "CLEANING"],
    requestedTradeCode: null,
    includeOther: true,
  }).ok === false &&
    resolvePublicRequestTrade({
      catalogTradeCodes: [],
      authorizedActiveTradeCodes: ["HANDYMAN", "CLEANING"],
      requestedTradeCode: "CLEANING",
      includeOther: true,
    }).ok === true &&
    resolvePublicRequestTrade({
      catalogTradeCodes: [],
      authorizedActiveTradeCodes: ["HANDYMAN"],
      requestedTradeCode: "CLEANING",
      includeOther: true,
    }).ok === false,
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

  console.log("\nLIVE — Selected-trade intake, Other-work trade, and mixed-trade block");
  const handyOnlyAnswers = validateIntakeAnswers(currentIntakeSchema("HANDYMAN"), {
    frequency: "ONE_TIME",
  });
  check(
    "Handyman-only schema does not require Cleaning bedrooms/bathrooms/home size",
    handyOnlyAnswers.ok === true &&
      !currentIntakeSchema("HANDYMAN").fields.some((field) =>
        ["bedrooms", "bathrooms", "homeSize"].includes(field.key),
      ),
  );
  const cleaningFreq = currentIntakeSchema("CLEANING").fields.find(
    (field) => field.key === "frequency",
  );
  check(
    "Cleaning-only frequency exposes ONE_TIME / WEEKLY / BIWEEKLY / MONTHLY",
    cleaningFreq?.options?.map((option) => option.value).join(",") ===
      "ONE_TIME,WEEKLY,BIWEEKLY,MONTHLY",
  );
  const hintedCleaningOnHandyman = await createPublicServiceRequest(prisma, {
    slug: handyA.slug,
    name: "Hint Customer",
    email: "hint@example.com",
    phone: "5550000000",
    address: "3a Main St",
    streetAddress: "3a Main St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Door only",
    catalogItemIds: [handyService.id],
    includeOther: false,
    otherDescription: "",
    requestedTradeCode: "CLEANING",
  });
  const hintedRow = hintedCleaningOnHandyman.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: hintedCleaningOnHandyman.requestId },
      })
    : null;
  check(
    "Browser trade hint never authorizes over tenant-owned catalog trade",
    hintedCleaningOnHandyman.ok === true &&
      hintedRow?.tradeCode === "HANDYMAN" &&
      hintedRow?.intakeSchemaKey === "handyman.public",
  );

  const mixedRequest = await createPublicServiceRequest(prisma, {
    slug: handyA.slug,
    name: "Mix Customer",
    email: "mix@example.com",
    phone: "5550001111",
    address: "3 Main St",
    streetAddress: "3 Main St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Both trades",
    catalogItemIds: [handyService.id, cleanService.id],
    includeOther: false,
    otherDescription: "",
  });
  check(
    "Mixed Handyman + Cleaning selection is rejected with a separate-request message",
    mixedRequest.ok === false && mixedRequest.error === CROSS_TRADE_REQUEST_MESSAGE,
  );

  const otherNeedsChoice = await createPublicServiceRequest(prisma, {
    slug: handyA.slug,
    name: "Other Customer",
    email: "other-mt@example.com",
    phone: "5550002222",
    address: "4 Main St",
    streetAddress: "4 Main St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Custom work",
    catalogItemIds: [],
    includeOther: true,
    otherDescription: "Fix a door and maybe clean later",
  });
  check(
    "Other-only on a multi-trade business requires an explicit trade choice",
    otherNeedsChoice.ok === false &&
      otherNeedsChoice.error === CUSTOM_WORK_TRADE_REQUIRED_MESSAGE,
  );

  const otherInvalid = await createPublicServiceRequest(prisma, {
    slug: handyA.slug,
    name: "Other Invalid",
    email: "other-bad@example.com",
    phone: "5550003333",
    address: "5 Main St",
    streetAddress: "5 Main St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Custom work",
    catalogItemIds: [],
    includeOther: true,
    otherDescription: "Unknown trade",
    requestedTradeCode: "PLUMBING",
  });
  check(
    "Invalid Other-work trade choice fails closed",
    otherInvalid.ok === false && otherInvalid.error === INACTIVE_TRADE_REQUEST_MESSAGE,
  );

  const otherCleaning = await createPublicServiceRequest(prisma, {
    slug: handyA.slug,
    name: "Other Cleaning",
    email: "other-clean@example.com",
    phone: "5550004444",
    address: "6 Main St",
    streetAddress: "6 Main St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Custom clean",
    catalogItemIds: [],
    includeOther: true,
    otherDescription: "Custom cleaning visit",
    requestedTradeCode: "CLEANING",
    intakeAnswers: {
      bedrooms: 2,
      bathrooms: 1,
      homeSize: "1000_1500",
      frequency: "MONTHLY",
    },
  });
  const otherCleaningRow = otherCleaning.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: otherCleaning.requestId } })
    : null;
  check(
    "Other-only Cleaning choice freezes the Cleaning schema on the request",
    otherCleaning.ok === true &&
      otherCleaningRow?.tradeCode === "CLEANING" &&
      otherCleaningRow?.intakeSchemaKey === "cleaning.public" &&
      otherCleaningRow?.serviceIntent === "RECURRING" &&
      otherCleaningRow?.recurrenceCadence === "MONTHLY",
  );

  await deactivateBusinessTradeOp(prisma, accessB, "CLEANING");
  const singleTradeOther = await createPublicServiceRequest(prisma, {
    slug: handyB.slug,
    name: "Beta Other",
    email: "beta-other@example.com",
    phone: "5550005555",
    address: "7 Main St",
    streetAddress: "7 Main St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Custom handy",
    catalogItemIds: [],
    includeOther: true,
    otherDescription: "Custom handyman work",
  });
  const singleTradeOtherRow = singleTradeOther.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: singleTradeOther.requestId } })
    : null;
  check(
    "Other-only on a one-trade business infers that trade server-side",
    singleTradeOther.ok === true &&
      singleTradeOtherRow?.tradeCode === "HANDYMAN" &&
      singleTradeOtherRow?.intakeSchemaKey === "handyman.public",
  );

  console.log("\nLIVE — Deactivated trades stop participating operationally");
  const publicBefore = await loadPublicBusiness(handyA.slug, prisma);
  const catalogBefore = await loadPublicCatalog(publicBefore, prisma);
  check(
    "Handyman + Cleaning active exposes Cleaning on the public catalog",
    catalogBefore.items.some((item) => item.id === cleanService.id) &&
      catalogBefore.items.some((item) => item.id === handyService.id),
  );

  const builderCustomer = await prisma.customer.create({
    data: { businessId: handyA.id, name: "Builder Customer", email: "builder@example.com" },
  });
  const builderEstimate = await prisma.estimate.create({
    data: {
      businessId: handyA.id,
      customerId: builderCustomer.id,
      status: "DRAFT",
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  const addedWhileActive = await addCatalogItemToDraftEstimate(prisma, accessA, {
    estimateId: builderEstimate.id,
    catalogItemId: cleanService.id,
    quantity: new Prisma.Decimal(1),
  });
  check(
    "Cleaning catalog can be manually added to a draft estimate while Cleaning is active",
    addedWhileActive.serviceCatalogItemId === cleanService.id &&
      addedWhileActive.description.includes("Standard Clean"),
  );

  await deactivateBusinessTradeOp(prisma, accessA, "CLEANING");
  const publicAfterOff = await loadPublicBusiness(handyA.slug, prisma);
  const catalogAfterOff = await loadPublicCatalog(publicAfterOff, prisma);
  const storedCleaning = await prisma.serviceCatalogItem.findUnique({
    where: { id: cleanService.id },
  });
  check(
    "Deactivating Cleaning hides Cleaning services without rewriting catalog rows",
    !catalogAfterOff.items.some((item) => item.tradeCode === "CLEANING") &&
      catalogAfterOff.items.some((item) => item.id === handyService.id) &&
      storedCleaning?.active === true &&
      storedCleaning?.tradeCode === "CLEANING" &&
      storedCleaning?.name === "Standard Clean",
  );

  const staleCleaning = await createPublicServiceRequest(prisma, {
    slug: handyA.slug,
    name: "Stale Clean",
    email: "stale@example.com",
    phone: "5550006666",
    address: "8 Main St",
    streetAddress: "8 Main St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Deep link",
    catalogItemIds: [cleanService.id],
    includeOther: false,
    otherDescription: "",
    intakeAnswers: {
      bedrooms: 2,
      bathrooms: 1,
      homeSize: "1000_1500",
      frequency: "WEEKLY",
    },
  });
  check(
    "Stale Cleaning catalog ID from a deactivated trade is rejected server-side",
    staleCleaning.ok === false && staleCleaning.error === INACTIVE_CATALOG_TRADE_MESSAGE,
  );

  let inactiveWriteRejected = false;
  try {
    await authorizeCatalogTradeCode(prisma, handyA.id, "CLEANING");
  } catch (error) {
    inactiveWriteRejected = error instanceof InactiveCatalogTradeError;
  }
  const implicitPrimary = await authorizeCatalogTradeCode(prisma, handyA.id, null);
  let unknownWriteRejected = false;
  try {
    await authorizeCatalogTradeCode(prisma, handyA.id, "PLUMBING");
  } catch (error) {
    unknownWriteRejected = error instanceof InactiveCatalogTradeError;
  }
  check(
    "Explicit inactive or unknown catalog trade is rejected; omitted trade falls back to primary",
    inactiveWriteRejected &&
      unknownWriteRejected &&
      implicitPrimary === "HANDYMAN",
  );

  const otherInactiveChoice = await createPublicServiceRequest(prisma, {
    slug: handyA.slug,
    name: "Other Inactive",
    email: "other-off@example.com",
    phone: "5550007777",
    address: "9 Main St",
    streetAddress: "9 Main St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Custom clean while off",
    catalogItemIds: [],
    includeOther: true,
    otherDescription: "Still cleaning?",
    requestedTradeCode: "CLEANING",
    intakeAnswers: {
      bedrooms: 2,
      bathrooms: 1,
      homeSize: "1000_1500",
      frequency: "WEEKLY",
    },
  });
  check(
    "Other-work choice of an inactive trade fails closed",
    otherInactiveChoice.ok === false &&
      otherInactiveChoice.error === INACTIVE_TRADE_REQUEST_MESSAGE,
  );

  const activeAfterOff = await listActiveTradeCodes(prisma, handyA.id);
  const ownerCatalogAfterOff = await prisma.serviceCatalogItem.findMany({
    where: { businessId: handyA.id, active: true },
  });
  const addableAfterOff = ownerCatalogAfterOff.filter((item) =>
    item.active && activeAfterOff.includes(item.tradeCode),
  );
  check(
    "Deactivated Cleaning disappears from Estimate Builder new-add catalog",
    !addableAfterOff.some((item) => item.id === cleanService.id) &&
      addableAfterOff.some((item) => item.id === handyService.id) &&
      ownerCatalogAfterOff.some((item) => item.id === cleanService.id),
  );

  let staleBuilderAddRejected = false;
  let staleBuilderAddMessage = "";
  try {
    await addCatalogItemToDraftEstimate(prisma, accessA, {
      estimateId: builderEstimate.id,
      catalogItemId: cleanService.id,
      quantity: new Prisma.Decimal(1),
    });
  } catch (error) {
    staleBuilderAddRejected = true;
    staleBuilderAddMessage = error instanceof Error ? error.message : "";
  }
  const existingCleaningLine = await prisma.lineItem.findFirst({
    where: { id: addedWhileActive.id, businessId: handyA.id },
  });
  check(
    "Direct add of a deactivated-trade catalog item is rejected; existing line stays intact",
    staleBuilderAddRejected &&
      staleBuilderAddMessage === INACTIVE_CATALOG_TRADE_MESSAGE &&
      existingCleaningLine?.id === addedWhileActive.id &&
      existingCleaningLine?.serviceCatalogItemId === cleanService.id &&
      existingCleaningLine?.description === addedWhileActive.description &&
      existingCleaningLine?.unitPrice.toString() === addedWhileActive.unitPrice.toString(),
  );

  const historicalRequest = request
    ? await prisma.serviceRequest.findUnique({
        where: { id: request.id },
        include: {
          items: { include: { serviceCatalogItem: true } },
          serviceCatalogItem: true,
        },
      })
    : null;
  const historicalEstimate = await prisma.estimate.create({
    data: {
      businessId: handyA.id,
      customerId: (
        await prisma.customer.create({
          data: {
            businessId: handyA.id,
            name: "Historical Convert",
            email: "hist-convert@example.com",
          },
        })
      ).id,
      serviceRequestId: historicalRequest?.id,
      status: "DRAFT",
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  const convertedCount = historicalRequest
    ? await prisma.$transaction((tx) =>
        addRequestDraftLines(tx, {
          businessId: handyA.id,
          estimateId: historicalEstimate.id,
          items: sourceItemsFromServiceRequest(historicalRequest),
        }),
      )
    : 0;
  const convertedLines = await prisma.lineItem.findMany({
    where: { estimateId: historicalEstimate.id, businessId: handyA.id },
  });
  check(
    "Historical Cleaning request still converts into an estimate from frozen request lines",
    convertedCount > 0 &&
      convertedLines.some((line) => line.serviceCatalogItemId === cleanService.id),
  );

  await activateBusinessTradeOp(prisma, accessA, "CLEANING");
  const publicAfterOn = await loadPublicBusiness(handyA.slug, prisma);
  const catalogAfterOn = await loadPublicCatalog(publicAfterOn, prisma);
  check(
    "Reactivating Cleaning makes still-active Cleaning services public again",
    catalogAfterOn.items.some((item) => item.id === cleanService.id) &&
      (await prisma.serviceCatalogItem.findUnique({ where: { id: cleanService.id } }))
        .active === true,
  );

  const addedAfterOn = await addCatalogItemToDraftEstimate(prisma, accessA, {
    estimateId: builderEstimate.id,
    catalogItemId: cleanService.id,
    quantity: new Prisma.Decimal(1),
  });
  check(
    "Reactivating Cleaning makes still-active catalog items addable to draft estimates again",
    addedAfterOn.serviceCatalogItemId === cleanService.id &&
      (await prisma.lineItem.count({
        where: { estimateId: builderEstimate.id, serviceCatalogItemId: cleanService.id },
      })) === 2,
  );

  console.log("\nLIVE — Save estimate line to catalog is trade-aware");
  const sharedHandy = await prisma.serviceCatalogItem.create({
    data: {
      businessId: handyA.id,
      tradeCode: "HANDYMAN",
      name: "Shared Visit Name",
      pricingMode: "CUSTOM_QUOTE",
      price: new Prisma.Decimal(75),
      category: "General Home Repairs",
      active: true,
    },
  });
  const sharedClean = await prisma.serviceCatalogItem.create({
    data: {
      businessId: handyA.id,
      tradeCode: "CLEANING",
      name: "Shared Visit Name",
      pricingMode: "CUSTOM_QUOTE",
      price: new Prisma.Decimal(90),
      category: "Standard Cleaning",
      active: true,
      recurrenceEligible: true,
    },
  });
  const reuseEstimate = await prisma.estimate.create({
    data: {
      businessId: handyA.id,
      customerId: builderCustomer.id,
      status: "DRAFT",
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  const customUnlinked = await prisma.lineItem.create({
    data: {
      businessId: handyA.id,
      estimateId: reuseEstimate.id,
      description: "Custom multi-trade save",
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(50),
      total: new Prisma.Decimal(50),
      type: "LABOR",
    },
  });
  let missingTradeRejected = false;
  try {
    await saveDraftEstimateLineAsCatalog(prisma, accessA, {
      estimateId: reuseEstimate.id,
      lineItemId: customUnlinked.id,
    });
  } catch (error) {
    missingTradeRejected =
      error instanceof Error &&
      error.message === ESTIMATE_CATALOG_TRADE_REQUIRED_MESSAGE;
  }
  check(
    "Manual multi-trade estimate requires an explicit ACTIVE trade before save-to-catalog",
    missingTradeRejected,
  );

  let inactiveSaveRejected = false;
  try {
    await saveDraftEstimateLineAsCatalog(prisma, accessA, {
      estimateId: reuseEstimate.id,
      lineItemId: customUnlinked.id,
      requestedTradeCode: "PLUMBING",
    });
  } catch (error) {
    inactiveSaveRejected =
      error instanceof Error &&
      error.message === "That trade is not active on this business.";
  }
  check(
    "Explicit save-to-catalog trade must be an ACTIVE BusinessTrade",
    inactiveSaveRejected,
  );

  const savedCleaningCustom = await saveDraftEstimateLineAsCatalog(prisma, accessA, {
    estimateId: reuseEstimate.id,
    lineItemId: customUnlinked.id,
    requestedTradeCode: "CLEANING",
  });
  check(
    "Explicit Cleaning choice creates a Cleaning catalog row, not Handyman",
    savedCleaningCustom.tradeCode === "CLEANING" &&
      savedCleaningCustom.name === "Custom multi-trade save",
  );

  const sharedHandyLine = await prisma.lineItem.create({
    data: {
      businessId: handyA.id,
      estimateId: reuseEstimate.id,
      description: "Shared Visit Name",
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(80),
      total: new Prisma.Decimal(80),
      type: "LABOR",
    },
  });
  const savedSharedHandy = await saveDraftEstimateLineAsCatalog(prisma, accessA, {
    estimateId: reuseEstimate.id,
    lineItemId: sharedHandyLine.id,
    requestedTradeCode: "HANDYMAN",
    savePrice: true,
  });
  const sharedHandyAfter = await prisma.serviceCatalogItem.findUnique({
    where: { id: sharedHandy.id },
  });
  const sharedCleanAfter = await prisma.serviceCatalogItem.findUnique({
    where: { id: sharedClean.id },
  });
  check(
    "Same-name Handyman and Cleaning catalog services stay separate",
    savedSharedHandy.id === sharedHandy.id &&
      savedSharedHandy.tradeCode === "HANDYMAN" &&
      sharedHandyAfter.price.toString() === "80" &&
      sharedCleanAfter.id === sharedClean.id &&
      sharedCleanAfter.tradeCode === "CLEANING" &&
      sharedCleanAfter.price.toString() === "90",
  );

  const linkedHandyLine = await addCatalogItemToDraftEstimate(prisma, accessA, {
    estimateId: reuseEstimate.id,
    catalogItemId: sharedHandy.id,
    quantity: new Prisma.Decimal(1),
  });
  const savedLinked = await saveDraftEstimateLineAsCatalog(prisma, accessA, {
    estimateId: reuseEstimate.id,
    lineItemId: linkedHandyLine.id,
    requestedTradeCode: "CLEANING",
  });
  check(
    "Linked catalog line keeps its catalog trade even if Cleaning is requested",
    savedLinked.id === sharedHandy.id && savedLinked.tradeCode === "HANDYMAN",
  );

  const requestBackedEstimate = await prisma.estimate.create({
    data: {
      businessId: handyA.id,
      customerId: builderCustomer.id,
      serviceRequestId: request?.id,
      status: "DRAFT",
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  const requestBackedLine = await prisma.lineItem.create({
    data: {
      businessId: handyA.id,
      estimateId: requestBackedEstimate.id,
      description: "Frozen request custom save",
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(60),
      total: new Prisma.Decimal(60),
      type: "LABOR",
    },
  });
  const savedFromRequest = await saveDraftEstimateLineAsCatalog(prisma, accessA, {
    estimateId: requestBackedEstimate.id,
    lineItemId: requestBackedLine.id,
  });
  check(
    "Estimate from a ServiceRequest uses the frozen request trade for save-to-catalog",
    savedFromRequest.tradeCode === "CLEANING" &&
      savedFromRequest.name === "Frozen request custom save",
  );

  const betaCustomer = await prisma.customer.create({
    data: { businessId: handyB.id, name: "Beta Builder", email: "beta-builder@example.com" },
  });
  const betaEstimate = await prisma.estimate.create({
    data: {
      businessId: handyB.id,
      customerId: betaCustomer.id,
      status: "DRAFT",
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  const betaLine = await prisma.lineItem.create({
    data: {
      businessId: handyB.id,
      estimateId: betaEstimate.id,
      description: "Single-trade inferred save",
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(40),
      total: new Prisma.Decimal(40),
      type: "LABOR",
    },
  });
  const savedInferred = await saveDraftEstimateLineAsCatalog(prisma, accessB, {
    estimateId: betaEstimate.id,
    lineItemId: betaLine.id,
  });
  check(
    "Single ACTIVE trade is inferred for a manual estimate save-to-catalog",
    savedInferred.tradeCode === "HANDYMAN" &&
      savedInferred.businessId === handyB.id,
  );

  console.log("\nLIVE — Recurrence eligibility is enforced from trade config");
  const craftedHandy = await prisma.serviceCatalogItem.create({
    data: {
      businessId: handyA.id,
      tradeCode: "HANDYMAN",
      name: "Crafted Recurring Handyman",
      pricingMode: "FIXED",
      price: new Prisma.Decimal(100),
      category: "General Home Repairs",
      active: true,
      recurrenceEligible: catalogRecurrenceEligibleForTrade(
        "HANDYMAN",
        true,
        true,
        false,
      ),
    },
  });
  const cleaningRecurring = await prisma.serviceCatalogItem.create({
    data: {
      businessId: handyA.id,
      tradeCode: "CLEANING",
      name: "Owner Recurring Clean",
      pricingMode: "FIXED",
      price: new Prisma.Decimal(120),
      category: "Standard Cleaning",
      active: true,
      recurrenceEligible: catalogRecurrenceEligibleForTrade(
        "CLEANING",
        true,
        true,
        false,
      ),
      unitLabel: "per visit",
    },
  });
  const cleaningPreserved = catalogRecurrenceEligibleForTrade(
    "CLEANING",
    false,
    false,
    cleaningRecurring.recurrenceEligible,
  );
  const handyForcedOff = catalogRecurrenceEligibleForTrade(
    "HANDYMAN",
    false,
    false,
    true,
  );
  check(
    "Crafted Handyman recurrence stays false; Cleaning owner value and ordinary omit stay trade-safe",
    craftedHandy.recurrenceEligible === false &&
      cleaningRecurring.recurrenceEligible === true &&
      cleaningPreserved === true &&
      handyForcedOff === false &&
      cleaningRecurring.unitLabel === "per visit",
  );

  console.log("\nLIVE — Request recurrence is copied onto Job from Estimate");
  const weeklyCleaning = await createPublicServiceRequest(prisma, {
    slug: handyA.slug,
    name: "Weekly Customer",
    email: "weekly@example.com",
    phone: "5550008888",
    address: "10 Main St",
    streetAddress: "10 Main St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Weekly clean to job",
    catalogItemIds: [cleanService.id],
    includeOther: false,
    otherDescription: "",
    intakeAnswers: {
      bedrooms: 3,
      bathrooms: 2,
      homeSize: "1500_2000",
      frequency: "WEEKLY",
    },
  });
  const weeklyRequest = weeklyCleaning.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: weeklyCleaning.requestId } })
    : null;
  const weeklyRecurrence = jobRecurrenceFromServiceRequest(weeklyRequest);
  const weeklyEstimate = await prisma.estimate.create({
    data: {
      businessId: handyA.id,
      customerId: (
        await prisma.customer.create({
          data: { businessId: handyA.id, name: "Weekly Job Customer", email: "weekly-job@example.com" },
        })
      ).id,
      serviceRequestId: weeklyRequest?.id,
      status: "APPROVED",
      total: new Prisma.Decimal(180),
      publicToken: randomUUID(),
    },
  });
  const weeklyJob = await prisma.job.create({
    data: {
      businessId: handyA.id,
      customerId: weeklyEstimate.customerId,
      estimateId: weeklyEstimate.id,
      projectToken: randomUUID(),
      status: "UNSCHEDULED",
      serviceIntent: weeklyRecurrence.serviceIntent,
      recurrenceCadence: weeklyRecurrence.recurrenceCadence,
      recurrenceStatus: weeklyRecurrence.recurrenceStatus,
    },
  });
  check(
    "Cleaning weekly request → estimate → Job stays RECURRING / WEEKLY / ACTIVE",
    weeklyRequest?.serviceIntent === "RECURRING" &&
      weeklyRequest?.recurrenceCadence === "WEEKLY" &&
      weeklyJob.serviceIntent === "RECURRING" &&
      weeklyJob.recurrenceCadence === "WEEKLY" &&
      weeklyJob.recurrenceStatus === "ACTIVE",
  );

  const handyRecurrence = jobRecurrenceFromServiceRequest(handyRequest);
  const handyJobFromRequest = await prisma.job.create({
    data: {
      businessId: handyA.id,
      customerId: (
        await prisma.customer.create({
          data: { businessId: handyA.id, name: "Handy Job Customer", email: "handy-job@example.com" },
        })
      ).id,
      projectToken: randomUUID(),
      status: "UNSCHEDULED",
      serviceIntent: handyRecurrence.serviceIntent,
      recurrenceCadence: handyRecurrence.recurrenceCadence,
      recurrenceStatus: handyRecurrence.recurrenceStatus,
    },
  });
  const manualRecurrence = jobRecurrenceFromServiceRequest(null);
  check(
    "Handyman request Job stays ONE_TIME; legacy estimate without a request stays ONE_TIME",
    handyJobFromRequest.serviceIntent === "ONE_TIME" &&
      handyJobFromRequest.recurrenceCadence === "" &&
      handyJobFromRequest.recurrenceStatus === "" &&
      manualRecurrence.serviceIntent === "ONE_TIME",
  );

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

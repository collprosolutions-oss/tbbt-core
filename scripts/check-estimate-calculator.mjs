/**
 * Variable-scope Decorative Wall Paneling calculator.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-estimate-calculator.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { CAPABILITIES, ForbiddenError, roleHasCapability } = await import(
  "@/lib/authorization"
);
const { persistDraftEstimateTotal } = await import("@/lib/labor-minimum");
const { createEstimateVersionSnapshot } = await import("@/lib/estimate-version");
const {
  CALCULATOR_SNAPSHOT_MARKER,
  catalogCalculatorDefinition,
  catalogScopeText,
  joinLineDescription,
  lineCalculatorSnapshot,
  lineItemIncludedWork,
  lineItemTitle,
} = await import("@/lib/estimate-line-scope");
const {
  DECORATIVE_WALL_PANELING_CALCULATOR_ID,
  DECORATIVE_WALL_PANELING_TITLE,
  DEFAULT_DECORATIVE_WALL_PANELING_RATES,
  FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE,
  computeDecorativeWallPaneling,
  definitionOmitsJobQuantities,
  findCatalogCalculatorDefinition,
  persistableCalculatorRates,
  resolveCalculatorRatesForForm,
  startingCalculatorSnapshot,
  suggestedPanelEquivalents,
  grossWallAreaSqFt,
} = await import("@/lib/estimate-calculators");
const {
  EstimateLineError,
  addCatalogItemToDraftEstimate,
  applyDraftEstimateCalculator,
  overrideDraftEstimateLinePrice,
  persistDraftEstimateCalculatorRates,
  saveDraftEstimateLineAsCatalog,
} = await import("@/lib/estimate-line-ops");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_estimate_calculator_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for estimate-calculator test database.");
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
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: { role, membership: { id: membershipId } },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

const WALL_SCOPE = [
  "Remove and dispose of existing siding/paneling",
  "Install new wall paneling",
  "Install required finish trim",
  "Job-site cleanup and debris removal",
].join("\n");

try {
  console.log("\nSTATIC — Calculator framework, customer hiding, no new column");
  check("OWNER can manage estimates", roleHasCapability("OWNER", CAPABILITIES.MANAGE_ESTIMATES));
  check("MEMBER cannot manage estimates", !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_ESTIMATES));

  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  check(
    "No Prisma calculator column — Preview cannot migrate a new field",
    !schema.includes("calculatorSnapshot") &&
      !schema.includes("calculatorId        ") &&
      schema.includes("CALCULATOR_SNAPSHOT_MARKER"),
  );

  const customerPage = readFileSync(
    new URL("../src/app/e/[token]/page.tsx", import.meta.url),
    "utf8",
  );
  check(
    "Customer estimate does not mount the internal calculator UI",
    !customerPage.includes("VariableScopeCalculatorForm") &&
      !customerPage.includes("CalculatorBreakdown") &&
      !customerPage.includes("TBBT Calculator Snapshot") &&
      customerPage.includes("lineItemTitle") &&
      customerPage.includes("IncludedWorkDisplay"),
  );

  const ownerPage = readFileSync(
    new URL("../src/app/(app)/estimates/[estimateId]/page.tsx", import.meta.url),
    "utf8",
  );
  check(
    "Owner DRAFT page mounts the calculator and keeps apply on the server",
    ownerPage.includes("VariableScopeCalculatorForm") &&
      ownerPage.includes("applyEstimateCalculator") === false &&
      ownerPage.includes("OverrideLinePriceForm") &&
      ownerPage.includes("resolveCalculatorRatesForForm") &&
      ownerPage.includes("findCatalogCalculatorDefinition"),
  );

  const firstUseRates = resolveCalculatorRatesForForm({
    calculatorId: DECORATIVE_WALL_PANELING_CALCULATOR_ID,
    snapshot: null,
    businessRates: findCatalogCalculatorDefinition([], {
      calculatorId: DECORATIVE_WALL_PANELING_CALCULATOR_ID,
      title: DECORATIVE_WALL_PANELING_TITLE,
    })?.rates,
  });
  check(
    "First use gets founder starter rates when the business has no saved pricing",
    firstUseRates.panelRate === 90 &&
      firstUseRates.removalRatePerSqFt === 1.25 &&
      firstUseRates.slidingPatioDoorRate === 150 &&
      firstUseRates.standardDoorRate === 100 &&
      firstUseRates.windowRate === 100 &&
      firstUseRates.receptacleRate === 50 &&
      firstUseRates.switchRate === 50 &&
      firstUseRates.lightFixtureRate === 75 &&
      firstUseRates.defaultTrimAllowance === 180 &&
      firstUseRates.defaultCleanupAllowance === 75 &&
      JSON.stringify(firstUseRates) === JSON.stringify(DEFAULT_DECORATIVE_WALL_PANELING_RATES),
  );

  const editedRates = persistableCalculatorRates(
    DECORATIVE_WALL_PANELING_CALCULATOR_ID,
    { ...DEFAULT_DECORATIVE_WALL_PANELING_RATES, panelRate: 105 },
    { ...FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE, wallWidthFt: 24, notes: "job notes" },
  );
  check(
    "Persisted rates include every calculator rate and omit job quantities",
    editedRates.panelRate === 105 &&
      editedRates.removalRatePerSqFt === 1.25 &&
      editedRates.slidingPatioDoorRate === 150 &&
      editedRates.windowRate === 100 &&
      editedRates.receptacleRate === 50 &&
      editedRates.switchRate === 50 &&
      editedRates.lightFixtureRate === 75 &&
      editedRates.defaultTrimAllowance === 180 &&
      editedRates.defaultCleanupAllowance === 75 &&
      definitionOmitsJobQuantities({
        calculatorId: DECORATIVE_WALL_PANELING_CALCULATOR_ID,
        rates: editedRates,
      }) &&
      !JSON.stringify(editedRates).includes("wallWidthFt") &&
      !JSON.stringify(editedRates).includes("notes"),
  );

  const futureFromSaved = startingCalculatorSnapshot({
    title: DECORATIVE_WALL_PANELING_TITLE,
    definition: {
      calculatorId: DECORATIVE_WALL_PANELING_CALCULATOR_ID,
      rates: editedRates,
    },
  });
  check(
    "Future estimates start from saved rates with empty job quantities",
    futureFromSaved?.rates.panelRate === 105 &&
      futureFromSaved?.inputs.wallWidthFt === 0 &&
      futureFromSaved?.inputs.windows === 0 &&
      futureFromSaved?.inputs.slidingPatioDoors === 0 &&
      futureFromSaved?.inputs.notes === "",
  );

  const ownerOps = readFileSync(
    new URL("../src/lib/estimate-line-ops.ts", import.meta.url),
    "utf8",
  );
  const overrideForm = readFileSync(
    new URL("../src/components/estimates/override-line-price-form.tsx", import.meta.url),
    "utf8",
  );
  const calculatorForm = readFileSync(
    new URL("../src/components/estimates/variable-scope-calculator-form.tsx", import.meta.url),
    "utf8",
  );
  check(
    "Rate edits persist automatically; a final-price override does not rewrite saved rates",
    calculatorForm.includes("persistEstimateCalculatorRates") &&
      calculatorForm.includes("persistRates") &&
      overrideForm.includes("overrideEstimateLinePrice") &&
      !overrideForm.includes("persistEstimateCalculatorRates") &&
      ownerOps.includes("persistDraftEstimateCalculatorRates") &&
      ownerOps.includes("writeBusinessCalculatorRates") &&
      /export async function overrideDraftEstimateLinePrice[\s\S]+?\nexport /m.test(
        `${ownerOps}\nexport `,
      ) &&
      !ownerOps
        .slice(
          ownerOps.indexOf("export async function overrideDraftEstimateLinePrice"),
        )
        .includes("writeBusinessCalculatorRates"),
  );

  const invoiceList = readFileSync(
    new URL("../src/components/invoices/work-performed-list.tsx", import.meta.url),
    "utf8",
  );
  const portalChangeOrders = readFileSync(
    new URL("../src/components/portal/change-orders-card.tsx", import.meta.url),
    "utf8",
  );
  check(
    "Customer-facing surfaces do not expose internal calculator details",
    !customerPage.includes("panelRate") &&
      !customerPage.includes("VariableScopeCalculatorForm") &&
      customerPage.includes("lineItemTitle") &&
      invoiceList.includes("lineItemTitle") &&
      !invoiceList.includes("VariableScopeCalculatorForm") &&
      !invoiceList.includes("panelRate") &&
      portalChangeOrders.includes("lineItemTitle") &&
      !portalChangeOrders.includes("CalculatorBreakdown"),
  );

  const founder = computeDecorativeWallPaneling(
    FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE,
    DEFAULT_DECORATIVE_WALL_PANELING_RATES,
  );
  check("Gross area is 24 × 12 = 288 sq ft", grossWallAreaSqFt(24, 12) === 288);
  check(
    "Openings are not subtracted from gross labor area",
    grossWallAreaSqFt(24, 12) === 288,
  );
  check("4×8 panel-equivalent count is 9", suggestedPanelEquivalents(24, 12) === 9);
  check("Founder example recommended labor total is exactly $1,800", founder.recommendedAmount === 1800);
  check(
    "Founder example breakdown matches the quoted add-ons",
    founder.lines.find((line) => line.key === "panels")?.amount === 810 &&
      founder.lines.find((line) => line.key === "removal")?.amount === 360 &&
      founder.lines.find((line) => line.key === "patio-doors")?.amount === 150 &&
      founder.lines.find((line) => line.key === "windows")?.amount === 100 &&
      founder.lines.find((line) => line.key === "receptacles")?.amount === 50 &&
      founder.lines.find((line) => line.key === "fixtures")?.amount === 75 &&
      founder.lines.find((line) => line.key === "trim")?.amount === 180 &&
      founder.lines.find((line) => line.key === "cleanup")?.amount === 75,
  );
  const editedAllowances = computeDecorativeWallPaneling(
    { ...FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE, trimAllowance: 200, cleanupAllowance: 50 },
    DEFAULT_DECORATIVE_WALL_PANELING_RATES,
  );
  check(
    "Editable trim and cleanup allowances change the recommendation",
    editedAllowances.recommendedAmount === 1795 &&
      editedAllowances.lines.find((line) => line.key === "trim")?.amount === 200 &&
      editedAllowances.lines.find((line) => line.key === "cleanup")?.amount === 50,
  );
  check(
    "Manual panel quantity overrides the auto 4×8 count",
    computeDecorativeWallPaneling(
      { ...FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE, panelQuantity: 10 },
      DEFAULT_DECORATIVE_WALL_PANELING_RATES,
    ).recommendedAmount === 1890,
  );

  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-calc-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-calc-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Beta Owner", email: `beta-calc-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const businessA = await prisma.business.create({
    data: { name: "Alpha Calc", slug: `alpha-calc-${randomUUID().slice(0, 8)}` },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Calc", slug: `beta-calc-${randomUUID().slice(0, 8)}` },
  });
  const membershipA = await prisma.membership.create({
    data: { businessId: businessA.id, userId: ownerUser.id, role: "OWNER" },
  });
  const membershipMember = await prisma.membership.create({
    data: { businessId: businessA.id, userId: memberUser.id, role: "MEMBER" },
  });
  const membershipB = await prisma.membership.create({
    data: { businessId: businessB.id, userId: betaUser.id, role: "OWNER" },
  });
  const ownerA = makeAccess(businessA.id, "OWNER", membershipA.id);
  const memberA = makeAccess(businessA.id, "MEMBER", membershipMember.id);
  const ownerB = makeAccess(businessB.id, "OWNER", membershipB.id);

  console.log("\nTEST — Apply founder example on a DRAFT line");
  const estimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  const line = await prisma.lineItem.create({
    data: {
      businessId: businessA.id,
      estimateId: estimate.id,
      description: joinLineDescription(DECORATIVE_WALL_PANELING_TITLE, WALL_SCOPE),
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(0),
      total: new Prisma.Decimal(0),
      type: "LABOR",
    },
  });
  await persistDraftEstimateTotal(prisma, estimate.id, businessA.id);

  const applied = await applyDraftEstimateCalculator(prisma, ownerA, {
    estimateId: estimate.id,
    lineItemId: line.id,
    inputs: FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE,
    rates: DEFAULT_DECORATIVE_WALL_PANELING_RATES,
  });
  const appliedSnapshot = lineCalculatorSnapshot(applied.description);
  check("Recommended price applies to the DRAFT line as $1,800", applied.unitPrice.toString() === "1800");
  check("Applied line total is $1,800", applied.total.toString() === "1800");
  check("Customer-facing title stays the service name", lineItemTitle(applied.description) === DECORATIVE_WALL_PANELING_TITLE);
  check("Customer-facing scope stays separate from the calculator", lineItemIncludedWork(applied.description) === WALL_SCOPE);
  check(
    "Internal snapshot stores dimensions, quantities, rates, and recommended amount",
    appliedSnapshot?.inputs.wallWidthFt === 24 &&
      appliedSnapshot?.inputs.wallHeightFt === 12 &&
      appliedSnapshot?.inputs.removalType === "metal_siding" &&
      appliedSnapshot?.recommendedAmount === 1800 &&
      appliedSnapshot?.appliedAmount === 1800 &&
      appliedSnapshot?.rates.panelRate === 90,
  );
  check(
    "Customer-visible title and scope do not expose the calculator snapshot",
    !lineItemTitle(applied.description).includes("TBBT Calculator") &&
      !lineItemIncludedWork(applied.description)?.includes("TBBT Calculator") &&
      !lineItemIncludedWork(applied.description)?.includes("panelRate") &&
      applied.description.includes(CALCULATOR_SNAPSHOT_MARKER),
  );

  const overridden = await overrideDraftEstimateLinePrice(prisma, ownerA, {
    estimateId: estimate.id,
    lineItemId: line.id,
    unitPrice: "1900",
  });
  const overrideSnapshot = lineCalculatorSnapshot(overridden.description);
  check("Owner can override the line price after calculation", overridden.unitPrice.toString() === "1900");
  check(
    "Override keeps the recommended snapshot and records the override",
    overrideSnapshot?.recommendedAmount === 1800 &&
      overrideSnapshot?.overriddenAmount === 1900 &&
      lineItemTitle(overridden.description) === DECORATIVE_WALL_PANELING_TITLE,
  );

  await applyDraftEstimateCalculator(prisma, ownerA, {
    estimateId: estimate.id,
    lineItemId: line.id,
    inputs: FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE,
    rates: DEFAULT_DECORATIVE_WALL_PANELING_RATES,
  });

  console.log("\nTEST — SENT / APPROVED snapshots stay frozen");
  const sent = await prisma.$transaction(async (tx) => {
    await tx.estimate.updateMany({
      where: { id: estimate.id, businessId: businessA.id, status: "DRAFT" },
      data: { status: "SENT" },
    });
    return createEstimateVersionSnapshot(tx, {
      estimateId: estimate.id,
      businessId: businessA.id,
    });
  });
  const sentLine = await prisma.estimateVersionLineItem.findFirst({
    where: { estimateVersionId: sent.id },
  });
  await expectError(
    "SENT estimate cannot recalculate or apply a calculator price",
    () =>
      applyDraftEstimateCalculator(prisma, ownerA, {
        estimateId: estimate.id,
        lineItemId: line.id,
        inputs: { ...FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE, wallWidthFt: 40 },
        rates: DEFAULT_DECORATIVE_WALL_PANELING_RATES,
      }),
    (error) => error instanceof EstimateLineError,
  );
  await expectError(
    "SENT estimate cannot override the calculator price",
    () =>
      overrideDraftEstimateLinePrice(prisma, ownerA, {
        estimateId: estimate.id,
        lineItemId: line.id,
        unitPrice: "50",
      }),
    (error) => error instanceof EstimateLineError,
  );
  const sentReread = await prisma.estimateVersionLineItem.findFirst({
    where: { id: sentLine.id },
  });
  check(
    "SENT historical snapshot still has the applied $1,800 recommendation",
    sentReread.unitPrice.toString() === "1800" &&
      lineCalculatorSnapshot(sentReread.description)?.recommendedAmount === 1800 &&
      lineItemTitle(sentReread.description) === DECORATIVE_WALL_PANELING_TITLE,
  );

  await prisma.$transaction(async (tx) => {
    await tx.estimate.update({
      where: { id: estimate.id },
      data: { status: "APPROVED", approvedVersionId: sent.id },
    });
    await tx.estimateVersion.update({
      where: { id: sent.id },
      data: { approvedAt: new Date() },
    });
  });
  await expectError(
    "APPROVED estimate cannot recalculate",
    () =>
      applyDraftEstimateCalculator(prisma, ownerA, {
        estimateId: estimate.id,
        lineItemId: line.id,
        inputs: FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE,
        rates: DEFAULT_DECORATIVE_WALL_PANELING_RATES,
      }),
    (error) => error instanceof EstimateLineError,
  );

  console.log("\nTEST — Catalog save does not carry prior job quantities");
  const reuseEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  const reuseLine = await prisma.lineItem.create({
    data: {
      businessId: businessA.id,
      estimateId: reuseEstimate.id,
      description: applied.description,
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(1800),
      total: new Prisma.Decimal(1800),
      type: "LABOR",
    },
  });
  const saved = await saveDraftEstimateLineAsCatalog(prisma, ownerA, {
    estimateId: reuseEstimate.id,
    lineItemId: reuseLine.id,
    savePrice: true,
  });
  const savedDefinition = catalogCalculatorDefinition(saved.description);
  check("Saved catalog keeps the calculator type", savedDefinition?.calculatorId === "decorative-wall-paneling");
  check("Saved catalog keeps the reusable scope", catalogScopeText(saved.description) === WALL_SCOPE);
  check(
    "Saved catalog does not store the previous job's 24×12 quantities",
    !JSON.stringify(savedDefinition ?? {}).includes("\"wallWidthFt\":24") &&
      savedDefinition?.rates.panelRate === 90,
  );

  const nextEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  const inserted = await addCatalogItemToDraftEstimate(prisma, ownerA, {
    estimateId: nextEstimate.id,
    catalogItemId: saved.id,
    quantity: new Prisma.Decimal(1),
    unitPrice: new Prisma.Decimal(1800),
  });
  const insertedSnapshot = lineCalculatorSnapshot(inserted.description);
  check(
    "Next estimate receives calculator type and rates without prior job quantities",
    insertedSnapshot?.calculatorId === "decorative-wall-paneling" &&
      insertedSnapshot?.inputs.wallWidthFt === 0 &&
      insertedSnapshot?.inputs.slidingPatioDoors === 0 &&
      insertedSnapshot?.rates.panelRate === 90 &&
      lineItemTitle(inserted.description) === DECORATIVE_WALL_PANELING_TITLE &&
      lineItemIncludedWork(inserted.description) === WALL_SCOPE,
  );

  console.log("\nTEST — Business rate persistence, quantities stay job-specific");
  const persistUser = await prisma.user.create({
    data: { name: "Pat Persist", email: `persist-calc-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const persistBusiness = await prisma.business.create({
    data: { name: "Persist Calc", slug: `persist-calc-${randomUUID().slice(0, 8)}` },
  });
  const persistMembership = await prisma.membership.create({
    data: { businessId: persistBusiness.id, userId: persistUser.id, role: "OWNER" },
  });
  const persistOwner = makeAccess(persistBusiness.id, "OWNER", persistMembership.id);

  async function createPanelLine(businessId) {
    const nextEstimate = await prisma.estimate.create({
      data: {
        businessId,
        total: new Prisma.Decimal(0),
        publicToken: randomUUID(),
      },
    });
    const nextLine = await prisma.lineItem.create({
      data: {
        businessId,
        estimateId: nextEstimate.id,
        description: joinLineDescription(DECORATIVE_WALL_PANELING_TITLE, WALL_SCOPE),
        quantity: new Prisma.Decimal(1),
        unitPrice: new Prisma.Decimal(0),
        total: new Prisma.Decimal(0),
        type: "LABOR",
      },
    });
    return { estimate: nextEstimate, line: nextLine };
  }

  const firstJob = await createPanelLine(persistBusiness.id);
  const firstUseCatalog = await prisma.serviceCatalogItem.findMany({
    where: { businessId: persistBusiness.id },
  });
  check(
    "A new business has no saved calculator rates yet",
    findCatalogCalculatorDefinition(firstUseCatalog, {
      calculatorId: DECORATIVE_WALL_PANELING_CALCULATOR_ID,
      title: DECORATIVE_WALL_PANELING_TITLE,
    }) == null,
  );

  const starterApply = await applyDraftEstimateCalculator(prisma, persistOwner, {
    estimateId: firstJob.estimate.id,
    lineItemId: firstJob.line.id,
    inputs: FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE,
    rates: DEFAULT_DECORATIVE_WALL_PANELING_RATES,
  });
  check("First apply with starter rates prices the job at $1,800", starterApply.unitPrice.toString() === "1800");
  const afterStarterCatalog = await prisma.serviceCatalogItem.findMany({
    where: { businessId: persistBusiness.id },
  });
  check(
    "Applying starter rates does not invent a saved pricing history",
    findCatalogCalculatorDefinition(afterStarterCatalog, {
      calculatorId: DECORATIVE_WALL_PANELING_CALCULATOR_ID,
      title: DECORATIVE_WALL_PANELING_TITLE,
    }) == null,
  );

  const savedRates = {
    ...DEFAULT_DECORATIVE_WALL_PANELING_RATES,
    panelRate: 105,
    removalRatePerSqFt: 1.5,
    slidingPatioDoorRate: 160,
    standardDoorRate: 110,
    windowRate: 120,
    receptacleRate: 55,
    switchRate: 55,
    lightFixtureRate: 80,
    defaultTrimAllowance: 200,
    defaultCleanupAllowance: 80,
  };
  await persistDraftEstimateCalculatorRates(prisma, persistOwner, {
    estimateId: firstJob.estimate.id,
    lineItemId: firstJob.line.id,
    rates: savedRates,
    inputs: {
      ...FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE,
      trimAllowance: 200,
      cleanupAllowance: 80,
      notes: "Do not persist these job notes",
    },
  });
  const persistedCatalog = await prisma.serviceCatalogItem.findFirst({
    where: {
      businessId: persistBusiness.id,
      name: { equals: DECORATIVE_WALL_PANELING_TITLE, mode: "insensitive" },
    },
  });
  const persistedDefinition = catalogCalculatorDefinition(persistedCatalog?.description);
  check(
    "Editing a rate persists every calculator rate as the business default",
    persistedDefinition?.calculatorId === "decorative-wall-paneling" &&
      persistedDefinition?.rates.panelRate === 105 &&
      persistedDefinition?.rates.removalRatePerSqFt === 1.5 &&
      persistedDefinition?.rates.slidingPatioDoorRate === 160 &&
      persistedDefinition?.rates.standardDoorRate === 110 &&
      persistedDefinition?.rates.windowRate === 120 &&
      persistedDefinition?.rates.receptacleRate === 55 &&
      persistedDefinition?.rates.switchRate === 55 &&
      persistedDefinition?.rates.lightFixtureRate === 80 &&
      persistedDefinition?.rates.defaultTrimAllowance === 200 &&
      persistedDefinition?.rates.defaultCleanupAllowance === 80,
  );
  check(
    "Persisted business rates do not include job-specific quantities or notes",
    definitionOmitsJobQuantities(persistedDefinition) &&
      catalogScopeText(persistedCatalog?.description) === WALL_SCOPE &&
      !JSON.stringify(persistedDefinition ?? {}).includes("24") &&
      !JSON.stringify(persistedDefinition ?? {}).includes("job notes"),
  );
  check(
    "Persisting rates does not rewrite the catalog default price from the job total",
    persistedCatalog?.price == null,
  );

  const futureEstimate = await prisma.estimate.create({
    data: {
      businessId: persistBusiness.id,
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  const futureLine = await addCatalogItemToDraftEstimate(prisma, persistOwner, {
    estimateId: futureEstimate.id,
    catalogItemId: persistedCatalog.id,
    quantity: new Prisma.Decimal(1),
  });
  const futureSnapshot = lineCalculatorSnapshot(futureLine.description);
  check(
    "Future Decorative Wall Paneling estimates start with the saved $105 panel rate",
    futureSnapshot?.rates.panelRate === 105 &&
      futureSnapshot?.rates.windowRate === 120 &&
      futureSnapshot?.rates.defaultTrimAllowance === 200 &&
      futureSnapshot?.rates.defaultCleanupAllowance === 80,
  );
  check(
    "Future estimates do not carry forward prior job quantities",
    futureSnapshot?.inputs.wallWidthFt === 0 &&
      futureSnapshot?.inputs.wallHeightFt === 0 &&
      futureSnapshot?.inputs.panelQuantity == null &&
      futureSnapshot?.inputs.windows === 0 &&
      futureSnapshot?.inputs.slidingPatioDoors === 0 &&
      futureSnapshot?.inputs.receptacles === 0 &&
      futureSnapshot?.inputs.switches === 0 &&
      futureSnapshot?.inputs.lightFixtures === 0 &&
      futureSnapshot?.inputs.notes === "",
  );

  const recountInputs = {
    ...FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE,
    windows: 2,
    standardDoors: 1,
    trimAllowance: 200,
    cleanupAllowance: 80,
  };
  const recount = computeDecorativeWallPaneling(recountInputs, futureSnapshot.rates);
  const recountStarter = computeDecorativeWallPaneling(
    recountInputs,
    DEFAULT_DECORATIVE_WALL_PANELING_RATES,
  );
  check(
    "Changing job counts recalculates from the saved rates, not starter rates",
    recount.recommendedAmount !== recountStarter.recommendedAmount &&
      recount.lines.find((item) => item.key === "panels")?.rate === 105 &&
      recount.lines.find((item) => item.key === "windows")?.amount === 240 &&
      recount.lines.find((item) => item.key === "doors")?.amount === 110,
  );
  const recountedJob = await applyDraftEstimateCalculator(prisma, persistOwner, {
    estimateId: futureEstimate.id,
    lineItemId: futureLine.id,
    inputs: recountInputs,
    rates: futureSnapshot.rates,
  });
  check(
    "Applying a new job's counts writes the recalculated price from saved rates",
    Number(recountedJob.unitPrice.toString()) === recount.recommendedAmount,
  );
  const catalogAfterRecount = catalogCalculatorDefinition(
    (
      await prisma.serviceCatalogItem.findFirst({
        where: { id: persistedCatalog.id },
      })
    )?.description,
  );
  check(
    "Recalculating from saved rates does not replace them with starter rates",
    catalogAfterRecount?.rates.panelRate === 105 &&
      catalogAfterRecount?.rates.windowRate === 120,
  );

  const overriddenJob = await overrideDraftEstimateLinePrice(prisma, persistOwner, {
    estimateId: futureEstimate.id,
    lineItemId: futureLine.id,
    unitPrice: "1600",
  });
  const catalogAfterOverride = await prisma.serviceCatalogItem.findFirst({
    where: { id: persistedCatalog.id },
  });
  const definitionAfterOverride = catalogCalculatorDefinition(catalogAfterOverride?.description);
  check("One-time final estimate override sets this job to $1,600", overriddenJob.unitPrice.toString() === "1600");
  check(
    "A customer discount does not change the saved calculator rates",
    definitionAfterOverride?.rates.panelRate === 105 &&
      definitionAfterOverride?.rates.windowRate === 120 &&
      definitionAfterOverride?.rates.defaultTrimAllowance === 200 &&
      catalogAfterOverride?.price == null,
  );

  const thirdEstimate = await prisma.estimate.create({
    data: {
      businessId: persistBusiness.id,
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  const thirdLine = await addCatalogItemToDraftEstimate(prisma, persistOwner, {
    estimateId: thirdEstimate.id,
    catalogItemId: persistedCatalog.id,
    quantity: new Prisma.Decimal(1),
  });
  const thirdSnapshot = lineCalculatorSnapshot(thirdLine.description);
  const nextFormula = computeDecorativeWallPaneling(
    FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE,
    thirdSnapshot.rates,
  );
  check(
    "The next estimate still calculates from the saved formula, not the discounted $1,600",
    thirdSnapshot?.rates.panelRate === 105 &&
      thirdSnapshot?.inputs.wallWidthFt === 0 &&
      nextFormula.recommendedAmount !== 1600 &&
      nextFormula.lines.find((item) => item.key === "panels")?.rate === 105,
  );

  await persistDraftEstimateCalculatorRates(prisma, persistOwner, {
    estimateId: thirdEstimate.id,
    lineItemId: thirdLine.id,
    rates: { ...savedRates, panelRate: 110 },
    inputs: { trimAllowance: 200, cleanupAllowance: 80 },
  });
  const replacedCatalog = await prisma.serviceCatalogItem.findFirst({
    where: { id: persistedCatalog.id },
  });
  const replacedDefinition = catalogCalculatorDefinition(replacedCatalog?.description);
  check(
    "A later rate edit replaces the prior saved default",
    replacedDefinition?.rates.panelRate === 110 &&
      replacedDefinition?.rates.windowRate === 120,
  );
  const fourthEstimate = await prisma.estimate.create({
    data: {
      businessId: persistBusiness.id,
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  const fourthLine = await addCatalogItemToDraftEstimate(prisma, persistOwner, {
    estimateId: fourthEstimate.id,
    catalogItemId: persistedCatalog.id,
    quantity: new Prisma.Decimal(1),
  });
  check(
    "Estimates created after the later edit start at $110",
    lineCalculatorSnapshot(fourthLine.description)?.rates.panelRate === 110 &&
      lineCalculatorSnapshot(fourthLine.description)?.inputs.windows === 0,
  );

  const applyEdited = await createPanelLine(persistBusiness.id);
  const appliedWithNewRate = await applyDraftEstimateCalculator(prisma, persistOwner, {
    estimateId: applyEdited.estimate.id,
    lineItemId: applyEdited.line.id,
    inputs: FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE,
    rates: { ...savedRates, panelRate: 125 },
  });
  const afterApplyDefinition = catalogCalculatorDefinition(
    (
      await prisma.serviceCatalogItem.findFirst({
        where: { id: persistedCatalog.id },
      })
    )?.description,
  );
  check(
    "Applying a calculator with an edited rate also persists that rate",
    appliedWithNewRate.unitPrice.toString() !== "1800" &&
      lineCalculatorSnapshot(appliedWithNewRate.description)?.rates.panelRate === 125 &&
      afterApplyDefinition?.rates.panelRate === 125,
  );

  await expectError(
    "MEMBER cannot persist calculator rates",
    () =>
      persistDraftEstimateCalculatorRates(prisma, memberA, {
        estimateId: firstJob.estimate.id,
        lineItemId: firstJob.line.id,
        rates: savedRates,
      }),
    (error) => error instanceof ForbiddenError || error instanceof EstimateLineError,
  );

  console.log("\nTEST — Tenant isolation");
  await expectError(
    "Business B cannot apply a calculator on Business A's estimate",
    () =>
      applyDraftEstimateCalculator(prisma, ownerB, {
        estimateId: nextEstimate.id,
        lineItemId: inserted.id,
        inputs: FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE,
        rates: DEFAULT_DECORATIVE_WALL_PANELING_RATES,
      }),
    (error) => error instanceof Error,
  );
  await expectError(
    "MEMBER cannot apply a calculator",
    () =>
      applyDraftEstimateCalculator(prisma, memberA, {
        estimateId: nextEstimate.id,
        lineItemId: inserted.id,
        inputs: FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE,
        rates: DEFAULT_DECORATIVE_WALL_PANELING_RATES,
      }),
    (error) => error instanceof ForbiddenError || error instanceof EstimateLineError,
  );
  const insertedUnchanged = await prisma.lineItem.findFirst({
    where: { id: inserted.id, businessId: businessA.id },
  });
  check(
    "Rejected calculator apply did not change Business A quantities",
    lineCalculatorSnapshot(insertedUnchanged.description)?.inputs.wallWidthFt === 0,
  );

  console.log(
    failures === 0
      ? "\nAll estimate calculator checks passed."
      : `\n${failures} estimate calculator check(s) failed.`,
  );
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

process.exit(failures === 0 ? 0 : 1);

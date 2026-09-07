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
  CUSTOMER_POLICY_MARKER,
  catalogCalculatorDefinition,
  catalogScopeText,
  joinLineDescription,
  lineCalculatorSnapshot,
  lineCustomerPolicies,
  lineItemIncludedWork,
  lineItemTitle,
} = await import("@/lib/estimate-line-scope");
const {
  CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID,
  DECORATIVE_WALL_PANELING_CALCULATOR_ID,
  DECORATIVE_WALL_PANELING_TEMPLATE,
  DECORATIVE_WALL_PANELING_TITLE,
  DEFAULT_DECORATIVE_WALL_PANELING_RATES,
  DEFAULT_CONTENTS_HANDLING_RATES,
  DEFAULT_CONTENTS_PROTECTION_RATES,
  DEFAULT_BELONGINGS_CLEANUP_RATES,
  FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE,
  computeCalculator,
  computeDecorativeWallPaneling,
  computeVariableScope,
  computeWorkAreaService,
  definitionOmitsJobQuantities,
  emptyCalculatorInputs,
  emptyDecorativeWallPanelingInputs,
  findCatalogCalculatorDefinition,
  jobQuantityKeysFromTemplate,
  persistableCalculatorRates,
  resolveCalculatorRatesForForm,
  startingCalculatorSnapshot,
  stepCount,
  parseTypedCount,
  suggestedPanelEquivalents,
  grossWallAreaSqFt,
} = await import("@/lib/estimate-calculators");
const {
  DEFAULT_WORK_AREA_PERSONAL_PROPERTY_BODY,
  WORK_AREA_PERSONAL_PROPERTY_TITLE,
  defaultWorkAreaPersonalPropertyPolicy,
} = await import("@/lib/estimate-policies");
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

const SYNTHETIC_CUSTOM_TEMPLATE = {
  calculatorId: "custom-variable-scope",
  title: "Test Custom Opening Work",
  components: [
    {
      key: "area",
      name: "Affected area",
      inputType: "measurement",
      units: "sq ft",
      quantityKey: "areaSqFt",
      rateKey: "areaRate",
      defaultRate: 2.5,
      persistRate: true,
      resetQuantity: true,
      customerVisible: false,
      section: "measurements",
    },
    {
      key: "openings",
      name: "Openings",
      inputType: "count",
      units: "each",
      quantityKey: "openingCount",
      rateKey: "openingRate",
      defaultRate: 40,
      persistRate: true,
      resetQuantity: true,
      customerVisible: false,
      section: "counts",
    },
    {
      key: "travel",
      name: "Travel allowance",
      inputType: "allowance",
      units: "usd",
      quantityKey: "travelAllowance",
      rateKey: "defaultTravelAllowance",
      defaultRate: 50,
      persistRate: true,
      resetQuantity: false,
      customerVisible: false,
      section: "allowances",
    },
  ],
};

try {
  console.log("\nSTATIC — Calculator framework, customer hiding, no new column");
  check("OWNER can manage estimates", roleHasCapability("OWNER", CAPABILITIES.MANAGE_ESTIMATES));
  check("MEMBER cannot manage estimates", !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_ESTIMATES));

  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  check(
    "No Prisma calculator column — Preview cannot migrate a new field",
    !schema.includes("calculatorSnapshot") &&
      !schema.includes("calculatorId        ") &&
      !schema.includes("customerPolicy") &&
      schema.includes("CALCULATOR_SNAPSHOT_MARKER"),
  );

  const customerPage = readFileSync(
    new URL("../src/app/e/[token]/page.tsx", import.meta.url),
    "utf8",
  );
  check(
    "Customer estimate does not mount the internal calculator UI",
    !customerPage.includes("VariableScopeCalculatorForm") &&
      !customerPage.includes("VariableScopeDefinitionForm") &&
      !customerPage.includes("CalculatorBreakdown") &&
      !customerPage.includes("TBBT Calculator Snapshot") &&
      customerPage.includes("loadEstimateDocumentByToken") &&
      customerPage.includes("CustomerEstimateLineSections") &&
      readFileSync(
        new URL(
          "../src/components/estimates/customer-estimate-line-sections.tsx",
          import.meta.url,
        ),
        "utf8",
      ).includes("Scope / Included Work") &&
      customerPage.includes("EstimateCustomerPolicies") &&
      !customerPage.includes("panelRate") &&
      !customerPage.includes("contentsHandlingLightRate"),
  );

  const ownerPage = readFileSync(
    new URL("../src/app/(app)/estimates/[estimateId]/page.tsx", import.meta.url),
    "utf8",
  );
  check(
    "Owner DRAFT page mounts the calculator and keeps apply on the server",
    ownerPage.includes("VariableScopeCalculatorForm") &&
      ownerPage.includes("VariableScopeDefinitionForm") &&
      ownerPage.includes("applyEstimateCalculator") === false &&
      ownerPage.includes("OverrideLinePriceForm") &&
      ownerPage.includes("resolveCalculatorRatesForForm") &&
      ownerPage.includes("findCatalogCalculatorDefinition") &&
      ownerPage.includes("EstimateCustomerPolicies"),
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
  const stepper = readFileSync(
    new URL("../src/components/estimates/quantity-stepper.tsx", import.meta.url),
    "utf8",
  );
  check(
    "Counted items use integer steppers; measurements stay free numeric entry",
    stepper.includes("stepCount") &&
      stepper.includes("parseTypedCount") &&
      stepper.includes("Decrease") &&
      calculatorForm.includes("QuantityStepper") &&
      calculatorForm.includes("Measurements / Area") &&
      calculatorForm.includes("Counted Items") &&
      calculatorForm.includes("Allowances / Adjustments") &&
      calculatorForm.includes('name="wallWidthFt"') &&
      calculatorForm.includes('step="0.01"'),
  );
  check(
    "Integer steppers are not forced onto dimensions or dollar rates",
    calculatorForm.includes("QuantityStepper") &&
      !stepper.includes("wallWidthFt") &&
      calculatorForm.includes("RateField") &&
      calculatorForm.includes("panelRate"),
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
      !customerPage.includes("VariableScopeDefinitionForm") &&
      customerPage.includes("loadEstimateDocumentByToken") &&
      invoiceList.includes("lineItemTitle") &&
      !invoiceList.includes("VariableScopeCalculatorForm") &&
      !invoiceList.includes("VariableScopeDefinitionForm") &&
      !invoiceList.includes("panelRate") &&
      portalChangeOrders.includes("lineItemTitle") &&
      !portalChangeOrders.includes("CalculatorBreakdown"),
  );

  const quantityKeys = jobQuantityKeysFromTemplate(DECORATIVE_WALL_PANELING_TEMPLATE);
  const persistablePanelKeys = DECORATIVE_WALL_PANELING_TEMPLATE.components
    .filter((component) => component.persistRate && component.rateKey)
    .map((component) => component.rateKey);
  check(
    "Decorative Wall Paneling is defined through the reusable variable-scope template",
    DECORATIVE_WALL_PANELING_TEMPLATE.calculatorId ===
      DECORATIVE_WALL_PANELING_CALCULATOR_ID &&
      DECORATIVE_WALL_PANELING_TEMPLATE.components.some(
        (component) =>
          component.quantityKey === "wallWidthFt" &&
          component.resetQuantity === true &&
          component.persistRate === false &&
          component.customerVisible !== true,
      ) &&
      DECORATIVE_WALL_PANELING_TEMPLATE.components.some(
        (component) =>
          component.rateKey === "panelRate" &&
          component.persistRate === true &&
          component.resetQuantity === true &&
          component.customerVisible !== true,
      ) &&
      persistablePanelKeys.includes("panelRate") &&
      persistablePanelKeys.includes("windowRate") &&
      persistablePanelKeys.includes("defaultTrimAllowance"),
  );
  check(
    "Paneling template keeps business rates distinct from project quantities",
    quantityKeys.includes("wallWidthFt") &&
      quantityKeys.includes("panelQuantity") &&
      quantityKeys.includes("windows") &&
      !quantityKeys.includes("panelRate") &&
      !quantityKeys.includes("defaultTrimAllowance") &&
      definitionOmitsJobQuantities({
        calculatorId: DECORATIVE_WALL_PANELING_CALCULATOR_ID,
        rates: persistableCalculatorRates(
          DECORATIVE_WALL_PANELING_CALCULATOR_ID,
          DEFAULT_DECORATIVE_WALL_PANELING_RATES,
          FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE,
        ),
      }),
  );

  const syntheticEmpty = emptyCalculatorInputs(
    CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID,
    undefined,
    SYNTHETIC_CUSTOM_TEMPLATE.components,
  );
  const syntheticRates = persistableCalculatorRates(
    CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID,
    { openingRate: 45 },
    { openingCount: 3, areaSqFt: 10, travelAllowance: 50 },
    SYNTHETIC_CUSTOM_TEMPLATE.components,
  );
  const syntheticResult = computeCalculator(
    CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID,
    { openingCount: 3, areaSqFt: 10, travelAllowance: 50 },
    { openingRate: 45, areaRate: 2.5, defaultTravelAllowance: 50 },
    SYNTHETIC_CUSTOM_TEMPLATE.components,
  );
  const syntheticEngineResult = computeVariableScope(
    SYNTHETIC_CUSTOM_TEMPLATE,
    { openingCount: 3, areaSqFt: 10, travelAllowance: 50 },
    { openingRate: 45, areaRate: 2.5, defaultTravelAllowance: 50 },
  );
  const syntheticStart = startingCalculatorSnapshot({
    definition: {
      calculatorId: CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID,
      rates: syntheticRates,
      components: SYNTHETIC_CUSTOM_TEMPLATE.components,
    },
  });
  const definitionForm = readFileSync(
    new URL("../src/components/estimates/variable-scope-definition-form.tsx", import.meta.url),
    "utf8",
  );
  check(
    "A second synthetic custom calculator is instantiated by the engine without a hardcoded React calculator",
    syntheticEmpty.openingCount === 0 &&
      syntheticEmpty.areaSqFt === 0 &&
      syntheticEmpty.travelAllowance == null &&
      syntheticRates.openingRate === 45 &&
      syntheticRates.areaRate === 2.5 &&
      syntheticRates.defaultTravelAllowance === 50 &&
      !Object.hasOwn(syntheticRates, "openingCount") &&
      !Object.hasOwn(syntheticRates, "areaSqFt") &&
      syntheticResult.recommendedAmount === 210 &&
      syntheticEngineResult.recommendedAmount === 210 &&
      JSON.stringify(syntheticResult) === JSON.stringify(syntheticEngineResult) &&
      syntheticStart?.inputs.openingCount === 0 &&
      syntheticStart?.inputs.areaSqFt === 0 &&
      syntheticStart?.rates.openingRate === 45 &&
      definitionOmitsJobQuantities({
        calculatorId: CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID,
        rates: syntheticRates,
        components: SYNTHETIC_CUSTOM_TEMPLATE.components,
      }) &&
      definitionForm.includes("computeVariableScope") &&
      !definitionForm.includes("drywall") &&
      !definitionForm.includes("flooring"),
  );
  check(
    "No new customer-visible internal pricing breakdown is added",
    !customerPage.includes("VariableScopeDefinitionForm") &&
      !customerPage.includes("computeVariableScope") &&
      !customerPage.includes("areaRate") &&
      !customerPage.includes("openingRate") &&
      customerPage.includes("loadEstimateDocumentByToken"),
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
  check(
    "Founder fixture stays $1,800 when the work area is clear and no contents services are selected",
    founder.recommendedAmount === 1800 &&
      founder.lines.find((line) => line.key === "contents-handling")?.amount === 0 &&
      founder.lines.find((line) => line.key === "contents-protection")?.amount === 0 &&
      founder.lines.find((line) => line.key === "belongings-cleanup")?.amount === 0,
  );
  check("Integer quantity stepper minimum is 0", stepCount(0, -1) === 0 && stepCount(2, -1) === 1);
  check("Integer quantity stepper steps by 1", stepCount(0, 1) === 1 && stepCount(3, 1) === 4);
  check("Manual count entry still works and floors to an integer", parseTypedCount("4") === 4 && parseTypedCount("2.9") === 2 && parseTypedCount("") === 0);

  const unused = computeDecorativeWallPaneling(
    emptyDecorativeWallPanelingInputs(),
    DEFAULT_DECORATIVE_WALL_PANELING_RATES,
  );
  check(
    "Untouched calculated categories wait instead of looking like $0 business rates",
    unused.lines.find((line) => line.key === "panels")?.amountState === "waiting" &&
      unused.lines.find((line) => line.key === "windows")?.amountState === "not_entered" &&
      unused.lines.find((line) => line.key === "windows")?.rate === 100 &&
      unused.lines.find((line) => line.key === "windows")?.amount === 0,
  );
  check(
    "Saved business rates stay visible when a job has zero windows",
    unused.lines.find((line) => line.key === "windows")?.rate ===
      DEFAULT_DECORATIVE_WALL_PANELING_RATES.windowRate,
  );

  const handling = computeWorkAreaService("moderate", DEFAULT_CONTENTS_HANDLING_RATES);
  const protection = computeWorkAreaService("light", DEFAULT_CONTENTS_PROTECTION_RATES);
  const belongings = computeWorkAreaService("heavy", DEFAULT_BELONGINGS_CLEANUP_RATES);
  const withContents = computeDecorativeWallPaneling(
    {
      ...FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE,
      contentsHandlingLevel: "moderate",
      contentsProtectionLevel: "light",
      belongingsCleanupLevel: "heavy",
    },
    DEFAULT_DECORATIVE_WALL_PANELING_RATES,
  );
  check("Contents handling calculates from the selected business rate", handling.amount === 165);
  check("Contents protection calculates from the selected business rate", protection.amount === 55);
  check("Additional customer-belongings cleanup calculates from the selected business rate", belongings.amount === 165);
  check(
    "Selected work-area services add labor only when chosen",
    withContents.recommendedAmount === 1800 + 165 + 55 + 165 &&
      withContents.lines.find((line) => line.key === "contents-handling")?.amount === 165 &&
      withContents.lines.find((line) => line.key === "contents-protection")?.amount === 55 &&
      withContents.lines.find((line) => line.key === "belongings-cleanup")?.amount === 165,
  );
  check(
    "Starter Work Area & Personal Property policy is configurable template text",
    defaultWorkAreaPersonalPropertyPolicy().title === WORK_AREA_PERSONAL_PROPERTY_TITLE &&
      DEFAULT_WORK_AREA_PERSONAL_PROPERTY_BODY.includes("reasonably clear") &&
      DEFAULT_WORK_AREA_PERSONAL_PROPERTY_BODY.includes("does not guarantee a completely dust-free environment"),
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
    contentsHandlingLightRate: 90,
    contentsHandlingModerateRate: 175,
    contentsHandlingHeavyRate: 310,
    contentsProtectionLightRate: 60,
    contentsProtectionModerateRate: 120,
    contentsProtectionHeavyRate: 210,
    belongingsCleanupLightRate: 50,
    belongingsCleanupModerateRate: 105,
    belongingsCleanupHeavyRate: 180,
  };
  await persistDraftEstimateCalculatorRates(prisma, persistOwner, {
    estimateId: firstJob.estimate.id,
    lineItemId: firstJob.line.id,
    rates: savedRates,
    inputs: {
      ...FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE,
      trimAllowance: 200,
      cleanupAllowance: 80,
      contentsHandlingLevel: "heavy",
      contentsProtectionLevel: "moderate",
      belongingsCleanupLevel: "light",
      notes: "Do not persist these job notes",
    },
    customerPolicies: [
      {
        id: "work-area-personal-property",
        title: WORK_AREA_PERSONAL_PROPERTY_TITLE,
        body: DEFAULT_WORK_AREA_PERSONAL_PROPERTY_BODY,
      },
    ],
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
      persistedDefinition?.rates.defaultCleanupAllowance === 80 &&
      persistedDefinition?.rates.contentsHandlingLightRate === 90 &&
      persistedDefinition?.rates.contentsProtectionLightRate === 60 &&
      persistedDefinition?.rates.belongingsCleanupLightRate === 50,
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
      futureSnapshot?.rates.defaultCleanupAllowance === 80 &&
      futureSnapshot?.rates.contentsHandlingLightRate === 90 &&
      futureSnapshot?.rates.contentsProtectionLightRate === 60 &&
      futureSnapshot?.rates.belongingsCleanupLightRate === 50,
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
      futureSnapshot?.inputs.contentsHandlingLevel === "clear" &&
      futureSnapshot?.inputs.contentsProtectionLevel === "none" &&
      futureSnapshot?.inputs.belongingsCleanupLevel === "none" &&
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
  const appliedPolicies = lineCustomerPolicies(appliedWithNewRate.description);
  check(
    "Applying the calculator stamps Work Area & Personal Property terms on a DRAFT line",
    appliedPolicies.length === 1 &&
      appliedPolicies[0].title === WORK_AREA_PERSONAL_PROPERTY_TITLE &&
      appliedPolicies[0].body.includes("reasonably clear") &&
      appliedWithNewRate.description.includes(CUSTOMER_POLICY_MARKER) &&
      !lineItemTitle(appliedWithNewRate.description).includes("TBBT Customer Policy") &&
      !lineItemIncludedWork(appliedWithNewRate.description)?.includes("TBBT Customer Policy"),
  );

  const policyEstimate = await prisma.estimate.create({
    data: {
      businessId: persistBusiness.id,
      total: new Prisma.Decimal(1800),
      publicToken: randomUUID(),
      status: "DRAFT",
    },
  });
  const historicalLine = await prisma.lineItem.create({
    data: {
      businessId: persistBusiness.id,
      estimateId: policyEstimate.id,
      description: joinLineDescription(DECORATIVE_WALL_PANELING_TITLE, WALL_SCOPE),
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(1800),
      total: new Prisma.Decimal(1800),
      type: "LABOR",
    },
  });
  await persistDraftEstimateTotal(prisma, policyEstimate.id, persistBusiness.id);
  const sentHistorical = await prisma.$transaction(async (tx) => {
    await tx.estimate.updateMany({
      where: { id: policyEstimate.id, businessId: persistBusiness.id, status: "DRAFT" },
      data: { status: "SENT" },
    });
    return createEstimateVersionSnapshot(tx, {
      estimateId: policyEstimate.id,
      businessId: persistBusiness.id,
    });
  });
  const sentHistoricalLine = await prisma.estimateVersionLineItem.findFirst({
    where: { estimateVersionId: sentHistorical.id },
  });
  check(
    "Historical SENT estimates without policy wording stay unchanged",
    sentHistoricalLine.description ===
      joinLineDescription(DECORATIVE_WALL_PANELING_TITLE, WALL_SCOPE) &&
      !sentHistoricalLine.description.includes(CUSTOMER_POLICY_MARKER) &&
      lineCustomerPolicies(sentHistoricalLine.description).length === 0,
  );

  const sentApplied = await prisma.$transaction(async (tx) => {
    await tx.estimate.updateMany({
      where: { id: applyEdited.estimate.id, businessId: persistBusiness.id, status: "DRAFT" },
      data: { status: "SENT" },
    });
    return createEstimateVersionSnapshot(tx, {
      estimateId: applyEdited.estimate.id,
      businessId: persistBusiness.id,
    });
  });
  const sentAppliedLine = await prisma.estimateVersionLineItem.findFirst({
    where: { estimateVersionId: sentApplied.id },
  });
  check(
    "SENT version snapshot preserves the applicable Work Area & Personal Property wording",
    lineCustomerPolicies(sentAppliedLine.description)[0]?.body ===
      appliedPolicies[0].body &&
      lineItemTitle(sentAppliedLine.description) === DECORATIVE_WALL_PANELING_TITLE,
  );

  await persistDraftEstimateCalculatorRates(prisma, persistOwner, {
    estimateId: firstJob.estimate.id,
    lineItemId: firstJob.line.id,
    rates: savedRates,
    customerPolicies: [
      {
        id: "work-area-personal-property",
        title: WORK_AREA_PERSONAL_PROPERTY_TITLE,
        body: `${DEFAULT_WORK_AREA_PERSONAL_PROPERTY_BODY}\n\nUpdated later.`,
      },
    ],
  });
  const sentAppliedReread = await prisma.estimateVersionLineItem.findFirst({
    where: { id: sentAppliedLine.id },
  });
  check(
    "Later business policy edits do not rewrite a SENT snapshot",
    lineCustomerPolicies(sentAppliedReread.description)[0]?.body ===
      appliedPolicies[0].body &&
      !lineCustomerPolicies(sentAppliedReread.description)[0]?.body.includes("Updated later."),
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

  console.log("\nTEST — Reusable custom-variable-scope engine (no hardcoded trade calculator)");
  const customEstimate = await prisma.estimate.create({
    data: {
      businessId: persistBusiness.id,
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  const customLine = await prisma.lineItem.create({
    data: {
      businessId: persistBusiness.id,
      estimateId: customEstimate.id,
      description: joinLineDescription(
        "Opening Cut-Outs",
        "Cut and finish openings",
        startingCalculatorSnapshot({
          definition: {
            calculatorId: CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID,
            rates: persistableCalculatorRates(
              CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID,
              { openingRate: 45, areaRate: 2.5, defaultTravelAllowance: 50 },
              null,
              SYNTHETIC_CUSTOM_TEMPLATE.components,
            ),
            components: SYNTHETIC_CUSTOM_TEMPLATE.components,
          },
        }),
      ),
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(0),
      total: new Prisma.Decimal(0),
      type: "LABOR",
    },
  });
  const customFresh = lineCalculatorSnapshot(customLine.description);
  check(
    "Custom calculator snapshot starts with saved rates and empty job quantities",
    customFresh?.calculatorId === CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID &&
      customFresh?.rates.openingRate === 45 &&
      customFresh?.inputs.openingCount === 0 &&
      customFresh?.inputs.areaSqFt === 0 &&
      Array.isArray(customFresh?.components) &&
      customFresh.components.length === SYNTHETIC_CUSTOM_TEMPLATE.components.length,
  );
  const customApplied = await applyDraftEstimateCalculator(prisma, persistOwner, {
    estimateId: customEstimate.id,
    lineItemId: customLine.id,
    inputs: { openingCount: 3, areaSqFt: 10, travelAllowance: 50 },
    rates: { openingRate: 45, areaRate: 2.5, defaultTravelAllowance: 50 },
  });
  check(
    "Engine-applied synthetic custom calculator prices the line without a new React calculator",
    customApplied.unitPrice.toString() === "210",
  );
  const customSaved = await saveDraftEstimateLineAsCatalog(prisma, persistOwner, {
    estimateId: customEstimate.id,
    lineItemId: customLine.id,
    savePrice: false,
  });
  const customDefinition = catalogCalculatorDefinition(customSaved.description);
  check(
    "Save for reuse keeps custom calculator type, rates, and definition without job quantities",
    customDefinition?.calculatorId === CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID &&
      customDefinition?.rates.openingRate === 45 &&
      customDefinition?.components?.length === SYNTHETIC_CUSTOM_TEMPLATE.components.length &&
      definitionOmitsJobQuantities(customDefinition) &&
      !JSON.stringify(customDefinition.rates).includes("openingCount") &&
      catalogScopeText(customSaved.description) === "Cut and finish openings",
  );
  const reusedCustomEstimate = await prisma.estimate.create({
    data: {
      businessId: persistBusiness.id,
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  const reusedCustom = await addCatalogItemToDraftEstimate(prisma, persistOwner, {
    estimateId: reusedCustomEstimate.id,
    catalogItemId: customSaved.id,
    quantity: new Prisma.Decimal(1),
  });
  const reusedSnapshot = lineCalculatorSnapshot(reusedCustom.description);
  check(
    "A future custom estimate starts from saved rates with fresh quantities",
    reusedSnapshot?.calculatorId === CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID &&
      reusedSnapshot?.rates.openingRate === 45 &&
      reusedSnapshot?.inputs.openingCount === 0 &&
      reusedSnapshot?.inputs.areaSqFt === 0 &&
      reusedSnapshot?.components?.length === SYNTHETIC_CUSTOM_TEMPLATE.components.length &&
      reusedCustom.unitPrice.toString() === "0",
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

/**
 * Trade-aware formula contract v1.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-formula-contract.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  DECORATIVE_WALL_PANELING_CALCULATOR_ID,
  DECORATIVE_WALL_PANELING_TITLE,
  FORMULA_KINDS,
  HANDYMAN_FORMULA_PROOF_TEMPLATE_KEYS,
  PRODUCTION_UNITS,
  TRADE_FORMULA_CALCULATOR_ID,
  calculatorHasIncompleteBillableWork,
  computeFormula,
  definitionFromFormulaBinding,
  findCatalogCalculatorDefinition,
  formulaBindingForTemplateKey,
  formulaBindingForTitle,
  formulaRateKeys,
  hoursFromProduction,
  normalizeFormulaContract,
  persistableFormulaRates,
  startingCalculatorSnapshot,
} = await import("@/lib/estimate-calculators");
const { hoursFromCalculatorSnapshot } = await import(
  "@/lib/financial-intelligence/estimate-actual"
);
const {
  catalogCalculatorDefinition,
  joinCatalogDescription,
  joinLineDescription,
  lineCalculatorSnapshot,
} = await import("@/lib/estimate-line-scope");
const { buildEstimateLineCreatesFromRequestItems } = await import(
  "@/lib/request-estimate-draft"
);
const { formatCatalogPriceLabel, publicCatalogUnitAmount } = await import("@/lib/pricing-mode");
const { createEstimateVersionSnapshot } = await import("@/lib/estimate-version");
const {
  applyDraftEstimateCalculator,
  persistDraftEstimateCalculatorRates,
  EstimateLineError,
} = await import("@/lib/estimate-line-ops");
const { HANDYMAN_STARTER_SERVICES } = await import(
  "@/lib/handyman-starter-catalog"
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

function readRepo(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const unitFormula = normalizeFormulaContract({
  kind: "unit",
  unit: "bag",
  quantityKey: "quantity",
  rateKey: "unitRate",
  productionPerHourKey: "unitsPerHour",
});
const areaFormula = normalizeFormulaContract({
  kind: "area",
  unit: "sf",
});
const linearFormula = normalizeFormulaContract({
  kind: "linear",
  unit: "lf",
});
const countFormula = normalizeFormulaContract({
  kind: "count",
  unit: "each",
});
const minimumFormula = normalizeFormulaContract({
  kind: "minimum_plus_unit",
  unit: "each",
});
const tierFormula = normalizeFormulaContract({
  kind: "tier_table",
  unit: "sf",
  quantityKey: "quantity",
  tiers: [
    { upTo: 100, rateKey: "tierRate1" },
    { upTo: 300, rateKey: "tierRate2" },
    { upTo: null, rateKey: "tierRate3" },
  ],
});
const tierRates = {
  tierRate1: 12,
  tierRate2: 10,
  tierRate3: 8,
};
const basePlusFormula = normalizeFormulaContract({
  kind: "base_plus_components",
  unit: "each",
  baseKey: "baseAmount",
  components: [
    {
      key: "openings",
      name: "Openings",
      quantityKey: "openingCount",
      rateKey: "openingRate",
      unit: "opening",
      productionPerHourKey: "openingsPerHour",
    },
    {
      key: "trim",
      name: "Trim",
      quantityKey: "trimLf",
      rateKey: "trimRate",
      unit: "lf",
      productionPerHourKey: "trimLfPerHour",
    },
  ],
});
const startingFormula = normalizeFormulaContract({
  kind: "starting_range",
  unit: "each",
});
const customFormula = normalizeFormulaContract({
  kind: "custom_quote",
  unit: "each",
});

console.log("\nSTATIC — Formula contract and unit registry");
check(
  "All v1 formula kinds are registered",
  FORMULA_KINDS.join(",") ===
    "unit,area,linear,count,minimum_plus_unit,tier_table,base_plus_components,starting_range,custom_quote",
);
check(
  "Production unit registry is each/sf/lf/room/bag/opening",
  PRODUCTION_UNITS.join(",") === "each,sf,lf,room,bag,opening",
);
check(
  "No per-trade Prisma formula table",
  !readRepo("prisma/schema.prisma").includes("model Formula") &&
    !readRepo("prisma/schema.prisma").includes("formulaKind") &&
    readRepo("prisma/schema.prisma").includes("CALCULATOR_SNAPSHOT_MARKER"),
);

console.log("\nUNIT — Formula compute");
const unitResult = computeFormula(unitFormula, { quantity: 6 }, { unitRate: 18, unitsPerHour: 12 });
check("unit is quantity × rate", unitResult.recommendedAmount === 108 && unitResult.estimatedLaborHours === 0.5);

const areaResult = computeFormula(
  areaFormula,
  { widthFt: 10, heightFt: 8 },
  { unitRate: 4, unitsPerHour: 80 },
);
check(
  "area uses width × height when area is empty",
  areaResult.recommendedAmount === 320 && areaResult.estimatedLaborHours === 1,
);
const areaDirect = computeFormula(areaFormula, { areaSqFt: 50 }, { unitRate: 3 });
check(
  "area prefers an explicit area quantity and does not invent hours",
  areaDirect.recommendedAmount === 150 && areaDirect.estimatedLaborHours == null,
);

const linearResult = computeFormula(
  linearFormula,
  { lengthLf: 25 },
  { unitRate: 8, unitsPerHour: 20 },
);
check(
  "linear is length × rate",
  linearResult.recommendedAmount === 200 && linearResult.estimatedLaborHours === 1.25,
);

const countResult = computeFormula(countFormula, { quantity: 3 }, { unitRate: 75, unitsPerHour: 2 });
check(
  "count is integer quantity × rate",
  countResult.recommendedAmount === 225 && countResult.estimatedLaborHours === 1.5,
);

function breakdownTotal(result) {
  return result.lines.reduce((sum, line) => sum + line.amount, 0);
}

const minimumLow = computeFormula(
  minimumFormula,
  { quantity: 1 },
  { unitRate: 40, minimumAmount: 100, unitsPerHour: 2 },
);
const minimumHigh = computeFormula(
  minimumFormula,
  { quantity: 4 },
  { unitRate: 40, minimumAmount: 100, unitsPerHour: 2 },
);
const minimumZero = computeFormula(
  minimumFormula,
  { quantity: 0 },
  { unitRate: 40, minimumAmount: 100, unitsPerHour: 2 },
);
check("minimum_plus_unit floors at the minimum", minimumLow.recommendedAmount === 100);
check("minimum_plus_unit uses quantity × rate above the minimum", minimumHigh.recommendedAmount === 160);
check(
  "below-minimum breakdown is production + adjustment and sums to recommended",
  minimumLow.lines.find((line) => line.key === "production")?.amount === 40 &&
    minimumLow.lines.find((line) => line.key === "minimum_adjustment")?.amount === 60 &&
    breakdownTotal(minimumLow) === minimumLow.recommendedAmount &&
    breakdownTotal(minimumLow) === 100,
);
check(
  "above-minimum breakdown is production only and sums to recommended",
  minimumHigh.lines.find((line) => line.key === "production")?.amount === 160 &&
    minimumHigh.lines.every((line) => line.key !== "minimum_adjustment") &&
    breakdownTotal(minimumHigh) === minimumHigh.recommendedAmount &&
    breakdownTotal(minimumHigh) === 160,
);
check(
  "zero quantity does not produce a billable recommendation",
  minimumZero.recommendedAmount === 0 &&
    breakdownTotal(minimumZero) === 0 &&
    minimumZero.lines.every((line) => line.key !== "minimum_adjustment"),
);

const persistedTierRates = persistableFormulaRates(tierFormula, tierRates);
check(
  "formulaRateKeys includes deterministic tier rate keys",
  formulaRateKeys(tierFormula).join(",") ===
    "unitsPerHour,tierRate1,tierRate2,tierRate3",
);
check(
  "persistableFormulaRates persists tier rates, not job quantities",
  persistedTierRates.tierRate1 === 12 &&
    persistedTierRates.tierRate2 === 10 &&
    persistedTierRates.tierRate3 === 8 &&
    !Object.hasOwn(persistedTierRates, "quantity"),
);
check(
  "tier_table structure stores rate keys, not dollar rates",
  tierFormula.tiers.every((tier) => typeof tier.rateKey === "string" && !Object.hasOwn(tier, "rate")) &&
    !JSON.stringify(tierFormula).includes('"rate":12') &&
    !JSON.stringify(tierFormula).includes('"rate":10'),
);
const formSource = readRepo("src/components/estimates/formula-calculator-form.tsx");
const breakdownSource = readRepo("src/components/estimates/calculator-breakdown.tsx");
const applySource = readRepo("src/lib/estimate-line-ops.ts");
check(
  "FormulaCalculatorForm exposes tier rates as editable owner rates",
  formSource.includes("tier.rateKey") &&
    formSource.includes("Open-ended tier rate") &&
    !formSource.includes("formatMoney(tier.rate)") &&
    !/tier\.rate[^\w]/.test(formSource),
);
check(
  "Apply still rejects a non-positive recommendation",
  applySource.includes("result.recommendedAmount <= 0") &&
    applySource.includes("calculatorHasIncompleteBillableWork(result)"),
);
check(
  "Apply rejects incomplete billable work before any line mutation",
  applySource.indexOf("calculatorHasIncompleteBillableWork(result)") <
    applySource.indexOf("snapshot.result = result") &&
    applySource.indexOf("calculatorHasIncompleteBillableWork(result)") <
      applySource.indexOf("await db.$transaction"),
);
check(
  "Owner calculator does not present a partial recommendation as the complete labor price",
  breakdownSource.includes("calculatorHasIncompleteBillableWork(breakdown)") &&
    breakdownSource.includes("No recommended labor price yet") &&
    breakdownSource.includes("Recommended labor price:") &&
    formSource.includes("preview.recommendedAmount <= 0") &&
    formSource.includes("calculatorHasIncompleteBillableWork(preview)"),
);

const tierLow = computeFormula(tierFormula, { quantity: 80 }, tierRates);
const tierMid = computeFormula(tierFormula, { quantity: 200 }, tierRates);
const tierHigh = computeFormula(tierFormula, { quantity: 400 }, tierRates);
check("tier_table uses the first matching tier from rates", tierLow.recommendedAmount === 960);
check("tier_table steps to the next tier from rates", tierMid.recommendedAmount === 2000);
check("tier_table uses the open-ended tier from rates", tierHigh.recommendedAmount === 3200);
check("tier_table without production rate does not invent hours", tierLow.estimatedLaborHours == null);

const legacyTier = normalizeFormulaContract({
  kind: "tier_table",
  unit: "sf",
  tiers: [
    { upTo: 100, rate: 12 },
    { upTo: 300, rate: 10 },
    { upTo: null, rate: 8 },
  ],
});
check(
  "legacy inline tier dollars migrate into persistable rates",
  persistableFormulaRates(legacyTier, {}).tierRate1 === 12 &&
    persistableFormulaRates(legacyTier, {}).tierRate3 === 8 &&
    computeFormula(legacyTier, { quantity: 80 }, {}).recommendedAmount === 960,
);

const basePlus = computeFormula(
  basePlusFormula,
  { openingCount: 2, trimLf: 10 },
  { baseAmount: 150, openingRate: 40, trimRate: 8 },
);
check(
  "base_plus_components is base + component totals",
  basePlus.recommendedAmount === 310 && basePlus.estimatedLaborHours == null,
);
const mixedHours = computeFormula(
  basePlusFormula,
  { openingCount: 10, trimLf: 20 },
  {
    baseAmount: 0,
    openingRate: 40,
    trimRate: 8,
    openingsPerHour: 10,
    trimLfPerHour: 20,
  },
);
check(
  "base_plus_components sums independent component hours, never mixed units",
  mixedHours.recommendedAmount === 560 &&
    mixedHours.estimatedLaborHours === 2,
);
const missingComponentRate = computeFormula(
  basePlusFormula,
  { openingCount: 10, trimLf: 20 },
  {
    baseAmount: 0,
    openingRate: 40,
    trimRate: 8,
    openingsPerHour: 10,
  },
);
check(
  "missing component production rate makes hours null",
  missingComponentRate.recommendedAmount === 560 &&
    missingComponentRate.estimatedLaborHours == null,
);
const baseBlocksHours = computeFormula(
  basePlusFormula,
  { openingCount: 10, trimLf: 20 },
  {
    baseAmount: 150,
    openingRate: 40,
    trimRate: 8,
    openingsPerHour: 10,
    trimLfPerHour: 20,
  },
);
check(
  "non-zero unmodeled base charge does not claim complete labor hours",
  baseBlocksHours.recommendedAmount === 710 &&
    baseBlocksHours.estimatedLaborHours == null,
);

const starting = computeFormula(startingFormula, {}, { startingAmount: 125 });
check(
  "starting_range uses the starting amount and invents no hours",
  starting.recommendedAmount === 125 && starting.estimatedLaborHours == null,
);
const custom = computeFormula(customFormula, { quantity: 5 }, { unitRate: 20, unitsPerHour: 2 });
check(
  "custom_quote does not invent a price or hours",
  custom.recommendedAmount === 0 &&
    custom.estimatedLaborHours == null &&
    custom.lines[0]?.amountState === "waiting",
);
const missingRate = computeFormula(unitFormula, { quantity: 6 }, {});
check(
  "missing required rate never becomes a ready $0 price",
  missingRate.recommendedAmount === 0 &&
    missingRate.lines[0]?.amount === 0 &&
    missingRate.lines[0]?.amountState === "waiting",
);
const missingQuantity = computeFormula(unitFormula, {}, { unitRate: 18 });
check(
  "missing required quantity never becomes a ready $0 price",
  missingQuantity.recommendedAmount === 0 &&
    missingQuantity.lines[0]?.amountState === "waiting",
);
const zeroRateWithQuantity = computeFormula(areaFormula, { areaSqFt: 50 }, { unitRate: 0 });
check(
  "explicit zero rate with quantity stays waiting",
  zeroRateWithQuantity.recommendedAmount === 0 &&
    zeroRateWithQuantity.lines[0]?.amountState === "waiting",
);
const missingComponentBillableRate = computeFormula(
  basePlusFormula,
  { openingCount: 2, trimLf: 0 },
  { baseAmount: 150, openingRate: 0, trimRate: 8 },
);
check(
  "missing component rate stays waiting and does not invent $0 ready work",
  missingComponentBillableRate.lines.find((line) => line.key === "openings")
    ?.amountState === "waiting" &&
    missingComponentBillableRate.lines.find((line) => line.key === "openings")
      ?.amount === 0 &&
    missingComponentBillableRate.recommendedAmount === 150,
);
check(
  "partial base_plus_components recommendation is incomplete billable work",
  missingComponentBillableRate.recommendedAmount > 0 &&
    calculatorHasIncompleteBillableWork(missingComponentBillableRate),
);
const onePricedOneWaiting = computeFormula(
  basePlusFormula,
  { openingCount: 2, trimLf: 10 },
  { baseAmount: 0, openingRate: 40, trimRate: 0 },
);
check(
  "priced component plus missing rate stays a positive incomplete recommendation",
  onePricedOneWaiting.recommendedAmount === 80 &&
    onePricedOneWaiting.lines.find((line) => line.key === "openings")?.amountState ===
      "ready" &&
    onePricedOneWaiting.lines.find((line) => line.key === "trim")?.amountState ===
      "waiting" &&
    calculatorHasIncompleteBillableWork(onePricedOneWaiting),
);
const minimumWithoutUnitRate = computeFormula(
  minimumFormula,
  { quantity: 2 },
  { minimumAmount: 100, unitRate: 0 },
);
check(
  "minimum_plus_unit with a missing unit rate is an incomplete positive recommendation",
  minimumWithoutUnitRate.recommendedAmount === 100 &&
    minimumWithoutUnitRate.lines.find((line) => line.key === "production")
      ?.amountState === "waiting" &&
    calculatorHasIncompleteBillableWork(minimumWithoutUnitRate),
);
const unusedZeroQuantity = computeFormula(
  basePlusFormula,
  { openingCount: 2, trimLf: 0 },
  { baseAmount: 150, openingRate: 40, trimRate: 0 },
);
check(
  "zero-quantity unused component does not make a complete formula incomplete",
  unusedZeroQuantity.recommendedAmount === 230 &&
    unusedZeroQuantity.lines.find((line) => line.key === "trim")?.quantity === 0 &&
    !calculatorHasIncompleteBillableWork(unusedZeroQuantity),
);
const missingMinimumInputs = computeFormula(minimumFormula, { quantity: 2 }, {});
check(
  "minimum_plus_unit without rates does not invent a billable minimum",
  missingMinimumInputs.recommendedAmount === 0 &&
    missingMinimumInputs.lines.every((line) => line.amountState !== "ready"),
);
check("hoursFromProduction requires quantity and a positive rate", hoursFromProduction(10, 0) == null);
check(
  "A $0 catalog price is not a public sellable amount",
  publicCatalogUnitAmount("FIXED", 0) == null &&
    publicCatalogUnitAmount("STARTING_AT", 0) == null &&
    publicCatalogUnitAmount("VARIABLE", 0) == null &&
    formatCatalogPriceLabel("FIXED", 0) === "Custom Quote",
);

console.log("\nUNIT — Public catalog never prints / hour");
check(
  "VARIABLE with a production unit stays unit pricing",
  formatCatalogPriceLabel("VARIABLE", 50, "sf") === "$50.00 / sf",
);
check(
  "VARIABLE with hour/hourly unit labels never emit / hour",
  formatCatalogPriceLabel("VARIABLE", 50, "hour") === "From $50.00" &&
    formatCatalogPriceLabel("VARIABLE", 50, "per hour") === "From $50.00" &&
    formatCatalogPriceLabel("VARIABLE", 50, "hr") === "From $50.00" &&
    !formatCatalogPriceLabel("VARIABLE", 50, "hour").includes("/ hour"),
);
const createForm = readRepo("src/components/catalog/create-catalog-item-form.tsx");
const editForm = readRepo("src/components/catalog/catalog-item-row.tsx");
check(
  "Catalog VARIABLE UI no longer suggests per hour",
  !createForm.includes("per hour") &&
    !editForm.includes("per hour") &&
    createForm.includes("each, sf, lf, room, bag, opening") &&
    createForm.includes("Unit / production") &&
    editForm.includes("Unit / production"),
);

console.log("\nUNIT — Request → estimate calculator binding");
check(
  "Proof set is paneling + count + linear + minimum_plus_unit",
  HANDYMAN_FORMULA_PROOF_TEMPLATE_KEYS.join(",") ===
    "decorative-wall-paneling-finish-carpentry,standard-door-knob-replacement,weatherstripping-replacement,grab-bar-installation",
);

const panelingService = HANDYMAN_STARTER_SERVICES.find(
  (row) => row.templateKey === "decorative-wall-paneling-finish-carpentry",
);
const doorKnob = HANDYMAN_STARTER_SERVICES.find(
  (row) => row.templateKey === "standard-door-knob-replacement",
);
const weatherstripping = HANDYMAN_STARTER_SERVICES.find(
  (row) => row.templateKey === "weatherstripping-replacement",
);
const grabBar = HANDYMAN_STARTER_SERVICES.find(
  (row) => row.templateKey === "grab-bar-installation",
);

const panelingLines = buildEstimateLineCreatesFromRequestItems("biz-a", [
  {
    quantity: 1,
    serviceCatalogItem: {
      id: "svc-paneling",
      name: panelingService.name,
      pricingMode: "CUSTOM_QUOTE",
      price: null,
      description: panelingService.description,
    },
  },
]);
const panelingSnapshot = lineCalculatorSnapshot(panelingLines[0].description);
check(
  "Existing paneling request binds the specialized calculator from title/registry",
  panelingService.name === DECORATIVE_WALL_PANELING_TITLE &&
    !panelingService.description.includes("TBBT Calculator Definition") &&
    panelingSnapshot?.calculatorId === DECORATIVE_WALL_PANELING_CALCULATOR_ID &&
    panelingSnapshot?.inputs.wallWidthFt === 0 &&
    panelingSnapshot?.rates.panelRate === 90 &&
    (panelingSnapshot?.estimatedLaborHours == null || panelingSnapshot.estimatedLaborHours === 0),
);

const knobLines = buildEstimateLineCreatesFromRequestItems("biz-a", [
  {
    quantity: 1,
    serviceCatalogItem: {
      id: "svc-knob",
      name: doorKnob.name,
      pricingMode: "STARTING_AT",
      price: doorKnob.startingPrice,
      description: doorKnob.description,
    },
  },
]);
const knobSnapshot = lineCalculatorSnapshot(knobLines[0].description);
check(
  "Count-based Handyman proof binds trade-formula without an embedded catalog definition",
  knobSnapshot?.calculatorId === TRADE_FORMULA_CALCULATOR_ID &&
    knobSnapshot?.formula?.kind === "count" &&
    knobSnapshot?.rates.unitRate === 75 &&
    knobSnapshot?.inputs.quantity === 0 &&
    knobLines[0].quantity === 1 &&
    knobLines[0].unitPrice === 75,
);

const linearLines = buildEstimateLineCreatesFromRequestItems("biz-a", [
  {
    quantity: 1,
    serviceCatalogItem: {
      id: "svc-weather",
      name: weatherstripping.name,
      pricingMode: "STARTING_AT",
      price: weatherstripping.startingPrice,
      description: weatherstripping.description,
    },
  },
]);
check(
  "Linear proof binds a linear formula",
  lineCalculatorSnapshot(linearLines[0].description)?.formula?.kind === "linear" &&
    lineCalculatorSnapshot(linearLines[0].description)?.formula?.unit === "lf",
);

const grabLines = buildEstimateLineCreatesFromRequestItems("biz-a", [
  {
    quantity: 1,
    serviceCatalogItem: {
      id: "svc-grab",
      name: grabBar.name,
      pricingMode: "STARTING_AT",
      price: grabBar.startingPrice,
      description: grabBar.description,
    },
  },
]);
check(
  "Minimum-plus-unit proof binds grab bar",
  lineCalculatorSnapshot(grabLines[0].description)?.formula?.kind === "minimum_plus_unit" &&
    formulaBindingForTitle(grabBar.name)?.templateKey === "grab-bar-installation",
);

const unrelated = buildEstimateLineCreatesFromRequestItems("biz-a", [
  {
    quantity: 1,
    serviceCatalogItem: {
      id: "svc-fan",
      name: "Ceiling Fan Replacement",
      pricingMode: "STARTING_AT",
      price: 150,
      description: "Replace a fan.",
    },
  },
]);
check(
  "Unmapped Handyman services are not force-converted to a formula engine",
  lineCalculatorSnapshot(unrelated[0].description) == null &&
    formulaBindingForTitle("Ceiling Fan Replacement") == null,
);

const encodedDefinition = definitionFromFormulaBinding(
  formulaBindingForTemplateKey("standard-door-knob-replacement"),
);
check(
  "Catalog definition describes formula structure, not job quantities",
  encodedDefinition.formula?.kind === "count" &&
    encodedDefinition.rates.unitRate === 75 &&
    !JSON.stringify(encodedDefinition).includes('"quantity":1'),
);

const startFromDefinition = startingCalculatorSnapshot({
  title: doorKnob.name,
  definition: {
    ...encodedDefinition,
    rates: { unitRate: 80, unitsPerHour: 2 },
  },
});
check(
  "Fresh snapshots reset job quantities and keep reusable rates",
  startFromDefinition?.inputs.quantity === 0 &&
    startFromDefinition?.rates.unitRate === 80 &&
    startFromDefinition?.formula?.kind === "count",
);

const ownerEditedDefinition = {
  ...encodedDefinition,
  rates: { unitRate: 91, unitsPerHour: 3 },
};
const ownerCatalogDescription = joinCatalogDescription(
  "Owner-reviewed knob replacement.",
  ownerEditedDefinition,
);
const ownerFound = findCatalogCalculatorDefinition(
  [
    {
      id: "svc-owner-knob",
      name: doorKnob.name,
      description: ownerCatalogDescription,
    },
  ],
  { catalogItemId: "svc-owner-knob", title: doorKnob.name },
);
check(
  "Saved catalog definition with owner-edited rates wins over factory/title default",
  ownerFound?.rates.unitRate === 91 &&
    ownerFound?.rates.unitsPerHour === 3 &&
    formulaBindingForTitle(doorKnob.name)?.defaultRates.unitRate === 75,
);
check(
  "findCatalogCalculatorDefinition does not manufacture registry defaults",
  findCatalogCalculatorDefinition(
    [
      {
        id: "svc-plain-knob",
        name: doorKnob.name,
        description: "Replace a standard door knob.",
      },
    ],
    { catalogItemId: "svc-plain-knob", title: doorKnob.name },
  ) == null,
);
const ownerLines = buildEstimateLineCreatesFromRequestItems("biz-a", [
  {
    quantity: 1,
    serviceCatalogItem: {
      id: "svc-owner-knob",
      name: doorKnob.name,
      pricingMode: "STARTING_AT",
      price: 75,
      description: ownerCatalogDescription,
    },
  },
]);
check(
  "Request draft prefers encoded owner rates over title factory default",
  lineCalculatorSnapshot(ownerLines[0].description)?.rates.unitRate === 91 &&
    lineCalculatorSnapshot(ownerLines[0].description)?.rates.unitsPerHour === 3,
);

console.log("\nUNIT — Hours snapshot vs LABOR quantity");
const appliedHours = computeFormula(
  countFormula,
  { quantity: 4 },
  { unitRate: 75, unitsPerHour: 2 },
);
const hoursSnapshot = {
  calculatorId: TRADE_FORMULA_CALCULATOR_ID,
  inputs: { quantity: 4 },
  rates: { unitRate: 75, unitsPerHour: 2 },
  formula: countFormula,
  estimatedLaborHours: appliedHours.estimatedLaborHours,
  result: appliedHours,
};
check(
  "Trustworthy production-rate hours live on the snapshot, not LABOR quantity",
  hoursFromCalculatorSnapshot(hoursSnapshot) === 2 &&
    hoursSnapshot.estimatedLaborHours === 2,
);
check(
  "Paneling without a production rate does not invent hours",
  hoursFromCalculatorSnapshot({
    calculatorId: DECORATIVE_WALL_PANELING_CALCULATOR_ID,
    inputs: { wallWidthFt: 24, wallHeightFt: 12 },
    rates: {},
  }) == null,
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run formula-contract persistence checks.");
  process.exit(1);
}

const testDbName = "tbbt_formula_contract_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for formula-contract test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

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

try {
  console.log("\nTEST — Defaults persist, quantities reset, versions stay immutable");
  const ownerUser = await prisma.user.create({
    data: {
      name: "Formula Owner",
      email: `formula-${randomUUID()}@example.com`,
      passwordHash: "x",
    },
  });
  const business = await prisma.business.create({
    data: { name: "Formula Biz", slug: `formula-${randomUUID().slice(0, 8)}` },
  });
  const membership = await prisma.membership.create({
    data: { businessId: business.id, userId: ownerUser.id, role: "OWNER" },
  });
  const owner = makeAccess(business.id, "OWNER", membership.id);

  const catalog = await prisma.serviceCatalogItem.create({
    data: {
      businessId: business.id,
      tradeCode: "HANDYMAN",
      name: doorKnob.name,
      description: doorKnob.description,
      pricingMode: "STARTING_AT",
      price: new Prisma.Decimal(75),
      category: "Doors & Locks",
      active: true,
    },
  });
  const catalogPriceBefore = catalog.price.toString();

  const estimate = await prisma.estimate.create({
    data: {
      businessId: business.id,
      total: new Prisma.Decimal(75),
      publicToken: randomUUID(),
    },
  });
  const draftLine = await prisma.lineItem.create({
    data: {
      businessId: business.id,
      estimateId: estimate.id,
      serviceCatalogItemId: catalog.id,
      description: knobLines[0].description,
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(75),
      total: new Prisma.Decimal(75),
      type: "LABOR",
    },
  });

  const applied = await applyDraftEstimateCalculator(prisma, owner, {
    estimateId: estimate.id,
    lineItemId: draftLine.id,
    inputs: { quantity: 3 },
    rates: { unitRate: 80, unitsPerHour: 2 },
  });
  const appliedSnapshot = lineCalculatorSnapshot(applied.description);
  check(
    "Applied formula writes recommended labor on the line and hours on the snapshot",
    applied.unitPrice.toString() === "240" &&
      applied.quantity.toString() === "1" &&
      appliedSnapshot?.recommendedAmount === 240 &&
      appliedSnapshot?.estimatedLaborHours === 1.5 &&
      appliedSnapshot?.inputs.quantity === 3,
  );
  check(
    "LABOR quantity is not treated as hours after apply",
    applied.quantity.toString() === "1" &&
      appliedSnapshot?.estimatedLaborHours !== Number(applied.quantity.toString()),
  );

  await persistDraftEstimateCalculatorRates(prisma, owner, {
    estimateId: estimate.id,
    lineItemId: draftLine.id,
    rates: { unitRate: 80, unitsPerHour: 2 },
    inputs: { quantity: 3 },
  });
  const catalogAfterRates = await prisma.serviceCatalogItem.findFirst({
    where: { id: catalog.id },
  });
  const persistedDefinition = catalogCalculatorDefinition(catalogAfterRates.description);
  check(
    "Business rates persist without job quantities",
    persistedDefinition?.formula?.kind === "count" &&
      persistedDefinition?.rates.unitRate === 80 &&
      !JSON.stringify(persistedDefinition ?? {}).includes('"quantity":3'),
  );
  check(
    "Persisting calculator rates does not autonomously rewrite the catalog price",
    catalogAfterRates.price.toString() === catalogPriceBefore &&
      catalogAfterRates.pricingMode === "STARTING_AT",
  );

  const sent = await prisma.$transaction(async (tx) => {
    await tx.estimate.updateMany({
      where: { id: estimate.id, businessId: business.id, status: "DRAFT" },
      data: { status: "SENT" },
    });
    return createEstimateVersionSnapshot(tx, {
      estimateId: estimate.id,
      businessId: business.id,
    });
  });
  const versionLine = await prisma.estimateVersionLineItem.findFirst({
    where: { estimateVersionId: sent.id },
  });
  const versionSnapshot = lineCalculatorSnapshot(versionLine.description);

  await prisma.serviceCatalogItem.update({
    where: { id: catalog.id },
    data: {
      price: new Prisma.Decimal(999),
      description: `${catalogAfterRates.description}\nOwner later edited the catalog.`,
    },
  });

  const versionAfterCatalogEdit = await prisma.estimateVersionLineItem.findFirst({
    where: { id: versionLine.id },
  });
  check(
    "Estimate version snapshot remains immutable after later catalog edits",
    versionAfterCatalogEdit.description === versionLine.description &&
      versionAfterCatalogEdit.unitPrice.toString() === "240" &&
      versionAfterCatalogEdit.quantity.toString() === "1" &&
      versionSnapshot?.recommendedAmount === 240 &&
      versionSnapshot?.estimatedLaborHours === 1.5 &&
      versionSnapshot?.inputs.quantity === 3,
  );

  let sentRecalcBlocked = false;
  try {
    await applyDraftEstimateCalculator(prisma, owner, {
      estimateId: estimate.id,
      lineItemId: draftLine.id,
      inputs: { quantity: 9 },
      rates: { unitRate: 80, unitsPerHour: 2 },
    });
  } catch (error) {
    sentRecalcBlocked = error instanceof EstimateLineError;
  }
  check("SENT estimate cannot recalculate a formula snapshot", sentRecalcBlocked);

  let missingInputApplyBlocked = false;
  const waitingEstimate = await prisma.estimate.create({
    data: {
      businessId: business.id,
      total: new Prisma.Decimal(75),
      publicToken: randomUUID(),
    },
  });
  const waitingLine = await prisma.lineItem.create({
    data: {
      businessId: business.id,
      estimateId: waitingEstimate.id,
      serviceCatalogItemId: catalog.id,
      description: knobLines[0].description,
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(75),
      total: new Prisma.Decimal(75),
      type: "LABOR",
    },
  });
  try {
    await applyDraftEstimateCalculator(prisma, owner, {
      estimateId: waitingEstimate.id,
      lineItemId: waitingLine.id,
      inputs: { quantity: 3 },
      rates: {},
    });
  } catch (error) {
    missingInputApplyBlocked = error instanceof EstimateLineError;
  }
  const waitingAfter = await prisma.lineItem.findFirst({ where: { id: waitingLine.id } });
  check(
    "Apply rejects a formula with quantity but no required rate and leaves the stored line unchanged",
    missingInputApplyBlocked &&
      waitingAfter.unitPrice.toString() === "75" &&
      waitingAfter.total.toString() === "75",
  );

  const nextEstimate = await prisma.estimate.create({
    data: {
      businessId: business.id,
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  const nextLines = buildEstimateLineCreatesFromRequestItems(business.id, [
    {
      quantity: 1,
      serviceCatalogItem: {
        id: catalog.id,
        name: catalog.name,
        pricingMode: "STARTING_AT",
        price: 75,
        description: catalogAfterRates.description,
      },
    },
  ]);
  const nextLine = await prisma.lineItem.create({
    data: {
      businessId: business.id,
      estimateId: nextEstimate.id,
      serviceCatalogItemId: catalog.id,
      description: nextLines[0].description,
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(75),
      total: new Prisma.Decimal(75),
      type: "LABOR",
    },
  });
  const nextSnapshot = lineCalculatorSnapshot(nextLine.description);
  check(
    "Next job starts with persisted rates and reset quantities",
    nextSnapshot?.rates.unitRate === 80 &&
      nextSnapshot?.inputs.quantity === 0 &&
      nextSnapshot?.appliedAmount == null,
  );

  const tierCatalog = await prisma.serviceCatalogItem.create({
    data: {
      businessId: business.id,
      tradeCode: "HANDYMAN",
      name: "Tiered Patching",
      description: "Tiered patching.",
      pricingMode: "VARIABLE",
      price: new Prisma.Decimal(12),
      category: "Drywall",
      active: true,
    },
  });
  const tierEstimate = await prisma.estimate.create({
    data: {
      businessId: business.id,
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  const tierStart = startingCalculatorSnapshot({
    title: "Tiered Patching",
    definition: {
      calculatorId: TRADE_FORMULA_CALCULATOR_ID,
      formula: tierFormula,
      rates: tierRates,
    },
  });
  const tierLine = await prisma.lineItem.create({
    data: {
      businessId: business.id,
      estimateId: tierEstimate.id,
      serviceCatalogItemId: tierCatalog.id,
      description: joinLineDescription("Tiered Patching", null, tierStart),
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(0),
      total: new Prisma.Decimal(0),
      type: "LABOR",
    },
  });
  const appliedTier = await applyDraftEstimateCalculator(prisma, owner, {
    estimateId: tierEstimate.id,
    lineItemId: tierLine.id,
    inputs: { quantity: 80 },
    rates: { ...tierRates, unitsPerHour: 40, tierRate1: 14 },
  });
  const appliedTierSnapshot = lineCalculatorSnapshot(appliedTier.description);
  check(
    "Estimate snapshot freezes the tier rates actually used",
    appliedTierSnapshot?.rates.tierRate1 === 14 &&
      appliedTierSnapshot?.rates.tierRate2 === 10 &&
      appliedTierSnapshot?.inputs.quantity === 80 &&
      appliedTier.unitPrice.toString() === "1120" &&
      appliedTier.quantity.toString() === "1",
  );

  await persistDraftEstimateCalculatorRates(prisma, owner, {
    estimateId: tierEstimate.id,
    lineItemId: tierLine.id,
    rates: { ...tierRates, unitsPerHour: 40, tierRate1: 14 },
    inputs: { quantity: 80 },
  });
  const persistedTierCatalog = await prisma.serviceCatalogItem.findFirst({
    where: { id: tierCatalog.id },
  });
  const persistedTierDefinition = catalogCalculatorDefinition(
    persistedTierCatalog.description,
  );
  check(
    "Saved tier rates persist through the calculator-rate path without job quantities",
    persistedTierDefinition?.formula?.kind === "tier_table" &&
      persistedTierDefinition?.formula?.tiers?.[0]?.rateKey === "tierRate1" &&
      !Object.hasOwn(persistedTierDefinition?.formula?.tiers?.[0] ?? {}, "rate") &&
      persistedTierDefinition?.rates.tierRate1 === 14 &&
      persistedTierDefinition?.rates.tierRate2 === 10 &&
      !JSON.stringify(persistedTierDefinition ?? {}).includes('"quantity":80') &&
      persistedTierCatalog.price.toString() === "12",
  );

  console.log("\nTEST — Apply rejects incomplete multi-component recommendations");

  async function createFormulaLine(name, formula, rates, unitPrice = 40) {
    const item = await prisma.serviceCatalogItem.create({
      data: {
        businessId: business.id,
        tradeCode: "HANDYMAN",
        name,
        description: name,
        pricingMode: "VARIABLE",
        price: new Prisma.Decimal(unitPrice),
        category: "Proofs",
        active: true,
      },
    });
    const draft = await prisma.estimate.create({
      data: {
        businessId: business.id,
        total: new Prisma.Decimal(unitPrice),
        publicToken: randomUUID(),
      },
    });
    const start = startingCalculatorSnapshot({
      title: name,
      definition: {
        calculatorId: TRADE_FORMULA_CALCULATOR_ID,
        formula,
        rates,
      },
    });
    const line = await prisma.lineItem.create({
      data: {
        businessId: business.id,
        estimateId: draft.id,
        serviceCatalogItemId: item.id,
        description: joinLineDescription(name, null, start),
        quantity: new Prisma.Decimal(1),
        unitPrice: new Prisma.Decimal(unitPrice),
        total: new Prisma.Decimal(unitPrice),
        type: "LABOR",
      },
    });
    return { estimate: draft, line, description: line.description };
  }

  async function applyRejected(estimateId, lineItemId, inputs, rates) {
    try {
      await applyDraftEstimateCalculator(prisma, owner, {
        estimateId,
        lineItemId,
        inputs,
        rates,
      });
      return false;
    } catch (error) {
      return error instanceof EstimateLineError;
    }
  }

  const partialBase = await createFormulaLine(
    "Partial Base Plus Openings",
    basePlusFormula,
    { baseAmount: 150, openingRate: 0, trimRate: 8 },
    40,
  );
  const partialBaseBefore = await prisma.lineItem.findFirst({
    where: { id: partialBase.line.id },
  });
  const partialBaseBlocked = await applyRejected(
    partialBase.estimate.id,
    partialBase.line.id,
    { openingCount: 2, trimLf: 0 },
    { baseAmount: 150, openingRate: 0, trimRate: 8 },
  );
  const partialBaseAfter = await prisma.lineItem.findFirst({
    where: { id: partialBase.line.id },
  });
  check(
    "Apply rejects base + positive-quantity component with a missing rate even when the partial total is $150",
    missingComponentBillableRate.recommendedAmount === 150 &&
      calculatorHasIncompleteBillableWork(missingComponentBillableRate) &&
      partialBaseBlocked &&
      partialBaseAfter.unitPrice.toString() === partialBaseBefore.unitPrice.toString() &&
      partialBaseAfter.total.toString() === partialBaseBefore.total.toString() &&
      partialBaseAfter.description === partialBaseBefore.description,
  );

  const partialMixed = await createFormulaLine(
    "Partial Mixed Components",
    basePlusFormula,
    { baseAmount: 0, openingRate: 40, trimRate: 0 },
    40,
  );
  const partialMixedBefore = await prisma.lineItem.findFirst({
    where: { id: partialMixed.line.id },
  });
  const partialMixedBlocked = await applyRejected(
    partialMixed.estimate.id,
    partialMixed.line.id,
    { openingCount: 2, trimLf: 10 },
    { baseAmount: 0, openingRate: 40, trimRate: 0 },
  );
  const partialMixedAfter = await prisma.lineItem.findFirst({
    where: { id: partialMixed.line.id },
  });
  check(
    "Apply rejects a priced component plus a waiting positive-quantity component",
    onePricedOneWaiting.recommendedAmount === 80 &&
      calculatorHasIncompleteBillableWork(onePricedOneWaiting) &&
      partialMixedBlocked &&
      partialMixedAfter.unitPrice.toString() === "40" &&
      partialMixedAfter.total.toString() === "40" &&
      partialMixedAfter.description === partialMixedBefore.description,
  );

  const partialMinimum = await createFormulaLine(
    "Partial Minimum Plus Unit",
    minimumFormula,
    { minimumAmount: 100, unitRate: 0 },
    40,
  );
  const partialMinimumBefore = await prisma.lineItem.findFirst({
    where: { id: partialMinimum.line.id },
  });
  const partialMinimumBlocked = await applyRejected(
    partialMinimum.estimate.id,
    partialMinimum.line.id,
    { quantity: 2 },
    { minimumAmount: 100, unitRate: 0 },
  );
  const partialMinimumAfter = await prisma.lineItem.findFirst({
    where: { id: partialMinimum.line.id },
  });
  check(
    "Apply rejects minimum_plus_unit when quantity is priced by the minimum but the unit rate is missing",
    minimumWithoutUnitRate.recommendedAmount === 100 &&
      calculatorHasIncompleteBillableWork(minimumWithoutUnitRate) &&
      partialMinimumBlocked &&
      partialMinimumAfter.unitPrice.toString() === partialMinimumBefore.unitPrice.toString() &&
      partialMinimumAfter.total.toString() === partialMinimumBefore.total.toString() &&
      partialMinimumAfter.description === partialMinimumBefore.description,
  );

  const unusedComponent = await createFormulaLine(
    "Complete With Unused Component",
    basePlusFormula,
    { baseAmount: 150, openingRate: 40, trimRate: 0 },
    40,
  );
  const unusedApplied = await applyDraftEstimateCalculator(prisma, owner, {
    estimateId: unusedComponent.estimate.id,
    lineItemId: unusedComponent.line.id,
    inputs: { openingCount: 2, trimLf: 0 },
    rates: { baseAmount: 150, openingRate: 40, trimRate: 0 },
  });
  check(
    "Zero-quantity unused component does not block a complete valid formula",
    unusedZeroQuantity.recommendedAmount === 230 &&
      !calculatorHasIncompleteBillableWork(unusedZeroQuantity) &&
      unusedApplied.unitPrice.toString() === "230" &&
      unusedApplied.total.toString() === "230",
  );

  const completeMixed = await createFormulaLine(
    "Complete Multi Component",
    basePlusFormula,
    { baseAmount: 150, openingRate: 40, trimRate: 8 },
    40,
  );
  const completeApplied = await applyDraftEstimateCalculator(prisma, owner, {
    estimateId: completeMixed.estimate.id,
    lineItemId: completeMixed.line.id,
    inputs: { openingCount: 2, trimLf: 10 },
    rates: { baseAmount: 150, openingRate: 40, trimRate: 8 },
  });
  check(
    "Fully priced multi-component formula still applies normally",
    basePlus.recommendedAmount === 310 &&
      !calculatorHasIncompleteBillableWork(basePlus) &&
      completeApplied.unitPrice.toString() === "310" &&
      completeApplied.total.toString() === "310",
  );
} finally {
  await prisma.$disconnect();
}

if (failures) {
  console.error(`\n${failures} formula-contract check(s) failed.`);
  process.exit(1);
}
console.log("\nAll formula-contract checks passed.");

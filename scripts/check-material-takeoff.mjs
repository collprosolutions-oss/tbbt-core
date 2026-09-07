/**
 * Material takeoff engine: concrete / sheet / framed-wall formulas,
 * owner overrides, MATERIAL conversion without duplicates, and no
 * customer-surface leakage. No Prisma takeoff column.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-material-takeoff.mjs
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
  MATERIAL_TAKEOFF_MARKER,
  MATERIAL_TAKEOFF_SOURCE_MARKER,
  joinLineDescription,
  lineCalculatorSnapshot,
  lineItemIncludedWork,
  lineItemTitle,
  lineMaterialTakeoff,
  lineMaterialTakeoffSource,
  splitLineDescription,
} = await import("@/lib/estimate-line-scope");
const {
  DECORATIVE_WALL_PANELING_TITLE,
  DEFAULT_DECORATIVE_WALL_PANELING_RATES,
  FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE,
} = await import("@/lib/estimate-calculators");
const {
  applyDraftEstimateCalculator,
  EstimateLineError,
} = await import("@/lib/estimate-line-ops");
const {
  CONCRETE_BAG_YIELDS_CU_FT,
  DEFAULT_CONCRETE_BAG_SIZE_LB,
  DEFAULT_CONCRETE_BAG_YIELD_CU_FT,
  DEFAULT_CONCRETE_WASTE_PERCENT,
  addCustomTakeoffItem,
  applyMaterialMarkup,
  applyTakeoffItemEdits,
  computeTakeoff,
  concreteBagsRequired,
  concreteVolumeCuFt,
  convertDraftMaterialTakeoff,
  convertLinearToFeet,
  emptyConcreteSlabInputs,
  emptyFramedWallInputs,
  emptySheetCoveringInputs,
  extendedCustomerPrice,
  extendedMaterialCost,
  feetAndInchesToFeet,
  formatFeetInches,
  framedWallPlateBoards,
  framedWallStudCount,
  isIncompleteNumericDraft,
  isRejectedLinearUnit,
  markedUpCustomerUnitPrice,
  normalizeTakeoffSnapshot,
  parseConstructionNumber,
  parseNonNegativeNumber,
  parseTakeoffNumericInput,
  recalculateDraftMaterialTakeoff,
  saveDraftMaterialTakeoff,
  sheetCountRequired,
  splitFeetAndInches,
  suggestTakeoffInputs,
} = await import("@/lib/material-takeoff");
const { estimateDocumentPlainText, loadEstimateDocumentForBusiness } = await import(
  "@/lib/estimate-document"
);
const { CUSTOMER_REPORTED_MEASUREMENT } = await import("@/lib/catalog-intake");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_material_takeoff_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for material-takeoff test database.");
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

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

try {
  console.log("\nSTATIC — Takeoff storage, owner UI, customer hiding");
  check("OWNER can manage estimates", roleHasCapability("OWNER", CAPABILITIES.MANAGE_ESTIMATES));
  check("MEMBER cannot manage estimates", !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_ESTIMATES));

  const schema = readRepo("prisma/schema.prisma");
  check(
    "No Prisma material-takeoff column — reuse description encoding",
    !/\n\s+materialTakeoff\s+/.test(schema) &&
      !schema.includes("takeoffSnapshot") &&
      schema.includes("MATERIAL_TAKEOFF_MARKER") &&
      schema.includes("CALCULATOR_SNAPSHOT_MARKER"),
  );

  const customerPage = readRepo("src/app/e/[token]/page.tsx");
  const printPage = readRepo("src/app/(invoice-document)/e/[token]/print/page.tsx");
  const portalPage = readRepo("src/app/p/[token]/page.tsx");
  const ownerPage = readRepo("src/app/(app)/estimates/[estimateId]/page.tsx");
  const takeoffForm = readRepo("src/components/estimates/material-takeoff-form.tsx");
  const estimateDocument = readRepo("src/lib/estimate-document.ts");

  check(
    "Customer estimate, print, and portal do not mount takeoff UI",
      !customerPage.includes("MaterialTakeoffForm") &&
      !customerPage.includes("TBBT Material Takeoff") &&
      !customerPage.includes("Material Markup") &&
      !customerPage.includes("markupPercent") &&
      customerPage.includes("lineItemTitle") &&
      !printPage.includes("MaterialTakeoffForm") &&
      !printPage.includes("Material Markup") &&
      !portalPage.includes("MaterialTakeoffForm") &&
      !portalPage.includes("Material Markup") &&
      portalPage.includes("ApprovedScopeCard"),
  );
  check(
    "Owner draft page mounts takeoff and keeps mutations in server actions",
    ownerPage.includes("MaterialTakeoffForm") &&
      ownerPage.includes("lineMaterialTakeoff") &&
      !ownerPage.includes("saveDraftMaterialTakeoff") &&
      takeoffForm.includes("saveEstimateMaterialTakeoff") &&
      takeoffForm.includes("convertEstimateMaterialTakeoff") &&
      takeoffForm.includes("Calculate from measurements") &&
      takeoffForm.includes("Unit cost (internal)") &&
      takeoffForm.includes("Customer unit price") &&
      takeoffForm.includes("Internal extended") &&
      takeoffForm.includes("Customer extended") &&
      takeoffForm.includes("Feet") &&
      takeoffForm.includes("Inches") &&
      takeoffForm.includes("TakeoffDecimalField") &&
      takeoffForm.includes("isIncompleteNumericDraft") &&
      takeoffForm.includes("parseTakeoffNumericInput") &&
      takeoffForm.includes("Material Markup %") &&
      takeoffForm.includes("Apply markup to selected items") &&
      takeoffForm.includes("applyMaterialMarkup") &&
      !takeoffForm.includes("Number(event.target.value) || 0") &&
      !takeoffForm.includes('type="number"'),
  );
  check(
    "Estimate document uses split title/scope, not raw description",
    estimateDocument.includes("parts.title") &&
      estimateDocument.includes("splitLineDescription"),
  );

  console.log("\nUNIT — Concrete volume, 60-lb bags, waste, thickness");
  const slab = emptyConcreteSlabInputs({
    lengthFt: 10,
    widthFt: 10,
    thicknessIn: 4,
    bagSizeLb: DEFAULT_CONCRETE_BAG_SIZE_LB,
    bagYieldCuFt: DEFAULT_CONCRETE_BAG_YIELD_CU_FT,
  });
  const volume = concreteVolumeCuFt(slab);
  check("10×10×4 in slab volume is 33.3333 cu ft", volume === 33.3333);
  check(
    "60-lb yield assumption is 0.45 cu ft and is configurable",
    CONCRETE_BAG_YIELDS_CU_FT[60] === 0.45 &&
      DEFAULT_CONCRETE_BAG_YIELD_CU_FT === 0.45 &&
      DEFAULT_CONCRETE_BAG_SIZE_LB === 60 &&
      DEFAULT_CONCRETE_WASTE_PERCENT === 10,
  );
  check(
    "60-lb bag count rounds up without waste",
    concreteBagsRequired(volume, 0, 0.45) === 75,
  );
  check(
    "Default 10% waste increases 60-lb bag count",
    concreteBagsRequired(volume, 10, 0.45) === 82,
  );
  const thicker = emptyConcreteSlabInputs({
    ...slab,
    thicknessIn: 6,
  });
  check(
    "Thickness change increases bag quantity",
    concreteBagsRequired(concreteVolumeCuFt(thicker), 10, 0.45) === 123 &&
      concreteBagsRequired(concreteVolumeCuFt(thicker), 10, 0.45) >
        concreteBagsRequired(volume, 10, 0.45),
  );
  check(
    "No hard-coded $36 or $52 takeoff rate in concrete formula",
    !readRepo("src/lib/material-takeoff/formulas/concrete-slab.ts").includes("36") &&
      !readRepo("src/lib/material-takeoff/formulas/concrete-slab.ts").includes("52"),
  );

  console.log("\nUNIT — Construction feet + inches inputs");
  check(
    "4.5, 4 1/2, and 4½ parse as the same construction inch value",
    parseConstructionNumber("4.5") === 4.5 &&
      parseConstructionNumber("4 1/2") === 4.5 &&
      parseConstructionNumber("4½") === 4.5 &&
      parseConstructionNumber("1/2") === 0.5,
  );
  check(
    "3 ft 4 in normalizes to 3.3333 ft",
    feetAndInchesToFeet(3, 4) === 3.3333 &&
      splitFeetAndInches(3.3333).feet === 3 &&
      splitFeetAndInches(3.3333).inches === 4,
  );
  const founderSlab = emptyConcreteSlabInputs({
    lengthFtPart: 8,
    lengthInPart: 0,
    widthFtPart: 3,
    widthInPart: 4,
    thicknessIn: 4,
    bagSizeLb: 60,
    bagYieldCuFt: 0.45,
  });
  const founderVolume = concreteVolumeCuFt(founderSlab);
  check(
    "8 ft × 3 ft 4 in × 4 in slab volume is 8.8888 cu ft",
    founderSlab.lengthFt === 8 &&
      founderSlab.widthFt === 3.3333 &&
      founderSlab.thicknessIn === 4 &&
      founderVolume === 8.8888,
  );
  check(
    "8 ft × 3 ft 4 in × 4 in uses 20 bags without waste and 22 with 10% waste",
    concreteBagsRequired(founderVolume, 0, 0.45) === 20 &&
      concreteBagsRequired(founderVolume, 10, 0.45) === 22,
  );
  const founderComputed = computeTakeoff({
    takeoffType: "concrete-slab",
    inputs: {
      lengthFtPart: 8,
      lengthInPart: 0,
      widthFtPart: 3,
      widthInPart: 4,
      thicknessIn: 4,
      bagSizeLb: 60,
      bagYieldCuFt: 0.45,
    },
    wastePercent: 10,
  }).snapshot;
  check(
    "Founder slab takeoff counts 22 60-lb bags with default waste",
    founderComputed.items.find((item) => item.id === "concrete-bags")?.calculatedQuantity === 22,
  );
  const halfInch = emptyConcreteSlabInputs({
    lengthFtPart: 8,
    lengthInPart: 0,
    widthFtPart: 3,
    widthInPart: "4½",
    thicknessIn: "4.5",
  });
  check(
    "Inches accept 4½ and thickness accepts 4.5",
    halfInch.widthInPart === 4.5 &&
      halfInch.widthFt === feetAndInchesToFeet(3, 4.5) &&
      halfInch.thicknessIn === 4.5,
  );
  const legacySlab = emptyConcreteSlabInputs({
    lengthFt: 10,
    widthFt: 10,
    thicknessIn: 4,
  });
  check(
    "Saved decimal-feet snapshots still calculate and split into feet/inches",
    legacySlab.lengthFt === 10 &&
      legacySlab.widthFt === 10 &&
      concreteVolumeCuFt(legacySlab) === 33.3333 &&
      legacySlab.lengthFtPart === 10 &&
      legacySlab.lengthInPart === 0 &&
      formatFeetInches(10) === "10 ft 0 in",
  );
  const inchPrefill = suggestTakeoffInputs({
    takeoffType: "concrete-slab",
    intakeMeasurement: {
      catalogItemId: "x",
      source: CUSTOMER_REPORTED_MEASUREMENT,
      width: 40,
      height: 12,
      length: 96,
      quantity: null,
      unit: "IN",
    },
  });
  check(
    "Customer-reported 96 in × 40 in prefills 8 ft 0 in × 3 ft 4 in",
    inchPrefill.inputs.lengthFt === 8 &&
      inchPrefill.inputs.lengthFtPart === 8 &&
      inchPrefill.inputs.lengthInPart === 0 &&
      inchPrefill.inputs.widthFt === 3.3333 &&
      inchPrefill.inputs.widthFtPart === 3 &&
      inchPrefill.inputs.widthInPart === 4 &&
      inchPrefill.measurementSource?.unverified === true,
  );

  check(
    "0 ft 40 in is the same width as 3 ft 4 in",
    emptyConcreteSlabInputs({
      lengthFtPart: 8,
      lengthInPart: 0,
      widthFtPart: 0,
      widthInPart: 40,
      thicknessIn: 4,
    }).widthFt === 3.3333,
  );
  check(
    "Sheet covering 10 ft 6 in wall width normalizes without changing sheet math",
    emptySheetCoveringInputs({
      wallWidthFtPart: 10,
      wallWidthInPart: 6,
      wallHeightFtPart: 8,
      wallHeightInPart: 0,
    }).wallWidthFt === 10.5,
  );
  check(
    "Framed-wall 12 ft 0 in still yields 10 layout studs at 16 in OC",
    framedWallStudCount(
      emptyFramedWallInputs({ wallLengthFtPart: 12, wallLengthInPart: 0 }).wallLengthFt,
      16,
    ) === 10,
  );

  console.log("\nUNIT — Decimal takeoff qty, cost, price, and waste");
  check(
    "Incomplete drafts like 6. are not parsed as 6 while typing",
    isIncompleteNumericDraft("6.") === true &&
      isIncompleteNumericDraft(".") === true &&
      isIncompleteNumericDraft("4 1/") === true &&
      parseNonNegativeNumber("6.") == null &&
      parseTakeoffNumericInput("6.").status === "incomplete" &&
      parseTakeoffNumericInput("6.24").status === "ok" &&
      parseTakeoffNumericInput("6.24").value === 6.24,
  );
  check(
    "Owner qty 12.5, internal cost 6.24, customer price 7.95, and waste 7.5 are accepted",
    parseTakeoffNumericInput("12.5").value === 12.5 &&
      parseTakeoffNumericInput("6.24").value === 6.24 &&
      parseTakeoffNumericInput("7.95").value === 7.95 &&
      parseTakeoffNumericInput("7.50").value === 7.5 &&
      parseTakeoffNumericInput("7.5").value === 7.5 &&
      computeTakeoff({
        takeoffType: "concrete-slab",
        inputs: { lengthFt: 10, widthFt: 10, thicknessIn: 4 },
        wastePercent: 7.5,
      }).snapshot.wastePercent === 7.5,
  );
  check(
    "Negative and malformed numeric input is rejected",
    parseTakeoffNumericInput("-1").status === "invalid" &&
      parseTakeoffNumericInput("-6.24").status === "invalid" &&
      parseTakeoffNumericInput("abc").status === "invalid" &&
      parseNonNegativeNumber("-7.5") == null,
  );
  check(
    "Fractional inch input still works: 4.5, 4 1/2, 4½",
    parseConstructionNumber("4.5") === 4.5 &&
      parseConstructionNumber("4 1/2") === 4.5 &&
      parseConstructionNumber("4½") === 4.5 &&
      parseTakeoffNumericInput("4½", "construction").value === 4.5,
  );
  const decimalPriced = applyTakeoffItemEdits(
    computeTakeoff({
      takeoffType: "concrete-slab",
      inputs: {
        lengthFtPart: 8,
        lengthInPart: 0,
        widthFtPart: 3,
        widthInPart: 4,
        thicknessIn: 4,
        bagSizeLb: 60,
        bagYieldCuFt: 0.45,
      },
      wastePercent: 7.5,
    }).snapshot,
    [
      {
        id: "concrete-bags",
        quantityOverride: 12.5,
        unitCost: 6.24,
        customerUnitPrice: 7.95,
        selected: true,
      },
    ],
  );
  const decimalBags = decimalPriced.items.find((item) => item.id === "concrete-bags");
  check(
    "Decimal owner qty and cents calculate independent internal vs customer extended amounts",
    decimalPriced.wastePercent === 7.5 &&
      decimalBags?.quantityOverride === 12.5 &&
      decimalBags?.unitCost === 6.24 &&
      decimalBags?.customerUnitPrice === 7.95 &&
      extendedMaterialCost(decimalBags) === 78 &&
      extendedCustomerPrice(decimalBags) === 99.38,
  );
  const decimalPreserved = computeTakeoff({
    takeoffType: "concrete-slab",
    inputs: {
      lengthFtPart: 8,
      lengthInPart: 0,
      widthFtPart: 3,
      widthInPart: 4,
      thicknessIn: 6,
      bagSizeLb: 60,
      bagYieldCuFt: 0.45,
    },
    wastePercent: 7.5,
    previous: decimalPriced,
  }).snapshot.items.find((item) => item.id === "concrete-bags");
  check(
    "Recalculation preserves decimal owner qty, internal cost, and customer selling price",
    decimalPreserved?.quantityOverride === 12.5 &&
      decimalPreserved?.unitCost === 6.24 &&
      decimalPreserved?.customerUnitPrice === 7.95 &&
      decimalPreserved?.calculatedQuantity !== 12.5,
  );
  const customDecimal = addCustomTakeoffItem(decimalPriced, {
    label: "Trip allowance",
    unit: "trips",
    quantity: 1.5,
    unitCost: 28.75,
    customerUnitPrice: 37.5,
  }).items.find((item) => item.label === "Trip allowance");
  check(
    "Custom takeoff qty, internal cost, and selling price accept decimals",
    customDecimal?.quantityOverride === 1.5 &&
      customDecimal?.unitCost === 28.75 &&
      customDecimal?.customerUnitPrice === 37.5,
  );
  check(
    "Bag yield and stud spacing accept fractional values",
    emptyConcreteSlabInputs({ bagYieldCuFt: 0.45 }).bagYieldCuFt === 0.45 &&
      emptyFramedWallInputs({ studSpacingIn: 16.5 }).studSpacingIn === 16.5,
  );
  check(
    "Door/window/opening counts stay whole-number inputs",
    takeoffForm.includes("integer") &&
      takeoffForm.includes("Sliding patio doors") &&
      takeoffForm.includes("Standard doors") &&
      takeoffForm.includes("Windows") &&
      takeoffForm.includes("Openings") &&
      parseTakeoffNumericInput("2", "integer").value === 2 &&
      parseTakeoffNumericInput("1.5", "integer").status === "invalid",
  );

  console.log("\nUNIT — Material markup assist");
  check(
    "6.24 + 25% rounds to 7.80 and 18.98 + 25% rounds to 23.73",
    markedUpCustomerUnitPrice(6.24, 25) === 7.8 &&
      markedUpCustomerUnitPrice(6.24, 25)?.toFixed(2) === "7.80" &&
      markedUpCustomerUnitPrice(18.98, 25) === 23.73,
  );
  check(
    "Decimal markup 22.5% works",
    markedUpCustomerUnitPrice(6.24, 22.5) === 7.64,
  );
  check(
    "Negative markup is rejected",
    markedUpCustomerUnitPrice(6.24, -25) == null &&
      applyMaterialMarkup(
        computeTakeoff({
          takeoffType: "concrete-slab",
          inputs: { lengthFt: 10, widthFt: 10, thicknessIn: 4 },
        }).snapshot,
        -25,
      ).applied === 0,
  );
  const markupComputed = computeTakeoff({
    takeoffType: "concrete-slab",
    inputs: {
      lengthFt: 10,
      widthFt: 10,
      thicknessIn: 4,
      bagSizeLb: 60,
      bagYieldCuFt: 0.45,
      includePickup: true,
    },
    wastePercent: 10,
  }).snapshot;
  const markupBase = {
    ...markupComputed,
    items: markupComputed.items.map((item) => {
      if (item.id === "concrete-bags") {
        return {
          ...item,
          selected: true,
          quantityOverride: 12.5,
          unitCost: 6.24,
          customerUnitPrice: 1,
        };
      }
      if (item.id === "pickup-procurement") {
        return {
          ...item,
          selected: true,
          unitCost: 18.98,
          customerUnitPrice: 20,
        };
      }
      if (item.id === "wire-mesh") {
        return {
          ...item,
          selected: false,
          unitCost: 40,
          customerUnitPrice: 50,
        };
      }
      if (item.id === "form-lumber") {
        return {
          ...item,
          selected: true,
          unitCost: null,
          customerUnitPrice: 9,
        };
      }
      return { ...item, selected: false };
    }),
  };
  const bagsBeforeMarkup = markupBase.items.find((item) => item.id === "concrete-bags");
  const markupApplied = applyMaterialMarkup(markupBase, 25);
  const bagsMarked = markupApplied.snapshot.items.find((item) => item.id === "concrete-bags");
  const pickupMarked = markupApplied.snapshot.items.find(
    (item) => item.id === "pickup-procurement",
  );
  const meshMarked = markupApplied.snapshot.items.find((item) => item.id === "wire-mesh");
  const formsMarked = markupApplied.snapshot.items.find((item) => item.id === "form-lumber");
  check(
    "Apply markup updates only selected items that have internal cost",
    markupApplied.applied === 2 &&
      markupApplied.skipped === 1 &&
      bagsMarked?.customerUnitPrice === 7.8 &&
      pickupMarked?.customerUnitPrice === 23.73 &&
      meshMarked?.customerUnitPrice === 50 &&
      formsMarked?.customerUnitPrice === 9 &&
      formsMarked?.unitCost == null,
  );
  check(
    "Markup does not change unit cost, quantities, waste, or selection",
    bagsMarked?.unitCost === 6.24 &&
      bagsMarked?.quantityOverride === 12.5 &&
      bagsMarked?.calculatedQuantity === bagsBeforeMarkup?.calculatedQuantity &&
      bagsMarked?.selected === true &&
      markupApplied.snapshot.wastePercent === 10 &&
      markupApplied.snapshot.markupPercent === 25,
  );
  const afterManualPrice = applyTakeoffItemEdits(markupApplied.snapshot, [
    { id: "concrete-bags", customerUnitPrice: 9.99 },
  ]);
  check(
    "Owner can still edit customer unit price after applying markup",
    afterManualPrice.items.find((item) => item.id === "concrete-bags")?.customerUnitPrice ===
      9.99,
  );
  const markupPreserved = computeTakeoff({
    takeoffType: "concrete-slab",
    inputs: {
      lengthFt: 10,
      widthFt: 10,
      thicknessIn: 6,
      bagSizeLb: 60,
      bagYieldCuFt: 0.45,
      includePickup: true,
    },
    wastePercent: 10,
    previous: afterManualPrice,
  }).snapshot;
  check(
    "Recalculation keeps helper markup % and does not overwrite a manual customer price",
    markupPreserved.markupPercent === 25 &&
      markupPreserved.items.find((item) => item.id === "concrete-bags")?.customerUnitPrice ===
        9.99 &&
      markupPreserved.items.find((item) => item.id === "concrete-bags")?.unitCost === 6.24 &&
      markupPreserved.items.find((item) => item.id === "pickup-procurement")
        ?.customerUnitPrice === 23.73,
  );
  check(
    "Old snapshots without markupPercent still normalize",
    normalizeTakeoffSnapshot({
      version: 1,
      takeoffType: "concrete-slab",
      inputs: { lengthFt: 10, widthFt: 10, thicknessIn: 4 },
      wastePercent: 10,
      measurementSource: null,
      explanation: "",
      skippedMeasurements: [],
      removedItemIds: [],
      items: [],
    })?.markupPercent === 0,
  );

  console.log("\nUNIT — Internal unit cost stays independent of customer unit price");
  const priced = applyTakeoffItemEdits(
    computeTakeoff({
      takeoffType: "concrete-slab",
      inputs: {
        lengthFt: 10,
        widthFt: 10,
        thicknessIn: 4,
        bagSizeLb: 60,
        bagYieldCuFt: 0.45,
      },
      wastePercent: 10,
    }).snapshot,
    [
      {
        id: "concrete-bags",
        quantityOverride: 90,
        unitCost: 8,
        customerUnitPrice: 12,
        selected: true,
      },
    ],
  );
  const pricedBags = priced.items.find((item) => item.id === "concrete-bags");
  check(
    "Internal unit cost and customer unit price are independent fields",
    pricedBags?.unitCost === 8 &&
      pricedBags?.customerUnitPrice === 12 &&
      pricedBags?.unitCost !== pricedBags?.customerUnitPrice &&
      extendedMaterialCost(pricedBags) === 720 &&
      extendedCustomerPrice(pricedBags) === 1080,
  );
  const preserved = computeTakeoff({
    takeoffType: "concrete-slab",
    inputs: {
      lengthFt: 10,
      widthFt: 10,
      thicknessIn: 6,
      bagSizeLb: 60,
      bagYieldCuFt: 0.45,
    },
    wastePercent: 10,
    previous: priced,
  }).snapshot.items.find((item) => item.id === "concrete-bags");
  check(
    "Recalculation preserves quantity override, unit cost, and customer unit price",
    preserved?.quantityOverride === 90 &&
      preserved?.calculatedQuantity === 123 &&
      preserved?.unitCost === 8 &&
      preserved?.customerUnitPrice === 12 &&
      preserved?.selected === true,
  );

  console.log("\nUNIT — Sheet count and framed-wall studs/plates");
  check(
    "4×8 sheet count rounds up with waste",
    sheetCountRequired(288, 0, 4, 8) === 9 &&
      sheetCountRequired(288, 10, 4, 8) === 10 &&
      sheetCountRequired(289, 0, 4, 8) === 10,
  );
  check(
    "Framed-wall 12 ft @ 16 in OC is 10 layout studs",
    framedWallStudCount(12, 16) === 10,
  );
  check(
    "Framed-wall plates use 3× length with waste, rounded up to 8-ft boards",
    framedWallPlateBoards(12, 8, 10) === 5,
  );

  console.log("\nUNIT — Unit conversion and incompatible measurements");
  check("120 inches converts to 10 ft", convertLinearToFeet(120, "in").feet === 10);
  check("10 feet stays 10 ft", convertLinearToFeet(10, "ft").feet === 10);
  check("Cubic yards are rejected as linear", isRejectedLinearUnit("cu yd") === true);
  check("Meters are rejected as linear", convertLinearToFeet(3, "m").skipped?.includes("incompatible-unit") === true);
  const skippedIntake = suggestTakeoffInputs({
    takeoffType: "concrete-slab",
    intakeMeasurement: {
      catalogItemId: "x",
      source: CUSTOMER_REPORTED_MEASUREMENT,
      width: 10,
      height: 12,
      length: 10,
      quantity: null,
      unit: "YD",
    },
  });
  check(
    "Incompatible intake units are skipped, not forced into quantities",
    skippedIntake.skippedMeasurements.some((row) => row.includes("incompatible-unit")) &&
      skippedIntake.inputs.lengthFt == null,
  );
  const heightNotThickness = suggestTakeoffInputs({
    takeoffType: "concrete-slab",
    intakeMeasurement: {
      catalogItemId: "x",
      source: CUSTOMER_REPORTED_MEASUREMENT,
      width: 10,
      height: 12,
      length: 8,
      quantity: null,
      unit: "FT",
    },
  });
  check(
    "Intake height is not used as slab thickness",
    heightNotThickness.inputs.thicknessIn == null &&
      heightNotThickness.skippedMeasurements.includes("intake:height-not-used-as-slab-thickness") &&
      heightNotThickness.inputs.lengthFt === 8 &&
      heightNotThickness.inputs.widthFt === 10 &&
      heightNotThickness.measurementSource?.unverified === true,
  );

  const roundTrip = joinLineDescription(
    "Concrete patio",
    "Form, pour, and finish a 4-inch slab.",
    {
      calculatorId: "custom-variable-scope",
      inputs: { areaSqFt: 100 },
      rates: { areaRate: 12 },
    },
    [],
    {
      materialTakeoff: {
        version: 1,
        takeoffType: "concrete-slab",
        inputs: { lengthFt: 10, widthFt: 10, thicknessIn: 4 },
        wastePercent: 10,
        measurementSource: null,
        explanation: "Owner-only math",
        skippedMeasurements: [],
        removedItemIds: [],
        items: [],
      },
    },
  );
  const parts = splitLineDescription(roundTrip);
  check(
    "Title, scope, calculator, and takeoff round-trip in description encoding",
    parts.title === "Concrete patio" &&
      parts.includedWork === "Form, pour, and finish a 4-inch slab." &&
      parts.calculatorSnapshot?.calculatorId === "custom-variable-scope" &&
      parts.materialTakeoff?.takeoffType === "concrete-slab" &&
      roundTrip.includes(CALCULATOR_SNAPSHOT_MARKER) &&
      roundTrip.includes(MATERIAL_TAKEOFF_MARKER) &&
      !lineItemTitle(roundTrip).includes("TBBT Material") &&
      !lineItemIncludedWork(roundTrip)?.includes("TBBT Material"),
  );

  const ownerUser = await prisma.user.create({
    data: { name: "Takeoff Owner", email: `owner-to-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Takeoff Member", email: `member-to-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Beta Takeoff", email: `beta-to-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const businessA = await prisma.business.create({
    data: { name: "Alpha Takeoff", slug: `alpha-to-${randomUUID().slice(0, 8)}` },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Takeoff Co", slug: `beta-to-${randomUUID().slice(0, 8)}` },
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

  console.log("\nTEST — Recalculate, owner override, customer price, convert, no duplicates");
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
      description: joinLineDescription(
        DECORATIVE_WALL_PANELING_TITLE,
        "Install paneling\nCleanup",
      ),
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(0),
      total: new Prisma.Decimal(0),
      type: "LABOR",
    },
  });

  const calculated = await recalculateDraftMaterialTakeoff(prisma, ownerA, {
    estimateId: estimate.id,
    lineItemId: line.id,
    takeoffType: "concrete-slab",
    inputs: {
      lengthFt: 10,
      widthFt: 10,
      thicknessIn: 4,
      bagSizeLb: 60,
      bagYieldCuFt: 0.45,
      includeWireMesh: true,
      includeFormLumber: true,
      includeAnchors: true,
      includeSillGasket: true,
      includePickup: true,
    },
    wastePercent: 10,
  });
  const bags = calculated.snapshot.items.find((item) => item.id === "concrete-bags");
  check("Calculated 60-lb bag item is 82", bags?.calculatedQuantity === 82);
  check("Pickup/procurement is present as an editable takeoff item", calculated.snapshot.items.some((item) => item.kind === "pickup-procurement"));

  const withOverride = {
    ...calculated.snapshot,
    items: calculated.snapshot.items.map((item) =>
      item.id === "concrete-bags"
        ? {
            ...item,
            quantityOverride: 90,
            unitCost: 8,
            customerUnitPrice: 12,
            selected: true,
          }
        : item.id === "pickup-procurement"
          ? {
              ...item,
              unitCost: 75,
              customerUnitPrice: 95,
              selected: true,
            }
          : { ...item, selected: false },
    ),
  };
  await saveDraftMaterialTakeoff(prisma, ownerA, {
    estimateId: estimate.id,
    lineItemId: line.id,
    snapshot: withOverride,
  });

  const recalculated = await recalculateDraftMaterialTakeoff(prisma, ownerA, {
    estimateId: estimate.id,
    lineItemId: line.id,
    takeoffType: "concrete-slab",
    inputs: {
      ...withOverride.inputs,
      thicknessIn: 6,
    },
    wastePercent: 10,
    snapshotEdits: withOverride,
  });
  const bagsAfter = recalculated.snapshot.items.find((item) => item.id === "concrete-bags");
  check(
    "Owner quantity override survives recalculation while calculated qty updates",
    bagsAfter?.quantityOverride === 90 &&
      bagsAfter?.calculatedQuantity === 123 &&
      bagsAfter?.unitCost === 8 &&
      bagsAfter?.customerUnitPrice === 12 &&
      bagsAfter?.selected === true,
  );
  check(
    "Unit-cost edit drives extended internal material cost without changing selling price",
    bagsAfter != null &&
      extendedMaterialCost(bagsAfter) === 720 &&
      extendedCustomerPrice(bagsAfter) === 1080,
  );
  const pickupAfter = recalculated.snapshot.items.find((item) => item.id === "pickup-procurement");
  check(
    "Pickup customer unit price is preserved independently of unit cost",
    pickupAfter?.unitCost === 75 && pickupAfter?.customerUnitPrice === 95,
  );

  const missingPriceSnapshot = {
    ...recalculated.snapshot,
    items: recalculated.snapshot.items.map((item) =>
      item.id === "concrete-bags"
        ? { ...item, selected: true, customerUnitPrice: null }
        : { ...item, selected: false },
    ),
  };
  const materialBeforeMissing = await prisma.lineItem.count({
    where: { estimateId: estimate.id, businessId: businessA.id, type: "MATERIAL" },
  });
  await expectError(
    "Conversion refuses a missing customer unit price instead of creating a $0 MATERIAL line",
    () =>
      convertDraftMaterialTakeoff(prisma, ownerA, {
        estimateId: estimate.id,
        lineItemId: line.id,
        snapshot: missingPriceSnapshot,
      }),
    (error) =>
      error instanceof EstimateLineError &&
      error.message.includes("customer unit price") &&
      error.message.includes("60-lb concrete bags"),
  );
  const materialAfterMissing = await prisma.lineItem.count({
    where: { estimateId: estimate.id, businessId: businessA.id, type: "MATERIAL" },
  });
  check(
    "No MATERIAL line is created when customer unit price is missing",
    materialAfterMissing === materialBeforeMissing,
  );

  const zeroPriceSnapshot = {
    ...recalculated.snapshot,
    items: recalculated.snapshot.items.map((item) =>
      item.id === "concrete-bags"
        ? { ...item, selected: true, customerUnitPrice: 0 }
        : { ...item, selected: false },
    ),
  };
  await expectError(
    "Conversion refuses a $0 customer unit price instead of creating a $0 MATERIAL line",
    () =>
      convertDraftMaterialTakeoff(prisma, ownerA, {
        estimateId: estimate.id,
        lineItemId: line.id,
        snapshot: zeroPriceSnapshot,
      }),
    (error) =>
      error instanceof EstimateLineError &&
      error.message.includes("customer unit price") &&
      error.message.includes("60-lb concrete bags"),
  );
  check(
    "No MATERIAL line is created from a $0 customer unit price",
    (await prisma.lineItem.count({
      where: { estimateId: estimate.id, businessId: businessA.id, type: "MATERIAL" },
    })) === materialBeforeMissing,
  );

  const mixedPriceSnapshot = {
    ...recalculated.snapshot,
    items: recalculated.snapshot.items.map((item) =>
      item.id === "concrete-bags"
        ? { ...item, selected: true }
        : item.id === "pickup-procurement"
          ? { ...item, selected: true, customerUnitPrice: null }
          : { ...item, selected: false },
    ),
  };
  await expectError(
    "Conversion names every selected item that still needs a customer unit price",
    () =>
      convertDraftMaterialTakeoff(prisma, ownerA, {
        estimateId: estimate.id,
        lineItemId: line.id,
        snapshot: mixedPriceSnapshot,
      }),
    (error) =>
      error instanceof EstimateLineError &&
      error.message.includes("Material pickup / procurement") &&
      !error.message.includes("60-lb concrete bags"),
  );
  check(
    "Partial convert does not create MATERIAL lines when another selected item is missing a customer price",
    (await prisma.lineItem.count({
      where: { estimateId: estimate.id, businessId: businessA.id, type: "MATERIAL" },
    })) === materialBeforeMissing,
  );

  const firstConvert = await convertDraftMaterialTakeoff(prisma, ownerA, {
    estimateId: estimate.id,
    lineItemId: line.id,
    snapshot: recalculated.snapshot,
  });
  check("Selected takeoff items convert to MATERIAL lines", firstConvert.created === 2);

  const afterConvert = await prisma.lineItem.findMany({
    where: { estimateId: estimate.id, businessId: businessA.id },
    orderBy: { createdAt: "asc" },
  });
  const materialLines = afterConvert.filter((item) => item.type === "MATERIAL");
  const bagLine = materialLines.find((item) => lineItemTitle(item.description) === "60-lb concrete bags");
  const pickupLine = materialLines.find(
    (item) => lineItemTitle(item.description) === "Material pickup / procurement",
  );
  check(
    "Converted MATERIAL line uses customer unit price, not internal unit cost",
    bagLine != null &&
      Number(bagLine.quantity.toString()) === 90 &&
      Number(bagLine.unitPrice.toString()) === 12 &&
      Number(bagLine.unitPrice.toString()) !== 8 &&
      lineMaterialTakeoffSource(bagLine.description)?.itemId === "concrete-bags" &&
      bagLine.description.includes(MATERIAL_TAKEOFF_SOURCE_MARKER) &&
      !lineItemTitle(bagLine.description).includes("TBBT") &&
      !bagLine.description.includes("quantityOverride") &&
      !bagLine.description.includes("unitCost") &&
      !bagLine.description.includes("customerUnitPrice"),
  );
  check(
    "Pickup MATERIAL line also uses customer unit price",
    pickupLine != null && Number(pickupLine.unitPrice.toString()) === 95,
  );
  check(
    "Converted lines do not include takeoff internals in the customer title",
    materialLines.every(
      (item) =>
        !lineItemTitle(item.description).includes("waste") &&
        !lineItemTitle(item.description).includes("bagYield"),
    ),
  );

  const repeatConvert = await convertDraftMaterialTakeoff(prisma, ownerA, {
    estimateId: estimate.id,
    lineItemId: line.id,
  });
  const afterRepeat = await prisma.lineItem.findMany({
    where: { estimateId: estimate.id, businessId: businessA.id, type: "MATERIAL" },
  });
  check("Repeat conversion does not duplicate previously generated lines", repeatConvert.created === 0);
  check("MATERIAL line count is unchanged after repeat convert", afterRepeat.length === materialLines.length);

  console.log("\nTEST — Calculator apply, versions, and customer document stay intact");
  const applied = await applyDraftEstimateCalculator(prisma, ownerA, {
    estimateId: estimate.id,
    lineItemId: line.id,
    inputs: FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE,
    rates: DEFAULT_DECORATIVE_WALL_PANELING_RATES,
  });
  check(
    "Applying the labor calculator preserves the owner takeoff snapshot",
    lineCalculatorSnapshot(applied.description)?.recommendedAmount === 1800 &&
      lineMaterialTakeoff(applied.description)?.items.some(
        (item) =>
          item.quantityOverride === 90 &&
          item.unitCost === 8 &&
          item.customerUnitPrice === 12,
      ),
  );

  await persistDraftEstimateTotal(prisma, estimate.id, businessA.id);
  await prisma.$transaction(async (tx) => {
    await tx.estimate.update({
      where: { id: estimate.id },
      data: { status: "SENT" },
    });
    await createEstimateVersionSnapshot(tx, {
      estimateId: estimate.id,
      businessId: businessA.id,
    });
  });
  const document = await loadEstimateDocumentForBusiness(estimate.id, businessA.id, prisma);
  const plain = document ? estimateDocumentPlainText(document) : "";
  check(
    "Public/print estimate document does not leak takeoff internals",
    document != null &&
      document.lineItems.every((item) => !item.description.includes("TBBT Material")) &&
      !plain.includes("TBBT Material Takeoff") &&
      !plain.includes("quantityOverride") &&
      !plain.includes("bagYieldCuFt") &&
      !plain.includes("calculatedQuantity") &&
      !plain.includes("unitCost") &&
      !plain.includes("customerUnitPrice") &&
      !plain.includes("wastePercent") &&
      !plain.includes("markupPercent") &&
      !plain.includes("Material Markup") &&
      !plain.includes("lengthInPart") &&
      document.lineItems[0]?.description === DECORATIVE_WALL_PANELING_TITLE,
  );

  console.log("\nTEST — Decimal conversion preserves cents and hides internals");
  const decimalEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  const decimalLine = await prisma.lineItem.create({
    data: {
      businessId: businessA.id,
      estimateId: decimalEstimate.id,
      description: joinLineDescription("Decimal takeoff patio"),
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(0),
      total: new Prisma.Decimal(0),
      type: "LABOR",
    },
  });
  const decimalCalculated = await recalculateDraftMaterialTakeoff(prisma, ownerA, {
    estimateId: decimalEstimate.id,
    lineItemId: decimalLine.id,
    takeoffType: "concrete-slab",
    inputs: {
      lengthFtPart: 8,
      lengthInPart: 0,
      widthFtPart: 3,
      widthInPart: 4,
      thicknessIn: 4,
      bagSizeLb: 60,
      bagYieldCuFt: 0.45,
    },
    wastePercent: 10,
  });
  check(
    "Founder 8 ft × 3 ft 4 in × 4 in slab still calculates after decimal-input change",
    decimalCalculated.snapshot.items.find((item) => item.id === "concrete-bags")
      ?.calculatedQuantity === 22 && decimalCalculated.snapshot.wastePercent === 10,
  );
  const decimalSnapshot = {
    ...decimalCalculated.snapshot,
    items: decimalCalculated.snapshot.items.map((item) =>
      item.id === "concrete-bags"
        ? {
            ...item,
            quantityOverride: 12.5,
            unitCost: 6.24,
            customerUnitPrice: 7.95,
            selected: true,
          }
        : { ...item, selected: false },
    ),
  };
  await saveDraftMaterialTakeoff(prisma, ownerA, {
    estimateId: decimalEstimate.id,
    lineItemId: decimalLine.id,
    snapshot: decimalSnapshot,
  });
  const decimalRecalc = await recalculateDraftMaterialTakeoff(prisma, ownerA, {
    estimateId: decimalEstimate.id,
    lineItemId: decimalLine.id,
    takeoffType: "concrete-slab",
    inputs: decimalSnapshot.inputs,
    wastePercent: 10,
    snapshotEdits: decimalSnapshot,
  });
  const decimalBagsAfter = decimalRecalc.snapshot.items.find(
    (item) => item.id === "concrete-bags",
  );
  check(
    "Saved decimal qty/cost/price survive recalculation",
    decimalBagsAfter?.quantityOverride === 12.5 &&
      decimalBagsAfter?.unitCost === 6.24 &&
      decimalBagsAfter?.customerUnitPrice === 7.95,
  );
  const decimalConvert = await convertDraftMaterialTakeoff(prisma, ownerA, {
    estimateId: decimalEstimate.id,
    lineItemId: decimalLine.id,
    snapshot: decimalRecalc.snapshot,
  });
  check("Decimal takeoff converts one selected MATERIAL line", decimalConvert.created === 1);
  const decimalMaterials = await prisma.lineItem.findMany({
    where: { estimateId: decimalEstimate.id, businessId: businessA.id, type: "MATERIAL" },
  });
  const decimalBagLine = decimalMaterials.find(
    (item) => lineItemTitle(item.description) === "60-lb concrete bags",
  );
  check(
    "Converted MATERIAL line keeps cents in customer unit price and decimal owner qty",
    decimalBagLine != null &&
      Number(decimalBagLine.quantity.toString()) === 12.5 &&
      Number(decimalBagLine.unitPrice.toString()) === 7.95 &&
      Number(decimalBagLine.unitPrice.toString()) !== 6.24 &&
      !decimalBagLine.description.includes("unitCost") &&
      !decimalBagLine.description.includes("quantityOverride") &&
      !decimalBagLine.description.includes("wastePercent"),
  );

  await persistDraftEstimateTotal(prisma, decimalEstimate.id, businessA.id);
  await prisma.$transaction(async (tx) => {
    await tx.estimate.update({
      where: { id: decimalEstimate.id },
      data: { status: "SENT" },
    });
    await createEstimateVersionSnapshot(tx, {
      estimateId: decimalEstimate.id,
      businessId: businessA.id,
    });
  });
  const decimalDocument = await loadEstimateDocumentForBusiness(
    decimalEstimate.id,
    businessA.id,
    prisma,
  );
  const decimalPlain = decimalDocument ? estimateDocumentPlainText(decimalDocument) : "";
  check(
    "Customer-facing document does not expose internal cost or takeoff fields",
    decimalDocument != null &&
      decimalDocument.lineItems.every((item) => !item.description.includes("TBBT Material")) &&
      !decimalPlain.includes("TBBT Material Takeoff") &&
      !decimalPlain.includes("quantityOverride") &&
      !decimalPlain.includes("unitCost") &&
      !decimalPlain.includes("customerUnitPrice") &&
      !decimalPlain.includes("wastePercent") &&
      !decimalPlain.includes("markupPercent") &&
      !decimalPlain.includes("Material Markup") &&
      !decimalPlain.includes("bagYieldCuFt") &&
      !decimalPlain.includes("6.24"),
  );

  console.log("\nTEST — Markup assist does not auto-convert and stays private");
  const markupEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  const markupLine = await prisma.lineItem.create({
    data: {
      businessId: businessA.id,
      estimateId: markupEstimate.id,
      description: joinLineDescription("Markup patio"),
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(0),
      total: new Prisma.Decimal(0),
      type: "LABOR",
    },
  });
  const markupCalc = await recalculateDraftMaterialTakeoff(prisma, ownerA, {
    estimateId: markupEstimate.id,
    lineItemId: markupLine.id,
    takeoffType: "concrete-slab",
    inputs: {
      lengthFtPart: 8,
      lengthInPart: 0,
      widthFtPart: 3,
      widthInPart: 4,
      thicknessIn: 4,
      bagSizeLb: 60,
      bagYieldCuFt: 0.45,
      includePickup: true,
    },
    wastePercent: 10,
  });
  const pricedForMarkup = {
    ...markupCalc.snapshot,
    items: markupCalc.snapshot.items.map((item) =>
      item.id === "concrete-bags"
        ? {
            ...item,
            selected: true,
            quantityOverride: 12.5,
            unitCost: 6.24,
            customerUnitPrice: null,
          }
        : item.id === "pickup-procurement"
          ? {
              ...item,
              selected: false,
              unitCost: 18.98,
              customerUnitPrice: null,
            }
          : { ...item, selected: false },
    ),
  };
  const appliedMarkup = applyMaterialMarkup(pricedForMarkup, 25);
  check(
    "Unselected pickup is not marked up",
    appliedMarkup.snapshot.items.find((item) => item.id === "pickup-procurement")
      ?.customerUnitPrice == null &&
      appliedMarkup.snapshot.items.find((item) => item.id === "concrete-bags")
        ?.customerUnitPrice === 7.8,
  );
  await saveDraftMaterialTakeoff(prisma, ownerA, {
    estimateId: markupEstimate.id,
    lineItemId: markupLine.id,
    snapshot: appliedMarkup.snapshot,
  });
  const materialBeforeMarkupConvert = await prisma.lineItem.count({
    where: { estimateId: markupEstimate.id, businessId: businessA.id, type: "MATERIAL" },
  });
  check(
    "Applying markup does not auto-convert MATERIAL lines",
    materialBeforeMarkupConvert === 0 && appliedMarkup.snapshot.markupPercent === 25,
  );
  const markupRecalc = await recalculateDraftMaterialTakeoff(prisma, ownerA, {
    estimateId: markupEstimate.id,
    lineItemId: markupLine.id,
    takeoffType: "concrete-slab",
    inputs: appliedMarkup.snapshot.inputs,
    wastePercent: 10,
    snapshotEdits: appliedMarkup.snapshot,
  });
  check(
    "Recalc after markup keeps 7.80 selling price and helper 25%",
    markupRecalc.snapshot.markupPercent === 25 &&
      markupRecalc.snapshot.items.find((item) => item.id === "concrete-bags")
        ?.customerUnitPrice === 7.8 &&
      markupRecalc.snapshot.items.find((item) => item.id === "concrete-bags")
        ?.unitCost === 6.24,
  );
  const markupConvert = await convertDraftMaterialTakeoff(prisma, ownerA, {
    estimateId: markupEstimate.id,
    lineItemId: markupLine.id,
    snapshot: markupRecalc.snapshot,
  });
  const markupMaterials = await prisma.lineItem.findMany({
    where: { estimateId: markupEstimate.id, businessId: businessA.id, type: "MATERIAL" },
  });
  const markupBagLine = markupMaterials.find(
    (item) => lineItemTitle(item.description) === "60-lb concrete bags",
  );
  check("Markup convert creates the selected MATERIAL line only", markupConvert.created === 1);
  check(
    "Converted MATERIAL line uses marked-up customer price, not internal cost",
    markupBagLine != null &&
      Number(markupBagLine.unitPrice.toString()) === 7.8 &&
      Number(markupBagLine.quantity.toString()) === 12.5 &&
      !markupBagLine.description.includes("markupPercent") &&
      !markupBagLine.description.includes("unitCost"),
  );

  await persistDraftEstimateTotal(prisma, markupEstimate.id, businessA.id);
  await prisma.$transaction(async (tx) => {
    await tx.estimate.update({
      where: { id: markupEstimate.id },
      data: { status: "SENT" },
    });
    await createEstimateVersionSnapshot(tx, {
      estimateId: markupEstimate.id,
      businessId: businessA.id,
    });
  });
  const markupDocument = await loadEstimateDocumentForBusiness(
    markupEstimate.id,
    businessA.id,
    prisma,
  );
  const markupPlain = markupDocument ? estimateDocumentPlainText(markupDocument) : "";
  check(
    "Customer document does not expose markup %, internal cost, or takeoff internals",
    markupDocument != null &&
      !markupPlain.includes("TBBT Material Takeoff") &&
      !markupPlain.includes("markupPercent") &&
      !markupPlain.includes("Material Markup") &&
      !markupPlain.includes("unitCost") &&
      !markupPlain.includes("6.24") &&
      !markupPlain.includes("wastePercent") &&
      !markupPlain.includes("quantityOverride"),
  );

  console.log("\nTEST — Sheet covering, framed wall, tenant isolation");
  const estimate2 = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  const sheetLine = await prisma.lineItem.create({
    data: {
      businessId: businessA.id,
      estimateId: estimate2.id,
      description: joinLineDescription("Sheet covering"),
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(1),
      total: new Prisma.Decimal(1),
      type: "LABOR",
    },
  });
  const sheet = await recalculateDraftMaterialTakeoff(prisma, ownerA, {
    estimateId: estimate2.id,
    lineItemId: sheetLine.id,
    takeoffType: "sheet-covering",
    inputs: {
      wallWidthFt: 24,
      wallHeightFt: 12,
      sheetWidthFt: 4,
      sheetHeightFt: 8,
      includeTrim: true,
      includeFasteners: true,
    },
    wastePercent: 10,
  });
  check(
    "Sheet covering 24×12 with 10% waste is 10 sheets",
    sheet.snapshot.items.find((item) => item.id === "sheets")?.calculatedQuantity === 10,
  );

  const wallLine = await prisma.lineItem.create({
    data: {
      businessId: businessA.id,
      estimateId: estimate2.id,
      description: joinLineDescription("Framed wall"),
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(1),
      total: new Prisma.Decimal(1),
      type: "LABOR",
    },
  });
  const wall = await recalculateDraftMaterialTakeoff(prisma, ownerA, {
    estimateId: estimate2.id,
    lineItemId: wallLine.id,
    takeoffType: "framed-wall",
    inputs: {
      wallLengthFt: 12,
      wallHeightFt: 8,
      studSpacingIn: 16,
      openings: 1,
      includeSheathing: true,
      includeFasteners: true,
    },
    wastePercent: 10,
  });
  const studs = wall.snapshot.items.find((item) => item.id === "studs");
  check(
    "Framed-wall studs include layout, one opening, and waste",
    studs?.calculatedQuantity === 10 + 4 + 1,
  );
  check(
    "Framed-wall plates are present",
    wall.snapshot.items.find((item) => item.id === "plates")?.calculatedQuantity === 5,
  );

  await expectError(
    "MEMBER cannot save a material takeoff",
    () =>
      saveDraftMaterialTakeoff(prisma, memberA, {
        estimateId: estimate2.id,
        lineItemId: sheetLine.id,
        snapshot: sheet.snapshot,
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "Foreign-business owner cannot convert another tenant's takeoff",
    () =>
      convertDraftMaterialTakeoff(prisma, ownerB, {
        estimateId: estimate2.id,
        lineItemId: sheetLine.id,
        snapshot: sheet.snapshot,
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes("authorized business"),
  );
  const foreignEstimate = await prisma.estimate.create({
    data: {
      businessId: businessB.id,
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  check(
    "Tenant rows stay on their own businessId",
    (await prisma.lineItem.findMany({ where: { estimateId: estimate.id } })).every(
      (item) => item.businessId === businessA.id,
    ) &&
      (await prisma.estimate.findFirst({ where: { id: foreignEstimate.id } }))?.businessId ===
        businessB.id,
  );

  await expectError(
    "Incomplete concrete dimensions are rejected",
    () =>
      recalculateDraftMaterialTakeoff(prisma, ownerA, {
        estimateId: estimate2.id,
        lineItemId: sheetLine.id,
        takeoffType: "concrete-slab",
        inputs: { lengthFt: 10, widthFt: 0, thicknessIn: 4 },
        wastePercent: 10,
      }),
    (error) => error instanceof EstimateLineError,
  );

  if (failures > 0) {
    console.error(`\n${failures} material-takeoff check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll material-takeoff checks passed.");
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}

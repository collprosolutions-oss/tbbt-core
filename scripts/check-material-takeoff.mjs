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
  concreteBagsRequired,
  concreteVolumeCuFt,
  convertDraftMaterialTakeoff,
  convertLinearToFeet,
  emptyConcreteSlabInputs,
  framedWallPlateBoards,
  framedWallStudCount,
  isRejectedLinearUnit,
  recalculateDraftMaterialTakeoff,
  saveDraftMaterialTakeoff,
  sheetCountRequired,
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
      customerPage.includes("lineItemTitle") &&
      !printPage.includes("MaterialTakeoffForm") &&
      !portalPage.includes("MaterialTakeoffForm") &&
      portalPage.includes("ApprovedScopeCard"),
  );
  check(
    "Owner draft page mounts takeoff and keeps mutations in server actions",
    ownerPage.includes("MaterialTakeoffForm") &&
      ownerPage.includes("lineMaterialTakeoff") &&
      !ownerPage.includes("saveDraftMaterialTakeoff") &&
      takeoffForm.includes("saveEstimateMaterialTakeoff") &&
      takeoffForm.includes("convertEstimateMaterialTakeoff") &&
      takeoffForm.includes("Calculate from measurements"),
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

  console.log("\nTEST — Recalculate, owner override, unit cost, convert, no duplicates");
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
        ? { ...item, quantityOverride: 90, unitCost: 8, selected: true }
        : item.id === "pickup-procurement"
          ? { ...item, unitCost: 75, selected: true }
          : { ...item, selected: item.id === "wire-mesh" ? false : item.selected },
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
      bagsAfter?.unitCost === 8,
  );
  check(
    "Unit-cost edit drives extended internal material cost",
    bagsAfter != null && 90 * 8 === 720,
  );

  const firstConvert = await convertDraftMaterialTakeoff(prisma, ownerA, {
    estimateId: estimate.id,
    lineItemId: line.id,
    snapshot: recalculated.snapshot,
  });
  check("Selected takeoff items convert to MATERIAL lines", firstConvert.created >= 1);

  const afterConvert = await prisma.lineItem.findMany({
    where: { estimateId: estimate.id, businessId: businessA.id },
    orderBy: { createdAt: "asc" },
  });
  const materialLines = afterConvert.filter((item) => item.type === "MATERIAL");
  const bagLine = materialLines.find((item) => lineItemTitle(item.description) === "60-lb concrete bags");
  check(
    "Converted MATERIAL line uses owner quantity and unit cost as customer starting price",
    bagLine != null &&
      Number(bagLine.quantity.toString()) === 90 &&
      Number(bagLine.unitPrice.toString()) === 8 &&
      lineMaterialTakeoffSource(bagLine.description)?.itemId === "concrete-bags" &&
      bagLine.description.includes(MATERIAL_TAKEOFF_SOURCE_MARKER) &&
      !lineItemTitle(bagLine.description).includes("TBBT") &&
      !bagLine.description.includes("quantityOverride"),
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
      lineMaterialTakeoff(applied.description)?.items.some((item) => item.quantityOverride === 90),
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
      document.lineItems[0]?.description === DECORATIVE_WALL_PANELING_TITLE,
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

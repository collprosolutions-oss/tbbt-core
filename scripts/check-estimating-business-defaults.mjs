/**
 * Business estimating defaults: reusable owner pricing for registered
 * workspaces, independent of project snapshots, catalog rows, and
 * SENT/APPROVED/invoice encodings.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-estimating-business-defaults.mjs
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
  lineMaterialTakeoff,
  isOriginalEstimateWorkLine,
} = await import("@/lib/estimate-line-scope");
const { resolveEstimatingWorkspace } = await import(
  "@/lib/estimate-calculators"
);
const { overrideDraftEstimateLinePrice } = await import("@/lib/estimate-line-ops");
  const {
    applyDraftTakeoffRecommendedLabor,
    computeTakeoff,
    convertDraftMaterialTakeoff,
    resetDraftTakeoffAndGeneratedMaterials,
    saveDraftMaterialTakeoff,
    seedDraftTakeoffFromBusinessDefaults,
    DEFAULT_CONCRETE_60LB_BAG_LABOR_RATE,
  } = await import("@/lib/material-takeoff");
const { addRequestDraftLines } = await import("@/lib/request-estimate-draft");
const { CUSTOMER_REPORTED_MEASUREMENT } = await import("@/lib/catalog-intake");
const { setDraftEstimateCustomerMaterialsTotal } = await import(
  "@/lib/customer-materials-total"
);
const {
  applyBusinessEstimatingDefaults,
  describeSavedBusinessDefaults,
  extractReusableEstimatingDefaults,
  parseBusinessEstimatingDefaultPayload,
  reusableCustomMaterialId,
  stripProjectTakeoffInputs,
} = await import("@/lib/estimating-defaults");
const {
  loadBusinessEstimatingDefaults,
  saveBusinessEstimatingDefaultsFromTakeoff,
} = await import("@/lib/estimating-defaults-db");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_estimating_business_defaults_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for estimating-business-defaults test database.");
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

function snapshotReadyToConvert(snapshot) {
  return {
    ...snapshot,
    items: snapshot.items.map((item) =>
      item.customerUnitPrice != null || item.unitCost != null
        ? item
        : { ...item, selected: false },
    ),
  };
}

function money(value) {
  return Number(new Prisma.Decimal(value).toFixed(2));
}

const DAVID_INPUTS = {
  lengthFt: 10,
  widthFt: 10,
  thicknessIn: 4,
  bagSizeLb: 60,
  bagYieldCuFt: 0.45,
  includeWireMesh: true,
  includeFormLumber: true,
  includePickup: true,
};
const VICTORIA_INPUTS = {
  lengthFt: 12,
  widthFt: 8,
  thicknessIn: 4,
  bagSizeLb: 60,
  bagYieldCuFt: 0.45,
  includeWireMesh: true,
  includeFormLumber: true,
  includePickup: true,
};

try {
  console.log("\nSTATIC — Business defaults architecture and owner control");
  check("OWNER can manage estimates", roleHasCapability("OWNER", CAPABILITIES.MANAGE_ESTIMATES));
  check("MEMBER cannot manage estimates", !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_ESTIMATES));

  const schema = readRepo("prisma/schema.prisma");
  const form = readRepo("src/components/estimates/material-takeoff-form.tsx");
  const ownerPage = readRepo("src/app/(app)/estimates/[estimateId]/page.tsx");
  const customerPage = readRepo("src/app/e/[token]/page.tsx");
  const defaultsLib = readRepo("src/lib/estimating-defaults.ts");
  const defaultsDb = readRepo("src/lib/estimating-defaults-db.ts");

  check(
    "Durable BusinessEstimatingDefault table is business + workspace scoped",
    schema.includes("model BusinessEstimatingDefault") &&
      schema.includes("@@unique([businessId, workspaceId])") &&
      !schema.includes("takeoffSnapshot") &&
      defaultsDb.includes("CREATE TABLE IF NOT EXISTS") &&
      defaultsLib.includes("extractReusableEstimatingDefaults") &&
      defaultsLib.includes("applyBusinessEstimatingDefaults"),
  );
  check(
    "Owner has an explicit Save as business default control and source label",
    form.includes("Save as business default") &&
      form.includes("BUSINESS_DEFAULT_SOURCE_LABEL") &&
      form.includes("Project only") &&
      form.includes("Save with this calculator as business default") &&
      form.includes("saveEstimateBusinessEstimatingDefaults") &&
      ownerPage.includes("businessDefaults") &&
      !customerPage.includes("Save as business default") &&
      !customerPage.includes("Business default"),
  );
  check(
    "Project measurements and rounded totals are not treated as reusable defaults",
    defaultsLib.includes("Never copies labor add-ons, quantity overrides, rounded job totals") &&
      defaultsLib.includes('"lengthFt"'),
  );

  const emptyConcrete = computeTakeoff({
    takeoffType: "concrete-slab",
    inputs: DAVID_INPUTS,
    wastePercent: 10,
  }).snapshot;
  emptyConcrete.laborRate = 36;
  emptyConcrete.laborAdjustment = 75;
  emptyConcrete.markupPercent = 20;
  emptyConcrete.items = emptyConcrete.items.map((item) =>
    item.id === "concrete-bags"
      ? { ...item, unitCost: 8.5, customerUnitPrice: 12, quantityOverride: 999 }
      : item.id === "wire-mesh"
        ? { ...item, unitCost: 18, customerUnitPrice: 24 }
        : item.id === "form-lumber"
          ? { ...item, unitCost: 9.5, customerUnitPrice: 14 }
          : item.id === "form-stakes"
            ? { ...item, unitCost: 1.25, customerUnitPrice: 2 }
            : item.id === "pickup-procurement"
              ? { ...item, unitCost: 40, customerUnitPrice: 40 }
              : item,
  );
  emptyConcrete.items.push(
    {
      id: "custom-one-off",
      kind: "custom",
      label: "Unusual hauling",
      unit: "trip",
      optional: true,
      selected: true,
      calculatedQuantity: 1,
      quantityOverride: 1,
      unitCost: 200,
      customerUnitPrice: 250,
      explanation: "Project only",
      convertedLineItemId: null,
      persistAs: "project",
    },
    {
      id: "custom-poly-uuid",
      kind: "custom",
      label: "Poly Plastic",
      unit: "roll",
      optional: true,
      selected: true,
      calculatedQuantity: 1,
      quantityOverride: 1,
      unitCost: 22,
      customerUnitPrice: 35,
      explanation: "Reusable",
      convertedLineItemId: null,
      persistAs: "business-default",
    },
    {
      id: "custom-oil-uuid",
      kind: "custom",
      label: "Vegetable Oil",
      unit: "gal",
      optional: true,
      selected: true,
      calculatedQuantity: 1,
      quantityOverride: 1,
      unitCost: 8,
      customerUnitPrice: 12,
      explanation: "Reusable",
      convertedLineItemId: null,
      persistAs: "business-default",
    },
  );
  const extracted = extractReusableEstimatingDefaults({
    workspaceId: "concrete-slab",
    snapshot: emptyConcrete,
  });
  check(
    "Extract keeps reusable pricing and drops project measurements / qty overrides / add-ons",
    extracted.labor.laborRate === 36 &&
      extracted.material.wastePercent === 10 &&
      extracted.material.markupPercent === 20 &&
      extracted.material.reusableInputs?.bagYieldCuFt === 0.45 &&
      extracted.material.reusableInputs?.includeWireMesh === true &&
      extracted.material.items?.some((item) => item.id === "concrete-bags" && item.unitCost === 8.5) &&
      extracted.material.items?.some((item) => item.id === "wire-mesh" && item.unitCost === 18) &&
      extracted.material.items?.some((item) => item.id === "pickup-procurement" && item.unitCost === 40) &&
      extracted.material.reusableInputs?.lengthFt == null &&
      extracted.material.reusableInputs?.widthFt == null &&
      extracted.labor.laborRate !== 800 &&
      !Object.prototype.hasOwnProperty.call(extracted.labor, "laborAdjustment"),
  );
  check(
    "Extract saves reusable custom materials by stable calculator identity, not LineItem ids",
    extracted.material.items?.some(
      (item) =>
        item.id === reusableCustomMaterialId("Poly Plastic", "roll") &&
        item.kind === "custom" &&
        item.unitCost === 22,
    ) &&
      extracted.material.items?.some(
        (item) =>
          item.id === reusableCustomMaterialId("Vegetable Oil", "gal") &&
          item.label === "Vegetable Oil",
      ) &&
      !extracted.material.items?.some((item) => item.label === "Unusual hauling") &&
      !extracted.material.items?.some((item) => item.id === "custom-poly-uuid"),
  );
  check(
    "stripProjectTakeoffInputs never copies slab dimensions",
    stripProjectTakeoffInputs("concrete-slab", {
      lengthFt: 10,
      widthFt: 10,
      bagYieldCuFt: 0.45,
      bagSizeLb: 60,
    }).lengthFt == null &&
      stripProjectTakeoffInputs("concrete-slab", {
        lengthFt: 10,
        bagYieldCuFt: 0.45,
      }).bagYieldCuFt === 0.45,
  );

  const victoriaBase = computeTakeoff({
    takeoffType: "concrete-slab",
    inputs: VICTORIA_INPUTS,
    wastePercent: 8,
  }).snapshot;
  victoriaBase.laborAdjustment = 0;
  const victoriaApplied = applyBusinessEstimatingDefaults(victoriaBase, extracted);
  const victoriaBags = victoriaApplied.items.find((item) => item.id === "concrete-bags");
  const davidBags = emptyConcrete.items.find((item) => item.id === "concrete-bags");
  const victoriaPoly = victoriaApplied.items.find(
    (item) => item.id === reusableCustomMaterialId("Poly Plastic", "roll"),
  );
  const victoriaOil = victoriaApplied.items.find(
    (item) => item.id === reusableCustomMaterialId("Vegetable Oil", "gal"),
  );
  check(
    "Applying defaults onto Victoria keeps her dimensions and fresh quantities, not David totals",
    victoriaApplied.laborRate === 36 &&
      victoriaApplied.laborAdjustment === 0 &&
      victoriaApplied.markupPercent === 20 &&
      victoriaBags?.unitCost === 8.5 &&
      victoriaBags?.customerUnitPrice === 12 &&
      victoriaBags?.quantityOverride == null &&
      victoriaBags?.calculatedQuantity !== davidBags?.calculatedQuantity &&
      victoriaBags?.calculatedQuantity !== 999 &&
      Number(victoriaApplied.inputs.lengthFt) === 12 &&
      Number(victoriaApplied.inputs.widthFt) === 8,
  );
  check(
    "Victoria receives reusable Poly Plastic and Vegetable Oil with saved prices, not project-only hauling",
    victoriaPoly?.kind === "custom" &&
      victoriaPoly?.unitCost === 22 &&
      victoriaPoly?.customerUnitPrice === 35 &&
      victoriaOil?.unitCost === 8 &&
      victoriaOil?.customerUnitPrice === 12 &&
      !victoriaApplied.items.some((item) => item.label === "Unusual hauling"),
  );

  const victoriaSmallBase = computeTakeoff({
    takeoffType: "concrete-slab",
    inputs: { lengthFt: 3, widthFt: 2, thicknessIn: 4, bagSizeLb: 60, bagYieldCuFt: 0.45 },
    wastePercent: 8,
  }).snapshot;
  const victoriaSmall = applyBusinessEstimatingDefaults(victoriaSmallBase, extracted, {
    mode: "seed",
  });
  const smallBags = victoriaSmall.items.find((item) => item.id === "concrete-bags");
  check(
    "3 ft × 2 ft × 4 in calculates a fresh bag count while keeping saved material prices",
    Number(victoriaSmall.inputs.lengthFt) === 3 &&
      Number(victoriaSmall.inputs.widthFt) === 2 &&
      smallBags?.unitCost === 8.5 &&
      smallBags?.calculatedQuantity != null &&
      smallBags.calculatedQuantity < (victoriaBags?.calculatedQuantity ?? 0) &&
      victoriaSmall.laborAdjustment === 0 &&
      victoriaSmall.items.some((item) => item.label === "Poly Plastic"),
  );

  const afterCalculate = applyBusinessEstimatingDefaults(
    computeTakeoff({
      takeoffType: "concrete-slab",
      inputs: victoriaSmall.inputs,
      wastePercent: victoriaSmall.wastePercent,
      previous: { ...victoriaSmall, items: victoriaSmall.items.filter((item) => item.kind !== "custom") },
    }).snapshot,
    extracted,
    { mode: "overlay" },
  );
  check(
    "Calculate overlay restores missing reusable custom materials and standard prices",
    afterCalculate.items.some((item) => item.label === "Poly Plastic" && item.unitCost === 22) &&
      afterCalculate.items.find((item) => item.id === "concrete-bags")?.unitCost === 8.5 &&
      afterCalculate.laborAdjustment === 0,
  );
  const overlayWithExistingPoly = applyBusinessEstimatingDefaults(
    {
      ...victoriaSmall,
      items: [
        ...victoriaSmall.items.filter((item) => item.label !== "Poly Plastic"),
        {
          id: "custom-poly-uuid",
          kind: "custom",
          label: "Poly Plastic",
          unit: "roll",
          optional: true,
          selected: true,
          calculatedQuantity: 1,
          quantityOverride: 1,
          unitCost: 22,
          customerUnitPrice: 35,
          explanation: "Already on this project",
          convertedLineItemId: null,
          persistAs: "business-default",
        },
      ],
    },
    extracted,
    { mode: "overlay" },
  );
  check(
    "Overlay matches reusable custom materials by label/unit, not a prior estimate LineItem id",
    overlayWithExistingPoly.items.filter((item) => item.label === "Poly Plastic").length === 1,
  );
  const fortyRateDefaults = {
    ...extracted,
    labor: { ...extracted.labor, laborRate: 40 },
  };
  const seededForty = applyBusinessEstimatingDefaults(
    { ...victoriaSmallBase, laborRate: 0 },
    fortyRateDefaults,
    { mode: "seed" },
  );
  check(
    "New estimates use the saved business labor rate, not the blank formula starter",
    seededForty.laborRate === 40,
  );
  check(
    "Save confirmation names labor, material prices, and reusable custom materials",
    describeSavedBusinessDefaults(extracted).includes("standard material prices") &&
      describeSavedBusinessDefaults(extracted).includes("2 reusable custom materials") &&
      describeSavedBusinessDefaults(extracted).includes("Concrete Slab"),
  );

  const ownerUser = await prisma.user.create({
    data: { name: "Defaults Owner", email: `def-owner-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Defaults Member", email: `def-member-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Defaults Beta", email: `def-beta-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const businessA = await prisma.business.create({
    data: { name: "Alpha Defaults", slug: `alpha-def-${randomUUID().slice(0, 8)}` },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Defaults Co", slug: `beta-def-${randomUUID().slice(0, 8)}` },
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

  const customerDavid = await prisma.customer.create({
    data: { businessId: businessA.id, name: "David", email: `david-${randomUUID()}@example.com` },
  });
  const customerVictoria = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Victoria", email: `victoria-${randomUUID()}@example.com` },
  });
  const propertyDavid = await prisma.property.create({
    data: {
      businessId: businessA.id,
      customerId: customerDavid.id,
      addressLine1: "10 David St",
      city: "Reno",
      region: "NV",
      postalCode: "89501",
    },
  });
  const propertyVictoria = await prisma.property.create({
    data: {
      businessId: businessA.id,
      customerId: customerVictoria.id,
      addressLine1: "12 Victoria Ave",
      city: "Reno",
      region: "NV",
      postalCode: "89501",
    },
  });
  const catalog = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "Concrete Slab for a Shed",
      pricingMode: "CUSTOM_QUOTE",
      price: null,
      description: "Public catalog row — not the business default store.",
      category: "Concrete",
      active: true,
    },
  });

  async function createConcreteEstimate(input) {
    const request = await prisma.serviceRequest.create({
      data: {
        businessId: input.businessId,
        customerId: input.customerId,
        propertyId: input.propertyId,
        status: "CONVERTED",
        summary: catalog.name,
        description: `${input.who} needs a concrete slab.`,
        serviceCatalogItemId: catalog.id,
        items: {
          create: {
            businessId: input.businessId,
            serviceCatalogItemId: catalog.id,
            quantity: 1,
            sortOrder: 0,
          },
        },
        measurements: {
          create: {
            businessId: input.businessId,
            source: CUSTOMER_REPORTED_MEASUREMENT,
            length: input.lengthFt,
            width: input.widthFt,
            unit: "FT",
          },
        },
      },
    });
    const estimate = await prisma.estimate.create({
      data: {
        businessId: input.businessId,
        customerId: input.customerId,
        propertyId: input.propertyId,
        serviceRequestId: request.id,
        total: new Prisma.Decimal(0),
        publicToken: randomUUID(),
      },
    });
    await prisma.$transaction(async (tx) => {
      await addRequestDraftLines(tx, {
        businessId: input.businessId,
        estimateId: estimate.id,
        items: [
          {
            quantity: 1,
            serviceCatalogItem: {
              id: catalog.id,
              name: catalog.name,
              pricingMode: catalog.pricingMode,
              price: catalog.price,
              description: catalog.description,
            },
          },
        ],
        measurements: [
          {
            catalogItemId: catalog.id,
            source: CUSTOMER_REPORTED_MEASUREMENT,
            width: input.widthFt,
            height: null,
            length: input.lengthFt,
            quantity: null,
            unit: "FT",
          },
        ],
      });
      await persistDraftEstimateTotal(tx, estimate.id, input.businessId);
    });
    await seedDraftTakeoffFromBusinessDefaults(prisma, input.access, {
      estimateId: estimate.id,
    });
    const lines = await prisma.lineItem.findMany({
      where: { estimateId: estimate.id, businessId: input.businessId },
    });
    const labor = lines.find(isOriginalEstimateWorkLine) ?? lines.find((row) => row.type === "LABOR");
    return { request, estimate, labor, lines };
  }

  console.log("\nTEST — Business A saves concrete defaults; David uses them; Victoria does not inherit rounded totals");

  const starter = computeTakeoff({
    takeoffType: "concrete-slab",
    inputs: DAVID_INPUTS,
    wastePercent: 10,
  }).snapshot;
  const pricedStarter = {
    ...starter,
    laborRate: DEFAULT_CONCRETE_60LB_BAG_LABOR_RATE,
    markupPercent: 15,
    items: [
      ...starter.items.map((item) =>
        item.id === "concrete-bags"
          ? { ...item, unitCost: 8.5, customerUnitPrice: 12 }
          : item.id === "wire-mesh"
            ? { ...item, unitCost: 18, customerUnitPrice: 24 }
            : item.id === "form-lumber"
              ? { ...item, unitCost: 9.5, customerUnitPrice: 14 }
              : item.id === "form-stakes"
                ? { ...item, unitCost: 1.25, customerUnitPrice: 2 }
                : item.id === "pickup-procurement"
                  ? { ...item, unitCost: 45, customerUnitPrice: 45 }
                  : item,
      ),
      {
        id: "custom-poly-uuid",
        kind: "custom",
        label: "Poly Plastic",
        unit: "roll",
        optional: true,
        selected: true,
        calculatedQuantity: 1,
        quantityOverride: 1,
        unitCost: 22,
        customerUnitPrice: 35,
        explanation: "Reusable",
        convertedLineItemId: null,
        persistAs: "business-default",
      },
      {
        id: "custom-oil-uuid",
        kind: "custom",
        label: "Vegetable Oil",
        unit: "gal",
        optional: true,
        selected: true,
        calculatedQuantity: 1,
        quantityOverride: 1,
        unitCost: 8,
        customerUnitPrice: 12,
        explanation: "Reusable",
        convertedLineItemId: null,
        persistAs: "business-default",
      },
    ],
  };
  const saved = await saveBusinessEstimatingDefaultsFromTakeoff(prisma, ownerA, {
    workspaceId: "concrete-slab",
    snapshot: pricedStarter,
  });
  check(
    "Business A saved concrete labor rate, waste, markup, bag yield, and material prices",
    saved.labor.laborRate === 36 &&
      saved.material.wastePercent === 10 &&
      saved.material.markupPercent === 15 &&
      saved.material.reusableInputs?.bagYieldCuFt === 0.45 &&
      saved.material.items?.some((item) => item.id === "concrete-bags" && item.unitCost === 8.5) &&
      saved.material.items?.some(
        (item) => item.id === reusableCustomMaterialId("Poly Plastic", "roll"),
      ) &&
      saved.material.items?.some(
        (item) => item.id === reusableCustomMaterialId("Vegetable Oil", "gal"),
      ),
  );

  await expectError(
    "MEMBER cannot save business estimating defaults",
    () =>
      saveBusinessEstimatingDefaultsFromTakeoff(prisma, memberA, {
        workspaceId: "concrete-slab",
        snapshot: pricedStarter,
      }),
    (error) => error instanceof ForbiddenError || error?.name === "ForbiddenError",
  );

  const david = await createConcreteEstimate({
    businessId: businessA.id,
    access: ownerA,
    customerId: customerDavid.id,
    propertyId: propertyDavid.id,
    lengthFt: 10,
    widthFt: 10,
    who: "David",
  });
  const davidTakeoff = lineMaterialTakeoff(david.labor.description);
  const davidSeedBags = davidTakeoff?.items.find((item) => item.id === "concrete-bags");
  check(
    "David's new Concrete Slab estimate preloads reusable defaults, not empty starter prices",
    davidTakeoff?.laborRate === 36 &&
      davidTakeoff?.wastePercent === 10 &&
      davidTakeoff?.markupPercent === 15 &&
      davidTakeoff?.inputs.bagYieldCuFt === 0.45 &&
      davidSeedBags?.unitCost === 8.5 &&
      davidSeedBags?.customerUnitPrice === 12 &&
      davidTakeoff?.items.find((item) => item.id === "wire-mesh")?.unitCost === 18 &&
      davidTakeoff?.items.some((item) => item.label === "Poly Plastic" && item.unitCost === 22) &&
      davidTakeoff?.items.some((item) => item.label === "Vegetable Oil" && item.unitCost === 8) &&
      Number(davidTakeoff?.inputs.lengthFt) === 10 &&
      Number(davidTakeoff?.inputs.widthFt) === 10,
  );

  await saveDraftMaterialTakeoff(prisma, ownerA, {
    estimateId: david.estimate.id,
    lineItemId: david.labor.id,
    snapshot: { ...davidTakeoff, laborAdjustment: 70 },
  });
  check(
    "David's $70 labor add-on stays on the project snapshot and is not written as a business default",
    lineMaterialTakeoff(
      (await prisma.lineItem.findFirst({ where: { id: david.labor.id } })).description,
    )?.laborAdjustment === 70 &&
      (await loadBusinessEstimatingDefaults(prisma, businessA.id, "concrete-slab"))
        ?.labor.laborRate === 36 &&
      JSON.stringify(await loadBusinessEstimatingDefaults(prisma, businessA.id, "concrete-slab")).includes(
        "laborAdjustment",
      ) === false,
  );

  await applyDraftTakeoffRecommendedLabor(prisma, ownerA, {
    estimateId: david.estimate.id,
    lineItemId: david.labor.id,
    snapshot: davidTakeoff,
  });
  await convertDraftMaterialTakeoff(prisma, ownerA, {
    estimateId: david.estimate.id,
    lineItemId: david.labor.id,
    snapshot: snapshotReadyToConvert(davidTakeoff),
  });
  await overrideDraftEstimateLinePrice(prisma, ownerA, {
    estimateId: david.estimate.id,
    lineItemId: david.labor.id,
    unitPrice: "800",
  });
  await setDraftEstimateCustomerMaterialsTotal(prisma, ownerA, {
    estimateId: david.estimate.id,
    amount: "300",
  });
  const davidRounded = await prisma.estimate.findFirst({
    where: { id: david.estimate.id },
    include: { lineItems: true },
  });
  const davidLaborTotal = money(
    davidRounded.lineItems.find((item) => item.id === david.labor.id)?.total ?? 0,
  );
  check(
    "David can round this project to $800 labor / $300 materials without writing those totals as defaults",
    davidLaborTotal === 800 &&
      (await loadBusinessEstimatingDefaults(prisma, businessA.id, "concrete-slab"))
        ?.labor.laborRate === 36,
  );

  const defaultsAfterRound = await loadBusinessEstimatingDefaults(
    prisma,
    businessA.id,
    "concrete-slab",
  );
  check(
    "Rounded $800/$300 stay on David's estimate only",
    defaultsAfterRound?.labor.laborRate === 36 &&
      !JSON.stringify(defaultsAfterRound).includes("800") &&
      !JSON.stringify(defaultsAfterRound).includes('"amount":300'),
  );

  await resetDraftTakeoffAndGeneratedMaterials(prisma, ownerA, {
    estimateId: david.estimate.id,
    lineItemId: david.labor.id,
  });
  check(
    "Resetting David's takeoff does not destroy business defaults",
    (await loadBusinessEstimatingDefaults(prisma, businessA.id, "concrete-slab"))
      ?.labor.laborRate === 36,
  );
  const davidAfterReset = await prisma.lineItem.findFirst({
    where: { id: david.labor.id },
  });
  const resetTakeoff = lineMaterialTakeoff(davidAfterReset.description);
  check(
    "Reset restores reusable default prices onto the recalculated project snapshot",
    resetTakeoff?.laborRate === 36 &&
      resetTakeoff?.items.find((item) => item.id === "concrete-bags")?.unitCost === 8.5,
  );

  const davidRetakeoff = computeTakeoff({
    takeoffType: "concrete-slab",
    inputs: DAVID_INPUTS,
    wastePercent: 10,
    previous: resetTakeoff,
  }).snapshot;
  await applyDraftTakeoffRecommendedLabor(prisma, ownerA, {
    estimateId: david.estimate.id,
    lineItemId: david.labor.id,
    snapshot: davidRetakeoff,
  });
  await convertDraftMaterialTakeoff(prisma, ownerA, {
    estimateId: david.estimate.id,
    lineItemId: david.labor.id,
    snapshot: snapshotReadyToConvert(davidRetakeoff),
  });
  await overrideDraftEstimateLinePrice(prisma, ownerA, {
    estimateId: david.estimate.id,
    lineItemId: david.labor.id,
    unitPrice: "800",
  });
  await setDraftEstimateCustomerMaterialsTotal(prisma, ownerA, {
    estimateId: david.estimate.id,
    amount: "300",
  });

  await prisma.$transaction(async (tx) => {
    await tx.estimate.update({
      where: { id: david.estimate.id },
      data: { status: "SENT" },
    });
    await createEstimateVersionSnapshot(tx, {
      estimateId: david.estimate.id,
      businessId: businessA.id,
    });
  });
  const sentVersion = await prisma.estimateVersion.findFirst({
    where: { estimateId: david.estimate.id, businessId: businessA.id },
    include: { lineItems: true },
  });
  await prisma.estimate.update({
    where: { id: david.estimate.id },
    data: { status: "APPROVED", approvedVersionId: sentVersion.id },
  });
  await prisma.estimateVersion.update({
    where: { id: sentVersion.id },
    data: { approvedAt: new Date() },
  });
  const job = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerDavid.id,
      propertyId: propertyDavid.id,
      estimateId: david.estimate.id,
      approvedEstimateVersionId: sentVersion.id,
      status: "IN_PROGRESS",
      projectToken: randomUUID(),
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: customerDavid.id,
      jobId: job.id,
      status: "SENT",
      total: new Prisma.Decimal(1100),
      lineItems: {
        create: sentVersion.lineItems.map((item) => ({
          businessId: businessA.id,
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          total: item.total,
          type: item.type,
        })),
      },
    },
  });
  const sentLabor = sentVersion.lineItems.find((item) => item.type === "LABOR");
  check(
    "David's SENT snapshot captured the rounded $800 labor",
    money(sentLabor.total) === 800,
  );

  const victoria = await createConcreteEstimate({
    businessId: businessA.id,
    access: ownerA,
    customerId: customerVictoria.id,
    propertyId: propertyVictoria.id,
    lengthFt: 12,
    widthFt: 8,
    who: "Victoria",
  });
  const victoriaTakeoff = lineMaterialTakeoff(victoria.labor.description);
  const victoriaBagsQty = victoriaTakeoff?.items.find((item) => item.id === "concrete-bags")
    ?.calculatedQuantity;
  const davidBagsQty = davidTakeoff?.items.find((item) => item.id === "concrete-bags")
    ?.calculatedQuantity;
  check(
    "Victoria inherits reusable defaults but not David's $800/$300 project totals",
    victoriaTakeoff?.laborRate === 36 &&
      victoriaTakeoff?.wastePercent === 10 &&
      victoriaTakeoff?.markupPercent === 15 &&
      victoriaTakeoff?.laborAdjustment === 0 &&
      victoriaTakeoff?.items.find((item) => item.id === "concrete-bags")?.unitCost === 8.5 &&
      victoriaTakeoff?.items.find((item) => item.id === "wire-mesh")?.customerUnitPrice === 24 &&
      victoriaTakeoff?.items.find((item) => item.id === "pickup-procurement")?.unitCost === 45 &&
      victoriaTakeoff?.items.some((item) => item.label === "Poly Plastic" && item.unitCost === 22) &&
      victoriaTakeoff?.items.some((item) => item.label === "Vegetable Oil" && item.customerUnitPrice === 12) &&
      money(victoria.labor.total) !== 800 &&
      money(victoria.labor.unitPrice) !== 800 &&
      Number(victoriaTakeoff?.inputs.lengthFt) === 12 &&
      Number(victoriaTakeoff?.inputs.widthFt) === 8 &&
      victoriaBagsQty != null &&
      davidBagsQty != null &&
      victoriaBagsQty !== davidBagsQty,
  );

  const throwaway = await createConcreteEstimate({
    businessId: businessA.id,
    access: ownerA,
    customerId: customerDavid.id,
    propertyId: propertyDavid.id,
    lengthFt: 6,
    widthFt: 6,
    who: "Throwaway",
  });
  await prisma.estimate.delete({ where: { id: throwaway.estimate.id } });
  check(
    "Deleting another Concrete Slab estimate does not destroy business defaults",
    (await loadBusinessEstimatingDefaults(prisma, businessA.id, "concrete-slab"))
      ?.labor.laborRate === 36,
  );

  const bDefaults = await loadBusinessEstimatingDefaults(
    prisma,
    businessB.id,
    "concrete-slab",
  );
  check("Business B cannot see Business A's concrete defaults", bDefaults == null);

  await saveBusinessEstimatingDefaultsFromTakeoff(prisma, ownerB, {
    workspaceId: "concrete-slab",
    snapshot: { ...pricedStarter, laborRate: 99 },
  });
  const aAfterB = await loadBusinessEstimatingDefaults(prisma, businessA.id, "concrete-slab");
  const bAfterSave = await loadBusinessEstimatingDefaults(prisma, businessB.id, "concrete-slab");
  check(
    "Business B saving its own defaults leaves Business A unchanged",
    aAfterB?.labor.laborRate === 36 && bAfterSave?.labor.laborRate === 99,
  );

  await saveBusinessEstimatingDefaultsFromTakeoff(prisma, ownerA, {
    workspaceId: "concrete-slab",
    snapshot: { ...pricedStarter, laborRate: 42, markupPercent: 25 },
  });
  const versionAfterChange = await prisma.estimateVersion.findFirst({
    where: { id: sentVersion.id },
    include: { lineItems: true },
  });
  const invoiceAfterChange = await prisma.invoice.findFirst({
    where: { id: invoice.id },
    include: { lineItems: true },
  });
  const liveSent = await prisma.estimate.findFirst({
    where: { id: david.estimate.id },
    include: { lineItems: true },
  });
  const versionTakeoff = lineMaterialTakeoff(
    versionAfterChange.lineItems.find((item) => item.type === "LABOR")?.description,
  );
  check(
    "Changing defaults later does not mutate SENT / APPROVED / invoice snapshots",
    money(versionAfterChange.lineItems.find((item) => item.type === "LABOR")?.total) === 800 &&
      money(invoiceAfterChange.lineItems.find((item) => item.type === "LABOR")?.total) === 800 &&
      money(liveSent.lineItems.find((item) => item.id === david.labor.id)?.total) === 800 &&
      versionTakeoff?.laborRate === 36 &&
      (await loadBusinessEstimatingDefaults(prisma, businessA.id, "concrete-slab"))
        ?.labor.laborRate === 42,
  );

  await prisma.serviceCatalogItem.update({
    where: { id: catalog.id },
    data: { active: false },
  });
  await prisma.serviceCatalogItem.delete({ where: { id: catalog.id } });
  check(
    "Catalog deletion does not remove business estimating defaults",
    (await loadBusinessEstimatingDefaults(prisma, businessA.id, "concrete-slab"))
      ?.labor.laborRate === 42 &&
      resolveEstimatingWorkspace({ titles: ["Concrete Slab for a Shed"] })?.id ===
        "concrete-slab",
  );

  check(
    "Parsed payload rejects a workspace from another tenant blob",
    parseBusinessEstimatingDefaultPayload(
      JSON.stringify({ version: 1, workspaceId: "not-a-workspace", labor: { laborRate: 36 } }),
    ) == null,
  );
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
}

console.log(
  failures === 0
    ? "\nAll estimating-business-defaults checks passed."
    : `\n${failures} estimating-business-defaults check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);

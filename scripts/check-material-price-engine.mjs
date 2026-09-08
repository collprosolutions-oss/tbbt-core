/**
 * Material Price Engine: provider abstraction, mappings, freshness,
 * business isolation, explicit draft apply, no silent overwrite,
 * markup separation, snapshot freeze, and customer privacy.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-material-price-engine.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { persistDraftEstimateTotal } = await import("@/lib/labor-minimum");
const { createEstimateVersionSnapshot } = await import("@/lib/estimate-version");
const { isOriginalEstimateWorkLine, lineMaterialTakeoff } = await import(
  "@/lib/estimate-line-scope"
);
const { addRequestDraftLines } = await import("@/lib/request-estimate-draft");
const { CUSTOMER_REPORTED_MEASUREMENT } = await import("@/lib/catalog-intake");
const { computeTakeoff, saveDraftMaterialTakeoff } = await import(
  "@/lib/material-takeoff"
);
const { applyBusinessEstimatingDefaults, startingTakeoffDraftWithDefaults } =
  await import("@/lib/estimating-defaults");
const {
  saveBusinessEstimatingDefaultsFromTakeoff,
} = await import("@/lib/estimating-defaults-db");
const { applyCurrentSupplierPriceToDraftItem } = await import(
  "@/lib/material-pricing/apply"
);
const { classifySupplierPriceFreshness, describeSupplierPriceCheck } =
  await import("@/lib/material-pricing/freshness");
const { buildOwnerSupplierPricingBoard } = await import(
  "@/lib/material-pricing/engine"
);
const { getSupplierProvider, HOME_DEPOT_LIVE_UNAVAILABLE, LOWES_NOT_IMPLEMENTED } =
  await import("@/lib/material-pricing/registry");
const { HOME_DEPOT_CATALOG, HOME_DEPOT_CONCRETE_SLAB_MAPPINGS } = await import(
  "@/lib/material-pricing/home-depot"
);
const {
  applyCurrentSupplierPriceToDraft,
  loadOwnerSupplierPricingBoard,
  refreshSupplierPrices,
  saveSupplierPreference,
} = await import("@/lib/material-pricing/db");
const { publicCustomerMaterialView, customerMaterialViewLeaksInternalPricing } =
  await import("@/lib/material-pricing/privacy");
const { calculatorMaterialIdentity, materialSupportsSupplierProduct } =
  await import("@/lib/material-pricing/identities");
const { markedUpCustomerUnitPrice } = await import("@/lib/material-takeoff/types");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_material_price_engine_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for material-price-engine test database.");
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

try {
  console.log("\nSTATIC — Provider-neutral architecture and customer privacy");
  const schema = readRepo("prisma/schema.prisma");
  const form = readRepo("src/components/estimates/material-takeoff-form.tsx");
  const panel = readRepo("src/components/estimates/supplier-pricing-panel.tsx");
  const ownerPage = readRepo("src/app/(app)/estimates/[estimateId]/page.tsx");
  const customerPage = readRepo("src/app/e/[token]/page.tsx");
  const customerLines = readRepo(
    "src/components/estimates/customer-estimate-line-sections.tsx",
  );
  const invoiceDoc = readRepo("src/lib/invoice-document.ts");
  const portal = readRepo("src/app/p/[token]/page.tsx");
  const engine = readRepo("src/lib/material-pricing/engine.ts");
  const hd = readRepo("src/lib/material-pricing/home-depot.ts");
  const registry = readRepo("src/lib/material-pricing/registry.ts");

  check(
    "Supplier tables are business-scoped and separate from estimating defaults",
    schema.includes("model BusinessSupplierPreference") &&
      schema.includes("model BusinessMaterialSupplierMapping") &&
      schema.includes("model SupplierPriceRecord") &&
      schema.includes("@@unique([businessId, providerId, materialIdentity])") &&
      schema.includes("model BusinessEstimatingDefault"),
  );
  check(
    "Home Depot is an adapter, not hardcoded into the estimator",
    registry.includes("home-depot") &&
      registry.includes("lowes") &&
      engine.includes("getSupplierProvider") &&
      !readRepo("src/lib/material-takeoff/formulas/concrete-slab.ts").includes(
        "Home Depot",
      ) &&
      !readRepo("src/lib/estimating-defaults.ts").includes("home-depot"),
  );
  check(
    "Home Depot adapter does not scrape and reports the live-API limitation",
    !hd.includes("cheerio") &&
      !hd.includes("puppeteer") &&
      hd.includes("never scrapes") &&
      registry.includes("HOME_DEPOT_LIVE_UNAVAILABLE") &&
      hd.includes("catalog-reference"),
  );
  check(
    "Owner UI shows saved vs supplier price and Use current price",
    panel.includes("Saved cost:") &&
      panel.includes("Current supplier price:") &&
      panel.includes("Use current price") &&
      form.includes("SupplierPricingPanel") &&
      form.includes("Save as business default"),
  );
  check(
    "Customer estimate, invoice, and portal do not render supplier internals",
    !customerPage.includes("Use current price") &&
      !customerPage.includes("Home Depot") &&
      !customerPage.includes("supplierUnitCost") &&
      !customerLines.includes("unitCost") &&
      customerLines.includes("CompactCustomerMaterialList") &&
      !invoiceDoc.includes("supplierUnitCost") &&
      !portal.includes("Use current price") &&
      ownerPage.includes("supplierPricing"),
  );

  const homeDepot = getSupplierProvider("home-depot");
  const lowes = getSupplierProvider("lowes");
  check(
    "Provider registry returns Home Depot implemented and Lowe’s stubbed",
    homeDepot.id === "home-depot" &&
      homeDepot.implemented &&
      !homeDepot.liveApiAvailable &&
      homeDepot.limitation === HOME_DEPOT_LIVE_UNAVAILABLE &&
      lowes.id === "lowes" &&
      !lowes.implemented &&
      lowes.limitation === LOWES_NOT_IMPLEMENTED,
  );
  check(
    "Concrete slab suggested mappings cover standard items and skip pickup",
    HOME_DEPOT_CONCRETE_SLAB_MAPPINGS.map((row) => row.materialIdentity).join(",") ===
      "concrete-bags,wire-mesh,form-lumber,form-stakes,anchor-hardware,sill-gasket" &&
      !HOME_DEPOT_CONCRETE_SLAB_MAPPINGS.some(
        (row) => row.materialIdentity === "pickup-procurement",
      ) &&
      HOME_DEPOT_CATALOG["202080829"].catalogUnitPrice === 6.47,
  );

  const now = new Date("2026-09-08T17:00:00.000Z");
  check(
    "Freshness: current / recently checked / stale / unavailable",
    classifySupplierPriceFreshness(now, now) === "current" &&
      classifySupplierPriceFreshness(
        new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
        now,
      ) === "recently_checked" &&
      classifySupplierPriceFreshness(
        new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
        now,
      ) === "stale" &&
      classifySupplierPriceFreshness(null, now) === "unavailable" &&
      describeSupplierPriceCheck(now, now) === "Checked today",
  );

  const nineBagSnapshot = computeTakeoff({
    takeoffType: "concrete-slab",
    inputs: {
      lengthFt: 4,
      widthFt: 2.5,
      thicknessIn: 4,
      bagSizeLb: 60,
      bagYieldCuFt: 0.45,
      includeWireMesh: true,
      includeFormLumber: true,
      includePickup: true,
    },
    wastePercent: 10,
  }).snapshot;
  const bags = nineBagSnapshot.items.find((item) => item.id === "concrete-bags");
  check(
    "4 ft × 2.5 ft × 4 in at 10% waste identifies 9 × 60-lb bags",
    bags?.calculatedQuantity === 9 && bags.label.includes("60-lb"),
  );
  check(
    "Pickup is not a supplier product; bags are a stable calculator identity",
    calculatorMaterialIdentity(bags) === "concrete-bags" &&
      materialSupportsSupplierProduct(bags) &&
      !materialSupportsSupplierProduct(
        nineBagSnapshot.items.find((item) => item.id === "pickup-procurement"),
      ),
  );

  const catalogBoard = buildOwnerSupplierPricingBoard({
    snapshot: nineBagSnapshot,
    mappings: [],
    prices: [],
  });
  const bagRow = catalogBoard.rows.find((row) => row.itemId === "concrete-bags");
  const pickupRow = catalogBoard.rows.find(
    (row) => row.itemId === "pickup-procurement",
  );
  check(
    "Catalog fallback maps 60-lb bags at $6.47 without writing the draft",
    bagRow?.mappingStatus === "mapped" &&
      bagRow?.supplierUnitCost === 6.47 &&
      bagRow?.canUseCurrentPrice &&
      bags?.unitCost == null &&
      pickupRow?.mappingStatus === "not-a-product" &&
      pickupRow?.canUseCurrentPrice === false,
  );

  const savedDraft = {
    ...nineBagSnapshot,
    markupPercent: 20,
    items: nineBagSnapshot.items.map((item) =>
      item.id === "concrete-bags" ? { ...item, unitCost: 6.29 } : item,
    ),
  };
  const applied = applyCurrentSupplierPriceToDraftItem(
    savedDraft,
    "concrete-bags",
    6.47,
  );
  const appliedBags = applied.items.find((item) => item.id === "concrete-bags");
  check(
    "Use current price feeds internal cost; 20% markup calculates customer price",
    appliedBags?.unitCost === 6.47 &&
      appliedBags?.customerUnitPrice === markedUpCustomerUnitPrice(6.47, 20) &&
      markedUpCustomerUnitPrice(6.47, 20) === 7.76 &&
      savedDraft.items.find((item) => item.id === "concrete-bags")?.unitCost === 6.29,
  );
  const noMarkupApply = applyCurrentSupplierPriceToDraftItem(
    { ...savedDraft, markupPercent: 0, items: savedDraft.items.map((item) => ({ ...item, customerUnitPrice: 9.99 })) },
    "concrete-bags",
    6.47,
  );
  check(
    "Zero markup preserves owner customer-price override",
    noMarkupApply.items.find((item) => item.id === "concrete-bags")?.unitCost === 6.47 &&
      noMarkupApply.items.find((item) => item.id === "concrete-bags")?.customerUnitPrice === 9.99,
  );

  const seeded = startingTakeoffDraftWithDefaults({
    takeoffType: "concrete-slab",
    suggestedInputs: savedDraft.inputs,
    businessDefaults: {
      version: 1,
      workspaceId: "concrete-slab",
      labor: {},
      material: {
        items: [{ id: "concrete-bags", kind: "concrete-bags", unitCost: 6.29, customerUnitPrice: 7.55 }],
      },
    },
  });
  check(
    "New drafts seed business default cost, not a silent supplier overwrite",
    seeded.items.find((item) => item.id === "concrete-bags")?.unitCost === 6.29 &&
      applyBusinessEstimatingDefaults(nineBagSnapshot, {
        version: 1,
        workspaceId: "concrete-slab",
        labor: {},
        material: {
          items: [{ id: "concrete-bags", kind: "concrete-bags", unitCost: 6.29, customerUnitPrice: 7.55 }],
        },
      }).items.find((item) => item.id === "concrete-bags")?.unitCost === 6.29,
  );

  const publicView = publicCustomerMaterialView({
    description: "60-lb concrete bags",
    quantityLabel: "9",
  });
  check(
    "Customer material view is description + qty only",
    publicView.description === "60-lb concrete bags" &&
      publicView.quantityLabel === "9" &&
      Object.keys(publicView).length === 2 &&
      !customerMaterialViewLeaksInternalPricing(publicView),
  );

  const ownerUser = await prisma.user.create({
    data: { name: "Price Owner", email: `price-owner-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Price Beta", email: `price-beta-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const businessA = await prisma.business.create({
    data: { name: "Alpha Pricing", slug: `alpha-price-${randomUUID().slice(0, 8)}` },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Pricing", slug: `beta-price-${randomUUID().slice(0, 8)}` },
  });
  const membershipA = await prisma.membership.create({
    data: { businessId: businessA.id, userId: ownerUser.id, role: "OWNER" },
  });
  const membershipB = await prisma.membership.create({
    data: { businessId: businessB.id, userId: betaUser.id, role: "OWNER" },
  });
  const ownerA = makeAccess(businessA.id, "OWNER", membershipA.id);
  const ownerB = makeAccess(businessB.id, "OWNER", membershipB.id);

  console.log("\nTEST — Business isolation, draft apply, freeze");

  await saveSupplierPreference(prisma, ownerA, {
    providerId: "home-depot",
    locationZip: "33901",
    locationLabel: "Fort Myers, FL",
  });
  const refreshed = await refreshSupplierPrices(prisma, ownerA, {
    providerId: "home-depot",
  });
  check(
    "Refresh stores catalog-reference prices and does not claim a live API",
    refreshed.quotes.some(
      (quote) => quote.productId === "202080829" && quote.currentPrice === 6.47,
    ) &&
      refreshed.quotes.every((quote) => quote.sourceMode === "catalog-reference") &&
      !homeDepot.liveApiAvailable,
  );

  const aBoard = await loadOwnerSupplierPricingBoard(prisma, {
    businessId: businessA.id,
    businessSlug: businessA.slug,
    snapshot: savedDraft,
  });
  const bBoard = await loadOwnerSupplierPricingBoard(prisma, {
    businessId: businessB.id,
    businessSlug: businessB.slug,
    snapshot: savedDraft,
  });
  const aBags = aBoard.rows.find((row) => row.itemId === "concrete-bags");
  const bStored = await prisma.businessMaterialSupplierMapping.findMany({
    where: { businessId: businessB.id },
  });
  const aStored = await prisma.businessMaterialSupplierMapping.findMany({
    where: { businessId: businessA.id },
  });
  check(
    "Business A mappings persist; Business B cannot read them by querying its own scope",
    aStored.some((row) => row.materialIdentity === "concrete-bags") &&
      bStored.length === 0 &&
      aBags?.savedUnitCost === 6.29 &&
      aBags?.supplierUnitCost === 6.47,
  );
  check(
    "Business B board does not include Business A stored SKUs",
    !bBoard.rows.some((row) => row.supplierSku === "167900" && row.checkedAt != null),
  );

  const customer = await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: "David",
      email: `david-price-${randomUUID()}@example.com`,
    },
  });
  const property = await prisma.property.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      addressLine1: "10 David St",
      city: "Fort Myers",
      region: "FL",
      postalCode: "33901",
    },
  });
  const catalog = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "Concrete Slab for a Shed",
      pricingMode: "CUSTOM_QUOTE",
      price: null,
      active: true,
    },
  });
  const request = await prisma.serviceRequest.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      propertyId: property.id,
      status: "CONVERTED",
      summary: catalog.name,
      description: "Concrete slab",
      serviceCatalogItemId: catalog.id,
    },
  });
  const estimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      propertyId: property.id,
      serviceRequestId: request.id,
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  await prisma.$transaction(async (tx) => {
    await addRequestDraftLines(tx, {
      businessId: businessA.id,
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
          width: 2.5,
          height: null,
          length: 4,
          quantity: null,
          unit: "FT",
        },
      ],
    });
    await persistDraftEstimateTotal(tx, estimate.id, businessA.id);
  });
  const labor = (await prisma.lineItem.findMany({ where: { estimateId: estimate.id } })).find(
    isOriginalEstimateWorkLine,
  );
  await saveDraftMaterialTakeoff(prisma, ownerA, {
    estimateId: estimate.id,
    lineItemId: labor.id,
    snapshot: savedDraft,
  });
  const beforeApply = lineMaterialTakeoff(
    (await prisma.lineItem.findFirst({ where: { id: labor.id } })).description,
  );
  check(
    "Saving takeoff does not copy supplier catalog onto unit cost",
    beforeApply.items.find((item) => item.id === "concrete-bags")?.unitCost === 6.29,
  );

  const appliedDraft = await applyCurrentSupplierPriceToDraft(prisma, ownerA, {
    estimateId: estimate.id,
    lineItemId: labor.id,
    itemId: "concrete-bags",
    snapshot: savedDraft,
  });
  const afterApply = lineMaterialTakeoff(
    (await prisma.lineItem.findFirst({ where: { id: labor.id } })).description,
  );
  check(
    "Explicit Use current price updates DRAFT internal cost and markup selling price",
    appliedDraft.appliedCost === 6.47 &&
      afterApply.items.find((item) => item.id === "concrete-bags")?.unitCost === 6.47 &&
      afterApply.items.find((item) => item.id === "concrete-bags")?.customerUnitPrice === 7.76,
  );

  await saveBusinessEstimatingDefaultsFromTakeoff(prisma, ownerA, {
    workspaceId: "concrete-slab",
    snapshot: {
      ...afterApply,
      items: afterApply.items.map((item) =>
        item.id === "concrete-bags"
          ? { ...item, unitCost: 6.47, persistAs: "business-default" }
          : item,
      ),
    },
  });
  const { loadBusinessEstimatingDefaults } = await import(
    "@/lib/estimating-defaults-db"
  );
  const savedDefaults = await loadBusinessEstimatingDefaults(
    prisma,
    businessA.id,
    "concrete-slab",
  );
  const futureDraft = startingTakeoffDraftWithDefaults({
    takeoffType: "concrete-slab",
    suggestedInputs: {
      lengthFt: 5,
      widthFt: 5,
      thicknessIn: 4,
      bagSizeLb: 60,
      bagYieldCuFt: 0.45,
    },
    businessDefaults: savedDefaults,
  });
  check(
    "Future estimates reuse the saved business default after a deliberate save",
    futureDraft.items.find((item) => item.id === "concrete-bags")?.unitCost === 6.47 &&
      savedDefaults?.material.items?.some(
        (item) => item.id === "concrete-bags" && item.unitCost === 6.47,
      ),
  );

  const frozenCost = afterApply.items.find((item) => item.id === "concrete-bags")?.unitCost;
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
  const sentVersion = await prisma.estimateVersion.findFirst({
    where: { estimateId: estimate.id, businessId: businessA.id },
  });
  await prisma.estimate.update({
    where: { id: estimate.id },
    data: { status: "APPROVED", approvedVersionId: sentVersion.id },
  });
  const approvedLines = await prisma.lineItem.findMany({
    where: { estimateId: estimate.id },
  });
  const approvedTakeoff = lineMaterialTakeoff(
    approvedLines.find(isOriginalEstimateWorkLine).description,
  );
  await expectError(
    "Approved estimates reject Use current price",
    () =>
      applyCurrentSupplierPriceToDraft(prisma, ownerA, {
        estimateId: estimate.id,
        lineItemId: labor.id,
        itemId: "concrete-bags",
        snapshot: {
          ...approvedTakeoff,
          items: approvedTakeoff.items.map((item) =>
            item.id === "concrete-bags" ? { ...item, unitCost: 99 } : item,
          ),
        },
      }),
    (error) =>
      error instanceof Error &&
      (error.message.includes("draft") || error.name === "EstimateLineError"),
  );
  const stillFrozen = lineMaterialTakeoff(
    (await prisma.lineItem.findFirst({ where: { id: labor.id } })).description,
  );
  check(
    "Approved/job snapshot unit cost stays frozen after a refused supplier apply",
    stillFrozen.items.find((item) => item.id === "concrete-bags")?.unitCost === frozenCost &&
      frozenCost === 6.47,
  );

  await expectError(
    "Business B cannot apply prices onto Business A’s draft (record not in workspace)",
    () =>
      applyCurrentSupplierPriceToDraft(prisma, ownerB, {
        estimateId: estimate.id,
        lineItemId: labor.id,
        itemId: "concrete-bags",
        snapshot: savedDraft,
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes("authorized business workspace"),
  );

  const bDefaults = await loadBusinessEstimatingDefaults(
    prisma,
    businessB.id,
    "concrete-slab",
  );
  check("Business B does not inherit Business A estimating defaults", bDefaults == null);
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
}

console.log(
  failures === 0
    ? "\nAll material-price-engine checks passed."
    : `\n${failures} material-price-engine check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);

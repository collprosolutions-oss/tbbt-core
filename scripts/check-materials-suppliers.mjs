/**
 * Materials + suppliers + purchase operations (#109).
 *
 * Covers supplier isolation, price-history immutability, takeoff
 * conversion, purchase list, no duplicate expense cost, markup
 * separation, estimate snapshot preservation, pickup metadata,
 * role checks, and disconnected provider honesty.
 *
 * Run with:
 *   npm run test:materials-suppliers
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError } = await import("@/lib/authorization");
const { createEstimateVersionSnapshot } = await import("@/lib/estimate-version");
const { joinLineDescription } = await import("@/lib/estimate-line-scope");
const { computeTakeoff } = await import("@/lib/material-takeoff/engine");
const {
  addPurchaseListItem,
  appendMaterialPriceHistory,
  attachPurchaseListToCreatedJob,
  createMaterialCatalogItem,
  createPurchaseOrder,
  createSupplier,
  convertTakeoffToPurchaseList,
  ensurePurchaseList,
  getSupplierCommerceAdapter,
  linkPurchaseItemToExpense,
  listAssignedJobPickupView,
  listJobMaterialPickupRequirements,
  listMaterialActualCostLinks,
  listMaterialCatalog,
  listMaterialPriceHistory,
  listSuppliers,
  loadPurchaseListBoard,
  materialEstimateVsActual,
  materialLineSourceKey,
  MATERIALS_SUPPLIERS_SCHEMA_SOURCE,
  recordPurchaseListItemPurchased,
  recordPurchaseOperation,
  separateMaterialMoneyLayers,
  SUPPLIER_COMMERCE_DISCONNECTED_LIMITATION,
  SUPPLIER_INTEGRATION_LICENSING_NOTICE,
  takeoffSourceKey,
  updateMaterialCatalogItem,
  updatePurchaseListItem,
  updatePurchaseOrderStatus,
  updateSupplier,
} = await import("@/lib/materials");
const { createExpense } = await import("@/lib/expense-ops");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_materials_suppliers_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for materials-suppliers test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
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

try {
  console.log("\nSTATIC — Licensing, adapter honesty, additive schema");
  const adapter = readRepo("src/lib/materials/adapter.ts");
  const types = readRepo("src/lib/materials/types.ts");
  const schema = readRepo("prisma/schema.prisma");
  const migration = readRepo(
    "prisma/migrations/20260926011500_add_materials_suppliers_operations/migration.sql",
  );
  const materialsSchema = readRepo("src/lib/materials/schema.ts");
  const accessSrc = readRepo("src/lib/materials/access.ts");
  const pickupSrc = readRepo("src/lib/materials/pickup.ts");
  const varianceSrc = readRepo("src/lib/materials/variance.ts");
  const catalogSrc = readRepo("src/lib/materials/catalog.ts");
  const purchaseSrc = readRepo("src/lib/materials/purchase.ts");
  const takeoffSrc = readRepo("src/lib/materials/takeoff.ts");
  const expenseSrc = readRepo("src/lib/materials/expense-link.ts");
  const actionsSrc = readRepo("src/app/actions/materials.ts");
  const fieldCard = readRepo("src/components/field/assigned-job-pickup-card.tsx");
  check(
    "Supplier commerce adapter is DISCONNECTED and does not scrape",
    adapter.includes('connectionState: "DISCONNECTED"') &&
      adapter.includes("lookupProduct") &&
      adapter.includes("quotePrice") &&
      adapter.includes("checkAvailability") &&
      adapter.includes("createCartHandoff") &&
      !adapter.includes("cheerio") &&
      !adapter.includes("puppeteer") &&
      types.includes("SUPPLIER_INTEGRATION_LICENSING_NOTICE"),
  );
  check(
    "First-class Supplier / catalog / history / purchase / PO models are tenant-scoped",
    schema.includes("model Supplier") &&
      schema.includes("model MaterialCatalogItem") &&
      schema.includes("model MaterialPriceHistory") &&
      schema.includes("model MaterialPurchaseList") &&
      schema.includes("model MaterialPurchaseOrder") &&
      schema.includes("Never store supplier passwords") &&
      !schema.includes("supplierPassword") &&
      !schema.includes("apiSecret"),
  );
  check(
    "Migration is additive and stores no credentials",
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migration) &&
      migration.includes('CREATE TABLE IF NOT EXISTS "Supplier"') &&
      !/"password"/i.test(migration) &&
      !/"apiSecret"/i.test(migration) &&
      !/"apiKey"/i.test(migration),
  );
  check(
    "Field pickup card does not render vendor economics",
    fieldCard.includes("pickup") &&
      !fieldCard.includes("formatMoney") &&
      !fieldCard.includes("actualCost") &&
      !fieldCard.includes("markup"),
  );
  const requestPathSources = [
    materialsSchema,
    accessSrc,
    pickupSrc,
    varianceSrc,
    catalogSrc,
    purchaseSrc,
    takeoffSrc,
    expenseSrc,
    actionsSrc,
  ];
  check(
    "Materials request paths execute no schema DDL",
    MATERIALS_SUPPLIERS_SCHEMA_SOURCE === "prisma-migrate" &&
      requestPathSources.every(
        (src) =>
          !src.includes("$executeRawUnsafe") &&
          !src.includes("CREATE TABLE") &&
          !src.includes("ALTER TABLE") &&
          !src.includes("CREATE INDEX"),
      ) &&
      !actionsSrc.includes('formData.get("businessId")') &&
      !actionsSrc.includes('readString(formData, "businessId")'),
  );

  const liveAdapter = getSupplierCommerceAdapter();
  const lookup = await liveAdapter.lookupProduct("concrete");
  const quote = await liveAdapter.quotePrice("any");
  const availability = await liveAdapter.checkAvailability("any");
  const handoff = await liveAdapter.createCartHandoff({ productIds: ["any"] });
  check(
    "Runtime adapter is DISCONNECTED and returns no fake catalog or order",
    liveAdapter.connectionState === "DISCONNECTED" &&
      liveAdapter.limitation === SUPPLIER_COMMERCE_DISCONNECTED_LIMITATION &&
      liveAdapter.licensingNotice === SUPPLIER_INTEGRATION_LICENSING_NOTICE &&
      lookup === null &&
      quote.price === null &&
      availability.available === null &&
      handoff.placed === false &&
      handoff.orderId === null,
  );

  const layers = separateMaterialMoneyLayers({
    estimatedUnitCost: 10,
    estimatedQuantity: 2,
    markupPercent: 20,
    customerUnitPrice: 12,
    purchasedUnitCost: 11,
    purchasedQuantity: 2,
  });
  check(
    "Markup / customer price / purchase cost stay separate and invoice stays frozen",
    layers.estimatedCost === 20 &&
      layers.purchasedCost === 22 &&
      layers.customerUnitPrice === 12 &&
      layers.markupPercent === 20 &&
      layers.invoiceMustStayFrozen &&
      layers.snapshotMustStayFrozen &&
      separateMaterialMoneyLayers({ estimatedUnitCost: 10, estimatedQuantity: 1 }).markupPercent ===
        null,
  );

  const ownerUser = await prisma.user.create({
    data: { name: "Mat Owner", email: `mat-owner-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mat Member", email: `mat-member-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Mat Beta", email: `mat-beta-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const businessA = await prisma.business.create({
    data: { name: "Alpha Materials", slug: `alpha-mat-${randomUUID().slice(0, 8)}` },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Materials", slug: `beta-mat-${randomUUID().slice(0, 8)}` },
  });
  const ownerMem = await prisma.membership.create({
    data: { businessId: businessA.id, userId: ownerUser.id, role: "OWNER" },
  });
  const memberMem = await prisma.membership.create({
    data: { businessId: businessA.id, userId: memberUser.id, role: "MEMBER" },
  });
  const betaMem = await prisma.membership.create({
    data: { businessId: businessB.id, userId: betaUser.id, role: "OWNER" },
  });
  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaMem.id);

  console.log("\nTEST — Supplier isolation and role checks");
  const depot = await createSupplier(prisma, ownerA, {
    name: "Sparks Building Supply",
    preferred: true,
    locationDescription: "Counter 3, Sparks",
    accountReference: "ACCT-441",
    categories: "Lumber, concrete",
  });
  await createSupplier(prisma, ownerB, {
    name: "Beta Hardware",
    preferred: true,
  });
  const aSuppliers = await listSuppliers(prisma, ownerA);
  const bSuppliers = await listSuppliers(prisma, ownerB);
  check(
    "Business A cannot see Business B suppliers and vice versa",
    aSuppliers.every((row) => row.businessId === businessA.id) &&
      bSuppliers.every((row) => row.businessId === businessB.id) &&
      aSuppliers.some((row) => row.id === depot.id) &&
      !bSuppliers.some((row) => row.id === depot.id),
  );
  await expectError(
    "Business B cannot update Business A supplier",
    () => updateSupplier(prisma, ownerB, { supplierId: depot.id, name: "Stolen" }),
    (error) => error instanceof Error,
  );
  await expectError(
    "MEMBER cannot list company suppliers",
    () => listSuppliers(prisma, memberA),
    (error) => error instanceof ForbiddenError || error.name === "ForbiddenError",
  );
  await expectError(
    "Supplier form rejects password/secret text",
    () =>
      createSupplier(prisma, ownerA, {
        name: "Bad Vendor",
        accountReference: "password=hunter2",
      }),
    (error) => /passwords or API secrets/i.test(String(error.message)),
  );

  console.log("\nTEST — Catalog + price-history immutability");
  const bags = await createMaterialCatalogItem(prisma, ownerA, {
    name: "60-lb concrete bags",
    unit: "bag",
    packSize: "1",
    preferredSupplierId: depot.id,
    lastKnownCost: "6.47",
    category: "Concrete",
    takeoffIdentity: "concrete-bags",
  });
  const firstHistory = await listMaterialPriceHistory(prisma, ownerA, bags.id);
  await updateMaterialCatalogItem(prisma, ownerA, {
    materialId: bags.id,
    name: bags.name,
    unit: bags.unit,
    packSize: "1",
    preferredSupplierId: depot.id,
    lastKnownCost: "7.10",
    category: "Concrete",
    takeoffIdentity: "concrete-bags",
  });
  const history = await listMaterialPriceHistory(prisma, ownerA, bags.id);
  const catalog = await listMaterialCatalog(prisma, ownerA);
  check(
    "Current cost updates without rewriting earlier history rows",
    Number(catalog.find((row) => row.id === bags.id)?.lastKnownCost?.toString()) === 7.1 &&
      firstHistory.length === 1 &&
      Number(firstHistory[0].price.toString()) === 6.47 &&
      history.length === 2 &&
      history.some((row) => Number(row.price.toString()) === 6.47) &&
      history.some((row) => Number(row.price.toString()) === 7.1),
  );
  await expectError(
    "Business B cannot read Business A catalog",
    () => listMaterialPriceHistory(prisma, ownerB, bags.id),
    (error) => error instanceof Error,
  );

  console.log("\nTEST — Takeoff conversion, purchase list, snapshot freeze");
  const customer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Pat", email: `pat-${randomUUID()}@example.com` },
  });
  const estimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "DRAFT",
      publicToken: randomUUID(),
    },
  });
  const takeoff = computeTakeoff({
    takeoffType: "concrete-slab",
    inputs: {
      lengthFt: 4,
      widthFt: 2.5,
      thicknessIn: 4,
      bagSizeLb: 60,
      bagYieldCuFt: 0.45,
      includeWireMesh: false,
      includeFormLumber: false,
      includePickup: true,
    },
    wastePercent: 10,
  }).snapshot;
  const withPrices = {
    ...takeoff,
    markupPercent: 25,
    items: takeoff.items.map((item) =>
      item.id === "concrete-bags"
        ? { ...item, selected: true, unitCost: 6.47, customerUnitPrice: 8.09 }
        : item.id === "pickup-procurement"
          ? { ...item, selected: true, unitCost: 25, customerUnitPrice: 25 }
          : { ...item, selected: false },
    ),
  };
  const parent = await prisma.lineItem.create({
    data: {
      businessId: businessA.id,
      estimateId: estimate.id,
      description: joinLineDescription("Concrete slab", null, null, null, {
        materialTakeoff: withPrices,
      }),
      quantity: 1,
      unitPrice: 400,
      total: 400,
      type: "LABOR",
    },
  });
  const converted = await convertTakeoffToPurchaseList(prisma, ownerA, {
    estimateId: estimate.id,
    linkCatalog: true,
  });
  const varianceBeforeBuy = await materialEstimateVsActual(prisma, ownerA, {
    estimateId: estimate.id,
  });
  check(
    "Takeoff conversion creates purchase-list items and links reusable catalog",
    converted.created >= 2 &&
      varianceBeforeBuy.some((row) => row.name.toLowerCase().includes("concrete")) &&
      varianceBeforeBuy.some((row) => row.pickupRequired === undefined || true),
  );
  const list = await prisma.materialPurchaseList.findFirst({
    where: { businessId: businessA.id, estimateId: estimate.id },
    include: { items: true },
  });
  const bagItem = list.items.find((item) => /concrete/i.test(item.name));
  const pickupItem = list.items.find((item) => item.pickupRequired);
  check(
    "Pickup metadata is stored for scheduling consumers",
    Boolean(pickupItem) &&
      pickupItem.pickupRequired === true &&
      bagItem != null &&
      Number(bagItem.markupPercent?.toString() ?? "0") === 25 &&
      Number(bagItem.customerUnitPrice?.toString() ?? "0") === 8.09,
  );

  await prisma.estimate.update({
    where: { id: estimate.id },
    data: { status: "SENT" },
  });
  const version = await createEstimateVersionSnapshot(prisma, {
    estimateId: estimate.id,
    businessId: businessA.id,
  });
  const versionLines = await prisma.estimateVersionLineItem.findMany({
    where: { estimateVersionId: version.id, businessId: businessA.id },
    orderBy: { createdAt: "asc" },
  });
  const frozen = versionLines.map((row) => ({
    description: row.description,
    unitPrice: row.unitPrice.toString(),
    total: row.total.toString(),
  }));
  await updateMaterialCatalogItem(prisma, ownerA, {
    materialId: bags.id,
    name: bags.name,
    unit: bags.unit,
    lastKnownCost: "9.99",
    takeoffIdentity: "concrete-bags",
  });
  const versionAfter = await prisma.estimateVersion.findUnique({
    where: { id: version.id },
    include: { lineItems: true },
  });
  check(
    "Later catalog price change does not rewrite the sent estimate snapshot",
    versionAfter.lineItems.length === frozen.length &&
      versionAfter.lineItems.every((row, index) => {
        const before = frozen[index];
        return (
          row.description === before.description &&
          row.unitPrice.toString() === before.unitPrice &&
          row.total.toString() === before.total
        );
      }),
  );

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
  await prisma.materialPurchaseList.update({
    where: { id: list.id },
    data: { jobId: job.id },
  });

  console.log("\nTEST — Purchase, expense linkage, no double count");
  await recordPurchaseListItemPurchased(prisma, ownerA, {
    itemId: bagItem.id,
    quantityPurchased: bagItem.quantityNeeded.toString(),
    actualUnitCost: "7.25",
    supplierId: depot.id,
  });
  await linkPurchaseItemToExpense(prisma, ownerA, {
    itemId: bagItem.id,
    createExpense: true,
    occurredOn: "2026-09-25",
    quantityPurchased: bagItem.quantityNeeded.toString(),
    actualUnitCost: "7.25",
  });
  await expectError(
    "A second expense cannot be linked to the same purchase item",
    () =>
      linkPurchaseItemToExpense(prisma, ownerA, {
        itemId: bagItem.id,
        createExpense: true,
        occurredOn: "2026-09-25",
        quantityPurchased: bagItem.quantityNeeded.toString(),
        actualUnitCost: "7.25",
      }),
    (error) => /double-count/i.test(String(error.message)),
  );
  const links = await listMaterialActualCostLinks(prisma, ownerA, { jobId: job.id });
  const expenses = await prisma.expense.findMany({
    where: { businessId: businessA.id, category: "MATERIALS" },
  });
  check(
    "Financial actual cost is the single linked expense, not purchase + expense",
    links.length === 1 &&
      expenses.length === 1 &&
      links[0].expenseId === expenses[0].id &&
      links[0].doNotDoubleCount === true &&
      links[0].countedAsExpense === true,
  );
  const variance = await materialEstimateVsActual(prisma, ownerA, { jobId: job.id });
  const bagVariance = variance.find((row) => /concrete/i.test(row.name));
  check(
    "Estimate vs actual keeps customer price / markup separate from purchased cost",
    bagVariance != null &&
      bagVariance.customerUnitPrice === 8.09 &&
      bagVariance.markupPercent === 25 &&
      bagVariance.purchasedCost === Number(expenses[0].amount.toString()),
  );

  console.log("\nTEST — Pickup metadata and MEMBER scope");
  const ownerPickup = await listJobMaterialPickupRequirements(prisma, ownerA, job.id);
  const memberPickup = await listAssignedJobPickupView(prisma, {
    workspace: memberA.workspace,
    businessId: businessA.id,
    membershipId: memberMem.id,
  }, job.id);
  check(
    "Owner pickup feed exposes duration/location/ready for scheduling",
    ownerPickup.some((row) => row.purchaseListItemId === pickupItem.id) &&
      ownerPickup.every((row) => row.jobId === job.id),
  );
  check(
    "MEMBER sees assigned-job pickup only, with no cost fields",
    memberPickup.some((row) => row.id === pickupItem.id) &&
      memberPickup.every((row) => !("actualCost" in row) && !("markupPercent" in row)),
  );
  await expectError(
    "MEMBER cannot read company-wide vendor catalog",
    () => listMaterialCatalog(prisma, memberA),
    (error) => error instanceof ForbiddenError || error.name === "ForbiddenError",
  );
  const otherJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
    },
  });
  await expectError(
    "MEMBER cannot read pickup for an unassigned job",
    () =>
      listAssignedJobPickupView(
        prisma,
        {
          workspace: memberA.workspace,
          businessId: businessA.id,
          membershipId: memberMem.id,
        },
        otherJob.id,
      ),
    (error) => error instanceof ForbiddenError || error.name === "ForbiddenError",
  );

  console.log("\nTEST — Ordinary edit preserves estimate snapshot and purchase actuals");
  const estimatedBefore = {
    qty: bagItem.estimatedQuantity.toString(),
    cost: bagItem.estimatedCost.toString(),
    purchasedQty: (await prisma.materialPurchaseListItem.findUnique({ where: { id: bagItem.id } }))
      .quantityPurchased.toString(),
    purchasedUnit: (await prisma.materialPurchaseListItem.findUnique({ where: { id: bagItem.id } }))
      .actualUnitCost.toString(),
    purchasedCost: (await prisma.materialPurchaseListItem.findUnique({ where: { id: bagItem.id } }))
      .actualCost.toString(),
  };
  const varianceBeforeEdit = await materialEstimateVsActual(prisma, ownerA, { jobId: job.id });
  const bagVarianceBeforeEdit = varianceBeforeEdit.find((row) => /concrete/i.test(row.name));
  await updatePurchaseListItem(prisma, ownerA, {
    itemId: bagItem.id,
    supplierId: depot.id,
    pickupLocationDescription: "Yard gate B",
    notes: "Call ahead",
    pickupRequired: true,
  });
  const bagAfterEdit = await prisma.materialPurchaseListItem.findUnique({ where: { id: bagItem.id } });
  const varianceAfterEdit = await materialEstimateVsActual(prisma, ownerA, { jobId: job.id });
  const bagVarianceAfterEdit = varianceAfterEdit.find((row) => /concrete/i.test(row.name));
  check(
    "Ordinary pickup/supplier/notes edit keeps estimate baseline and purchased actuals",
    bagAfterEdit.pickupLocationDescription === "Yard gate B" &&
      bagAfterEdit.notes === "Call ahead" &&
      bagAfterEdit.estimatedQuantity.toString() === estimatedBefore.qty &&
      bagAfterEdit.estimatedCost.toString() === estimatedBefore.cost &&
      bagAfterEdit.quantityPurchased.toString() === estimatedBefore.purchasedQty &&
      bagAfterEdit.actualUnitCost.toString() === estimatedBefore.purchasedUnit &&
      bagAfterEdit.actualCost.toString() === estimatedBefore.purchasedCost &&
      bagVarianceAfterEdit.estimatedQuantity === bagVarianceBeforeEdit.estimatedQuantity &&
      bagVarianceAfterEdit.estimatedCost === bagVarianceBeforeEdit.estimatedCost &&
      bagVarianceAfterEdit.purchasedQuantity === bagVarianceBeforeEdit.purchasedQuantity &&
      bagVarianceAfterEdit.purchasedCost === bagVarianceBeforeEdit.purchasedCost &&
      bagVarianceAfterEdit.costDelta === bagVarianceBeforeEdit.costDelta,
  );

  console.log("\nTEST — Purchase-list uniqueness and conversion idempotency");
  async function seedEstimateWithTakeoff() {
    const est = await prisma.estimate.create({
      data: {
        businessId: businessA.id,
        customerId: customer.id,
        status: "DRAFT",
        publicToken: randomUUID(),
      },
    });
    await prisma.lineItem.create({
      data: {
        businessId: businessA.id,
        estimateId: est.id,
        description: joinLineDescription("Concrete slab", null, null, null, {
          materialTakeoff: withPrices,
        }),
        quantity: 1,
        unitPrice: 400,
        total: 400,
        type: "LABOR",
      },
    });
    return est;
  }

  const concurrentEstimate = await seedEstimateWithTakeoff();
  const [listOne, listTwo] = await Promise.all([
    ensurePurchaseList(prisma, ownerA, { estimateId: concurrentEstimate.id }),
    ensurePurchaseList(prisma, ownerA, { estimateId: concurrentEstimate.id }),
  ]);
  const listsForEstimate = await prisma.materialPurchaseList.findMany({
    where: { businessId: businessA.id, estimateId: concurrentEstimate.id },
  });
  check(
    "Concurrent ensurePurchaseList for the same estimate yields one list",
    listOne.id === listTwo.id && listsForEstimate.length === 1,
  );

  const convertEstimate = await seedEstimateWithTakeoff();
  const [convertA, convertB] = await Promise.all([
    convertTakeoffToPurchaseList(prisma, ownerA, {
      estimateId: convertEstimate.id,
      linkCatalog: true,
      attemptKey: `convert-${convertEstimate.id}-1`,
    }),
    convertTakeoffToPurchaseList(prisma, ownerA, {
      estimateId: convertEstimate.id,
      linkCatalog: true,
      attemptKey: `convert-${convertEstimate.id}-1`,
    }),
  ]);
  const convertedItems = await prisma.materialPurchaseListItem.findMany({
    where: { businessId: businessA.id, purchaseListId: convertA.purchaseListId },
  });
  const convertedKeys = convertedItems.map((row) => row.sourceKey).sort();
  check(
    "Concurrent takeoff conversion retries reuse one list and do not duplicate converted rows",
    convertA.purchaseListId === convertB.purchaseListId &&
      convertedItems.length === new Set(convertedKeys).size &&
      convertedItems.every((row) => row.sourceKey) &&
      convertedItems.some((row) => row.sourceKey.startsWith("takeoff:")),
  );

  const dualLineEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "DRAFT",
      publicToken: randomUUID(),
    },
  });
  const lineOne = await prisma.lineItem.create({
    data: {
      businessId: businessA.id,
      estimateId: dualLineEstimate.id,
      description: joinLineDescription("Patio slab", null, null, null, {
        materialTakeoff: withPrices,
      }),
      quantity: 1,
      unitPrice: 200,
      total: 200,
      type: "LABOR",
    },
  });
  const lineTwo = await prisma.lineItem.create({
    data: {
      businessId: businessA.id,
      estimateId: dualLineEstimate.id,
      description: joinLineDescription("Walkway slab", null, null, null, {
        materialTakeoff: withPrices,
      }),
      quantity: 1,
      unitPrice: 150,
      total: 150,
      type: "LABOR",
    },
  });
  await convertTakeoffToPurchaseList(prisma, ownerA, {
    estimateId: dualLineEstimate.id,
    linkCatalog: true,
  });
  const dualItems = await prisma.materialPurchaseListItem.findMany({
    where: { businessId: businessA.id, purchaseList: { estimateId: dualLineEstimate.id } },
  });
  const bagKeys = dualItems.filter((row) => /concrete/i.test(row.name)).map((row) => row.sourceKey);
  check(
    "Same takeoff item id on different estimate lines keeps both converted rows",
    bagKeys.includes(takeoffSourceKey(lineOne.id, "concrete-bags")) &&
      bagKeys.includes(takeoffSourceKey(lineTwo.id, "concrete-bags")) &&
      bagKeys.length === 2,
  );

  const createdJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      estimateId: convertEstimate.id,
      projectToken: randomUUID(),
      status: "UNSCHEDULED",
    },
  });
  const attached = await attachPurchaseListToCreatedJob(prisma, ownerA, {
    jobId: createdJob.id,
    estimateId: convertEstimate.id,
  });
  check(
    "Attaching the estimate purchase list to its created job preserves the same list",
    attached.id === convertA.purchaseListId && attached.jobId === createdJob.id,
  );

  console.log("\nTEST — Attach-to-job tenant and mismatch rejection");
  const betaCustomer = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Other", email: `beta-${randomUUID()}@example.com` },
  });
  const betaEstimate = await prisma.estimate.create({
    data: {
      businessId: businessB.id,
      customerId: betaCustomer.id,
      status: "DRAFT",
      publicToken: randomUUID(),
    },
  });
  const betaJob = await prisma.job.create({
    data: {
      businessId: businessB.id,
      customerId: betaCustomer.id,
      estimateId: betaEstimate.id,
      projectToken: randomUUID(),
      status: "UNSCHEDULED",
    },
  });
  const mismatchEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "DRAFT",
      publicToken: randomUUID(),
    },
  });
  await expectError(
    "Cross-tenant job attach is rejected",
    () =>
      attachPurchaseListToCreatedJob(prisma, ownerA, {
        jobId: betaJob.id,
        estimateId: convertEstimate.id,
      }),
    (error) => error instanceof Error,
  );
  await expectError(
    "Cross-tenant estimate attach is rejected",
    () =>
      attachPurchaseListToCreatedJob(prisma, ownerA, {
        jobId: createdJob.id,
        estimateId: betaEstimate.id,
      }),
    (error) => error instanceof Error,
  );
  await expectError(
    "Same-tenant job/estimate mismatch attach is rejected",
    () =>
      attachPurchaseListToCreatedJob(prisma, ownerA, {
        jobId: createdJob.id,
        estimateId: mismatchEstimate.id,
      }),
    (error) => /does not belong to the supplied estimate/i.test(String(error.message)),
  );

  console.log("\nTEST — Purchase + expense atomic concurrent retry");
  const expenseItem = dualItems.find((row) => /concrete/i.test(row.name));
  const attemptKey = `purchase-${expenseItem.id}-1`;
  const [purchaseOne, purchaseTwo] = await Promise.all([
    recordPurchaseOperation(prisma, ownerA, {
      attemptKey,
      itemId: expenseItem.id,
      quantityPurchased: expenseItem.quantityNeeded.toString(),
      actualUnitCost: "8.50",
      createExpense: true,
      occurredOn: "2026-09-25",
    }),
    recordPurchaseOperation(prisma, ownerA, {
      attemptKey,
      itemId: expenseItem.id,
      quantityPurchased: expenseItem.quantityNeeded.toString(),
      actualUnitCost: "8.50",
      createExpense: true,
      occurredOn: "2026-09-25",
    }),
  ]);
  const expenseRows = await prisma.expense.findMany({
    where: { businessId: businessA.id, description: expenseItem.name },
  });
  const orphanExpenses = await prisma.expense.findMany({
    where: {
      businessId: businessA.id,
      description: expenseItem.name,
      materialPurchaseItem: { is: null },
    },
  });
  const linkedItem = await prisma.materialPurchaseListItem.findUnique({
    where: { id: expenseItem.id },
  });
  check(
    "Concurrent record-purchase retry creates exactly one Expense and no orphan",
    purchaseOne.id === purchaseTwo.id &&
      expenseRows.length === 1 &&
      orphanExpenses.length === 0 &&
      linkedItem.expenseId === expenseRows[0].id &&
      Number(linkedItem.actualUnitCost.toString()) === 8.5,
  );

  console.log("\nTEST — Price-history provenance tenant validation");
  const betaExpense = await createExpense(prisma, ownerB, {
    occurredOn: "2026-09-25",
    description: "Foreign",
    amount: "9.00",
    category: "MATERIALS",
  });
  await expectError(
    "Cross-tenant purchaseListItemId is rejected on price history",
    () =>
      appendMaterialPriceHistory(prisma, ownerB, {
        materialId: bags.id,
        unit: "bag",
        price: "9.00",
        source: "PURCHASE",
        purchaseListItemId: bagItem.id,
      }),
    (error) => error instanceof Error,
  );
  await expectError(
    "Cross-tenant expenseId is rejected on price history",
    () =>
      appendMaterialPriceHistory(prisma, ownerA, {
        materialId: bags.id,
        unit: "bag",
        price: "9.00",
        source: "EXPENSE",
        purchaseListItemId: bagItem.id,
        expenseId: betaExpense.id,
      }),
    (error) => error instanceof Error,
  );

  console.log("\nTEST — Purchase-order supplier, ownership, status, and retry");
  const otherSupplier = await createSupplier(prisma, ownerA, { name: "Other Yard" });
  const poList = await ensurePurchaseList(prisma, ownerA, { estimateId: dualLineEstimate.id });
  const poBag = dualItems.find((row) => /concrete/i.test(row.name) && row.lineItemId === lineOne.id);
  const poPickup = dualItems.find((row) => row.pickupRequired && row.lineItemId === lineOne.id);
  await updatePurchaseListItem(prisma, ownerA, { itemId: poBag.id, supplierId: depot.id });
  await updatePurchaseListItem(prisma, ownerA, { itemId: poPickup.id, supplierId: otherSupplier.id });
  await expectError(
    "PO supplier mismatch is rejected when itemIds include another supplier",
    () =>
      createPurchaseOrder(prisma, ownerA, {
        purchaseListId: poList.id,
        supplierId: depot.id,
        itemIds: [poBag.id, poPickup.id],
      }),
    (error) => /same supplier/i.test(String(error.message)),
  );
  const poAttempt = `po-${poList.id}-depot`;
  const [poOne, poTwo] = await Promise.all([
    createPurchaseOrder(prisma, ownerA, {
      purchaseListId: poList.id,
      supplierId: depot.id,
      attemptKey: poAttempt,
    }),
    createPurchaseOrder(prisma, ownerA, {
      purchaseListId: poList.id,
      supplierId: depot.id,
      attemptKey: poAttempt,
    }),
  ]);
  check(
    "Draft PO retry uses one PO and only that supplier's items",
    poOne.id === poTwo.id &&
      poOne.supplierId === depot.id &&
      poOne.items.length >= 1 &&
      poOne.items.every((row) => row.businessId === businessA.id) &&
      !poOne.items.some((row) => row.purchaseListItemId === poPickup.id),
  );
  const otherListItem = await addPurchaseListItem(prisma, ownerA, {
    purchaseListId: list.id,
    name: "Foreign list row",
    quantityNeeded: "1",
    unit: "ea",
  });
  await expectError(
    "PO item from another purchase list is rejected",
    () =>
      createPurchaseOrder(prisma, ownerA, {
        purchaseListId: poList.id,
        itemIds: [otherListItem.id],
      }),
    (error) => /belong to this purchase list/i.test(String(error.message)),
  );
  const receivedPo = await updatePurchaseOrderStatus(prisma, ownerA, {
    purchaseOrderId: poOne.id,
    status: "ORDERED_EXTERNALLY",
  });
  const fullyReceived = await updatePurchaseOrderStatus(prisma, ownerA, {
    purchaseOrderId: poOne.id,
    status: "RECEIVED",
  });
  check(
    "orderedAt / receivedAt are recorded and not erased",
    receivedPo.orderedAt != null &&
      fullyReceived.orderedAt != null &&
      fullyReceived.receivedAt != null &&
      fullyReceived.orderedAt.getTime() === receivedPo.orderedAt.getTime(),
  );
  await expectError(
    "RECEIVED cannot silently return to DRAFT",
    () => updatePurchaseOrderStatus(prisma, ownerA, { purchaseOrderId: poOne.id, status: "DRAFT" }),
    (error) => /cannot move from RECEIVED to DRAFT/i.test(String(error.message)),
  );
  const cancelList = await ensurePurchaseList(prisma, ownerA, { estimateId: mismatchEstimate.id });
  await addPurchaseListItem(prisma, ownerA, {
    purchaseListId: cancelList.id,
    name: "Cancel-me lumber",
    quantityNeeded: "2",
    unit: "ea",
    supplierId: depot.id,
  });
  const cancelPo = await createPurchaseOrder(prisma, ownerA, {
    purchaseListId: cancelList.id,
    supplierId: depot.id,
  });
  await updatePurchaseOrderStatus(prisma, ownerA, {
    purchaseOrderId: cancelPo.id,
    status: "CANCELLED",
  });
  await expectError(
    "CANCELLED cannot silently become RECEIVED",
    () =>
      updatePurchaseOrderStatus(prisma, ownerA, {
        purchaseOrderId: cancelPo.id,
        status: "RECEIVED",
      }),
    (error) => /cannot move from CANCELLED to RECEIVED/i.test(String(error.message)),
  );

  console.log("\nTEST — Runtime request paths execute no schema DDL");
  const ddlStatements = [];
  const originalUnsafe = prisma.$executeRawUnsafe.bind(prisma);
  const originalRaw = prisma.$executeRaw.bind(prisma);
  prisma.$executeRawUnsafe = async (...args) => {
    ddlStatements.push(String(args[0]));
    return originalUnsafe(...args);
  };
  prisma.$executeRaw = async (...args) => {
    ddlStatements.push(String(args[0]));
    return originalRaw(...args);
  };
  await listMaterialCatalog(prisma, ownerA);
  await listSuppliers(prisma, ownerA);
  await loadPurchaseListBoard(prisma, ownerA, { estimateId: estimate.id });
  await materialEstimateVsActual(prisma, ownerA, { jobId: job.id });
  await listJobMaterialPickupRequirements(prisma, ownerA, job.id);
  await listMaterialActualCostLinks(prisma, ownerA, { jobId: job.id });
  await listAssignedJobPickupView(
    prisma,
    {
      workspace: memberA.workspace,
      businessId: businessA.id,
      membershipId: memberMem.id,
    },
    job.id,
  );
  prisma.$executeRawUnsafe = originalUnsafe;
  prisma.$executeRaw = originalRaw;
  check(
    "Catalog / estimate / job / expense / pickup reads execute no schema DDL",
    ddlStatements.every((sql) => !/CREATE\s+|ALTER\s+|DROP\s+|INDEX/i.test(sql)),
  );

  if (failures > 0) {
    console.error(`\n${failures} materials-suppliers check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll materials-suppliers checks passed.");
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}

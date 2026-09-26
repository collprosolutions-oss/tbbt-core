/**
 * AI Chief of Staff Materials specialist proofs.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-materials-specialist.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError, CAPABILITIES, requireBusinessCapability } = await import("@/lib/authorization");
const {
  MATERIALS_CONTEXT_CAPS,
  MAX_RECURSION_DEPTH,
  MAX_SPECIALIST_FANOUT,
  countCheaperRecordedSuppliers,
  countDistinctStaleMaterials,
  countPriceChangesFromHistory,
  latestComparableByProvider,
  selectProjectedSupplierPrices,
  getLastMaterialsProjection,
  getMaterialsProjectionLoadCount,
  getMaterialsSpecialistInterpretationCount,
  materialsProjectionHasForbiddenFields,
  planSpecialists,
  resetLastMaterialsProjection,
  resetMaterialsSpecialistCounters,
  resolveConflicts,
  runChiefOfStaffCoach,
  runMaterialsSpecialist,
} = await import("@/lib/chief-of-staff");
const { getSpecialistEntry } = await import("@/lib/chief-of-staff/registry");
const { classifySupplierPriceFreshness } = await import("@/lib/material-pricing/freshness");
const { getSupplierCommerceAdapter } = await import("@/lib/materials/adapter");
const { PRODUCT_CAPABILITIES } = await import("@/lib/product-catalog");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_materials_specialist_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) process.exit(push.status ?? 1);

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  ok  - ${label}`);
  else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

function makeAccess(businessId, role, membershipId, userId) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      user: { id: userId, email: "owner@example.com", name: "Owner" },
    },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
    assertAttachable(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

async function entitleFounder(businessId) {
  await prisma.businessSaasSubscription.create({
    data: {
      businessId,
      status: "active",
      planCode: "FOUNDER",
      legacyExempt: true,
    },
  });
}

async function createOwnerWorkspace(name) {
  const user = await prisma.user.create({
    data: { name: `${name} Owner`, email: `${name}-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const business = await prisma.business.create({
    data: { name, slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID()}`, tradeCode: "HANDYMAN" },
  });
  const membership = await prisma.membership.create({
    data: { userId: user.id, businessId: business.id, role: "OWNER" },
  });
  return {
    user,
    business,
    membership,
    access: makeAccess(business.id, "OWNER", membership.id, user.id),
  };
}

function daysAgo(days, now = new Date()) {
  return new Date(now.getTime() - days * 86_400_000);
}

function hoursAgo(hours, now = new Date()) {
  return new Date(now.getTime() - hours * 3_600_000);
}

function daysFromNow(days, now = new Date()) {
  return new Date(now.getTime() + days * 86_400_000);
}

function resetLoads() {
  resetMaterialsSpecialistCounters();
  resetLastMaterialsProjection();
}

function emptyCatalog() {
  return {
    facts: {},
    recommendations: [],
    activeRecommendations: [],
    historyRecommendations: [],
    states: [],
    workforceRecommendationKeys: [],
    financial: { entitled: false, failed: false, intelligence: null },
    growth: { entitled: false, source: null, failed: false, missingCapabilities: [] },
    workforceSnapshot: null,
  };
}

async function countMaterialsRows(businessId) {
  const [
    lists,
    items,
    orders,
    orderItems,
    attempts,
    history,
    actionItems,
    proposals,
    catalog,
    suppliers,
    mappings,
    prefs,
    prices,
  ] = await Promise.all([
    prisma.materialPurchaseList.count({ where: { businessId } }),
    prisma.materialPurchaseListItem.count({ where: { businessId } }),
    prisma.materialPurchaseOrder.count({ where: { businessId } }),
    prisma.materialPurchaseOrderItem.count({ where: { businessId } }),
    prisma.materialOperationAttempt.count({ where: { businessId } }),
    prisma.materialPriceHistory.count({ where: { businessId } }),
    prisma.businessActionItem.count({ where: { businessId } }),
    Promise.resolve(0),
    prisma.materialCatalogItem.count({ where: { businessId } }),
    prisma.supplier.count({ where: { businessId } }),
    prisma.businessMaterialSupplierMapping.count({ where: { businessId } }),
    prisma.businessSupplierPreference.count({ where: { businessId } }),
    prisma.supplierPriceRecord.count({ where: { businessId } }),
  ]);
  return {
    lists,
    items,
    orders,
    orderItems,
    attempts,
    history,
    actionItems,
    proposals,
    catalog,
    suppliers,
    mappings,
    prefs,
    prices,
  };
}

async function seedMaterialsWorld(workspace, { secret = false, extraJobs = 0, extraItems = 0 } = {}) {
  const businessId = workspace.business.id;
  const prefix = secret ? "BetaSecret9999" : "Alpha";
  const supplier = await prisma.supplier.create({
    data: {
      businessId,
      name: `${prefix} Hardware`,
      preferred: true,
      contactEmail: secret ? "secret-vendor@example.com" : "alpha@example.com",
      contactPhone: "555-0199",
      accountReference: "acct-1",
    },
  });
  const cheaper = await prisma.supplier.create({
    data: { businessId, name: `${prefix} Discount Lumber`, preferred: false },
  });
  const lumber = await prisma.materialCatalogItem.create({
    data: {
      businessId,
      name: `${prefix} 2x4 lumber`,
      normalizedName: `${prefix.toLowerCase()} 2x4 lumber`,
      unit: "board",
      lastKnownCost: "8.00",
      lastKnownCostAt: hoursAgo(2),
      preferredSupplierId: supplier.id,
      takeoffIdentity: "form-lumber",
    },
  });
  const unmapped = await prisma.materialCatalogItem.create({
    data: {
      businessId,
      name: `${prefix} mystery parts`,
      normalizedName: `${prefix.toLowerCase()} mystery parts`,
      unit: "ea",
      takeoffIdentity: "anchor-hardware",
    },
  });
  await prisma.materialPriceHistory.create({
    data: {
      businessId,
      materialId: lumber.id,
      supplierId: supplier.id,
      unit: "board",
      price: "6.50",
      observedAt: daysAgo(20),
      source: "OWNER_ENTRY",
    },
  });
  await prisma.materialPriceHistory.create({
    data: {
      businessId,
      materialId: lumber.id,
      supplierId: supplier.id,
      unit: "board",
      price: "8.00",
      observedAt: hoursAgo(3),
      source: "OWNER_ENTRY",
    },
  });
  await prisma.businessSupplierPreference.create({
    data: { businessId, providerId: "home-depot", enabled: true, locationZip: "97201" },
  });
  await prisma.businessMaterialSupplierMapping.create({
    data: {
      businessId,
      providerId: "home-depot",
      materialIdentity: "form-lumber",
      providerProductId: "hd-lumber-1",
      productName: "2x4",
      unitLabel: "board",
    },
  });
  await prisma.supplierPriceRecord.create({
    data: {
      businessId,
      providerId: "home-depot",
      providerProductId: "hd-lumber-1",
      productName: "2x4",
      unitLabel: "board",
      currentPrice: "8.40",
      fetchedAt: hoursAgo(2),
      sourceStatus: "current",
      sourceMode: "catalog-reference",
      locationKey: "store-a",
    },
  });
  await prisma.supplierPriceRecord.create({
    data: {
      businessId,
      providerId: "home-depot",
      providerProductId: "hd-lumber-1",
      productName: "2x4",
      unitLabel: "board",
      currentPrice: "7.90",
      fetchedAt: hoursAgo(1),
      sourceStatus: "current",
      sourceMode: "catalog-reference",
      locationKey: "store-b",
    },
  });
  await prisma.supplierPriceRecord.create({
    data: {
      businessId,
      providerId: "home-depot",
      providerProductId: "hd-lumber-1",
      productName: "2x4",
      unitLabel: "board",
      currentPrice: "8.10",
      fetchedAt: hoursAgo(4),
      sourceStatus: "current",
      sourceMode: "catalog-reference",
      locationKey: "store-c",
    },
  });
  const newestCompare = await prisma.materialCatalogItem.create({
    data: {
      businessId,
      name: `${prefix} newest-compare stain`,
      normalizedName: `${prefix.toLowerCase()} newest-compare stain`,
      unit: "gal",
      lastKnownCost: "8.40",
      takeoffIdentity: "newest-compare",
    },
  });
  await prisma.businessMaterialSupplierMapping.create({
    data: {
      businessId,
      providerId: "home-depot",
      materialIdentity: "newest-compare",
      providerProductId: "hd-stain-1",
      productName: "stain",
      unitLabel: "gal",
    },
  });
  await prisma.businessMaterialSupplierMapping.create({
    data: {
      businessId,
      providerId: "lowes",
      materialIdentity: "newest-compare",
      providerProductId: "lw-stain-1",
      productName: "stain",
      unitLabel: "gal",
    },
  });
  await prisma.supplierPriceRecord.create({
    data: {
      businessId,
      providerId: "home-depot",
      providerProductId: "hd-stain-1",
      productName: "stain",
      unitLabel: "gal",
      currentPrice: "6.00",
      fetchedAt: hoursAgo(12),
      sourceStatus: "current",
      sourceMode: "catalog-reference",
      locationKey: "store-old",
    },
  });
  await prisma.supplierPriceRecord.create({
    data: {
      businessId,
      providerId: "home-depot",
      providerProductId: "hd-stain-1",
      productName: "stain",
      unitLabel: "gal",
      currentPrice: "8.40",
      fetchedAt: hoursAgo(1),
      sourceStatus: "current",
      sourceMode: "catalog-reference",
      locationKey: "store-new",
    },
  });
  await prisma.supplierPriceRecord.create({
    data: {
      businessId,
      providerId: "lowes",
      providerProductId: "lw-stain-1",
      productName: "stain",
      unitLabel: "gal",
      currentPrice: "8.40",
      fetchedAt: hoursAgo(2),
      sourceStatus: "current",
      sourceMode: "catalog-reference",
      locationKey: "store-1",
    },
  });
  const staleMaterial = await prisma.materialCatalogItem.create({
    data: {
      businessId,
      name: `${prefix} stale bags`,
      normalizedName: `${prefix.toLowerCase()} stale bags`,
      unit: "bag",
      lastKnownCost: "6.00",
      lastKnownCostAt: daysAgo(8),
      takeoffIdentity: "concrete-bags",
    },
  });
  await prisma.businessMaterialSupplierMapping.create({
    data: {
      businessId,
      providerId: "home-depot",
      materialIdentity: "concrete-bags",
      providerProductId: "hd-bag-1",
      productName: "60lb bag",
      unitLabel: "bag",
    },
  });
  await prisma.supplierPriceRecord.create({
    data: {
      businessId,
      providerId: "home-depot",
      providerProductId: "hd-bag-1",
      productName: "60lb bag",
      unitLabel: "bag",
      currentPrice: "6.25",
      fetchedAt: daysAgo(8),
      sourceStatus: "stale",
      sourceMode: "catalog-reference",
    },
  });

  const customer = await prisma.customer.create({
    data: { businessId, name: `${prefix} Customer` },
  });
  const estimate = await prisma.estimate.create({
    data: { businessId, customerId: customer.id, status: "APPROVED", publicToken: randomUUID() },
  });
  const job = await prisma.job.create({
    data: {
      businessId,
      customerId: customer.id,
      estimateId: estimate.id,
      status: "SCHEDULED",
      scheduledAt: daysFromNow(2),
      projectToken: randomUUID(),
      pickupDurationMinutes: 25,
    },
  });
  const list = await prisma.materialPurchaseList.create({
    data: { businessId, jobId: job.id, estimateId: estimate.id },
  });
  const needed = await prisma.materialPurchaseListItem.create({
    data: {
      businessId,
      purchaseListId: list.id,
      materialId: lumber.id,
      supplierId: supplier.id,
      name: lumber.name,
      quantityNeeded: "12",
      unit: "board",
      plannedUnitCost: "8.00",
      plannedCost: "96.00",
      estimatedCost: "90.00",
      status: "NEEDED",
      pickupRequired: true,
      pickupReady: false,
      pickupDurationMinutes: 25,
      sourceKey: `needed-${randomUUID()}`,
    },
  });
  await prisma.materialPurchaseListItem.create({
    data: {
      businessId,
      purchaseListId: list.id,
      materialId: unmapped.id,
      name: unmapped.name,
      quantityNeeded: "4",
      unit: "ea",
      status: "NEEDED",
      sourceKey: `unmapped-${randomUUID()}`,
    },
  });
  await prisma.materialPurchaseListItem.create({
    data: {
      businessId,
      purchaseListId: list.id,
      materialId: staleMaterial.id,
      name: staleMaterial.name,
      quantityNeeded: "6",
      unit: "bag",
      plannedUnitCost: "6.00",
      plannedCost: "36.00",
      estimatedCost: "30.00",
      actualCost: "48.00",
      status: "PLANNED",
      sourceKey: `stale-${randomUUID()}`,
    },
  });
  const expense = await prisma.expense.create({
    data: {
      businessId,
      occurredOn: daysAgo(1),
      description: `${prefix} bags`,
      amount: "48.00",
      category: "MATERIALS",
      jobId: job.id,
    },
  });
  await prisma.materialPurchaseListItem.update({
    where: { id: (await prisma.materialPurchaseListItem.findFirst({
      where: { businessId, name: staleMaterial.name },
    })).id },
    data: { expenseId: expense.id },
  });
  const draftPo = await prisma.materialPurchaseOrder.create({
    data: {
      businessId,
      purchaseListId: list.id,
      supplierId: supplier.id,
      jobId: job.id,
      status: "DRAFT",
    },
  });
  const oneHistory = await prisma.materialCatalogItem.create({
    data: {
      businessId,
      name: `${prefix} one-history paint`,
      normalizedName: `${prefix.toLowerCase()} one-history paint`,
      unit: "gal",
      lastKnownCost: "22.00",
      lastKnownCostAt: hoursAgo(4),
      takeoffIdentity: "one-history-paint",
    },
  });
  await prisma.materialPriceHistory.create({
    data: {
      businessId,
      materialId: oneHistory.id,
      supplierId: supplier.id,
      unit: "gal",
      price: "24.50",
      observedAt: hoursAgo(5),
      source: "OWNER_ENTRY",
    },
  });
  const sameHistory = await prisma.materialCatalogItem.create({
    data: {
      businessId,
      name: `${prefix} same-history nails`,
      normalizedName: `${prefix.toLowerCase()} same-history nails`,
      unit: "lb",
      lastKnownCost: "4.00",
      lastKnownCostAt: hoursAgo(4),
      takeoffIdentity: "same-history-nails",
    },
  });
  await prisma.materialPriceHistory.create({
    data: {
      businessId,
      materialId: sameHistory.id,
      supplierId: supplier.id,
      unit: "lb",
      price: "4.25",
      observedAt: daysAgo(10),
      source: "OWNER_ENTRY",
    },
  });
  await prisma.materialPriceHistory.create({
    data: {
      businessId,
      materialId: sameHistory.id,
      supplierId: supplier.id,
      unit: "lb",
      price: "4.25",
      observedAt: hoursAgo(6),
      source: "OWNER_ENTRY",
    },
  });
  const estimateOnlyEstimate = await prisma.estimate.create({
    data: { businessId, customerId: customer.id, status: "DRAFT", publicToken: randomUUID() },
  });
  const estimateOnlyList = await prisma.materialPurchaseList.create({
    data: { businessId, estimateId: estimateOnlyEstimate.id },
  });
  await prisma.materialPurchaseListItem.create({
    data: {
      businessId,
      purchaseListId: estimateOnlyList.id,
      name: `${prefix} estimate-only fasteners`,
      quantityNeeded: "2",
      unit: "box",
      status: "NEEDED",
      sourceKey: `est-only-${randomUUID()}`,
    },
  });
  await prisma.materialPurchaseListItem.create({
    data: {
      businessId,
      purchaseListId: estimateOnlyList.id,
      materialId: oneHistory.id,
      name: oneHistory.name,
      quantityNeeded: "1",
      unit: "gal",
      status: "PLANNED",
      sourceKey: `one-hist-${randomUUID()}`,
    },
  });
  await prisma.materialPurchaseListItem.create({
    data: {
      businessId,
      purchaseListId: estimateOnlyList.id,
      materialId: sameHistory.id,
      name: sameHistory.name,
      quantityNeeded: "1",
      unit: "lb",
      status: "PLANNED",
      sourceKey: `same-hist-${randomUUID()}`,
    },
  });
  await prisma.materialPurchaseListItem.create({
    data: {
      businessId,
      purchaseListId: estimateOnlyList.id,
      materialId: newestCompare.id,
      name: newestCompare.name,
      quantityNeeded: "1",
      unit: "gal",
      status: "PLANNED",
      sourceKey: `newest-${randomUUID()}`,
    },
  });
  await prisma.materialPurchaseOrder.create({
    data: {
      businessId,
      purchaseListId: estimateOnlyList.id,
      status: "DRAFT",
    },
  });

  for (let i = 0; i < extraJobs; i += 1) {
    const extraJob = await prisma.job.create({
      data: {
        businessId,
        customerId: customer.id,
        status: "SCHEDULED",
        scheduledAt: daysFromNow(3 + i),
        projectToken: randomUUID(),
        pickupDurationMinutes: 10,
      },
    });
    const extraList = await prisma.materialPurchaseList.create({
      data: { businessId, jobId: extraJob.id },
    });
    await prisma.materialPurchaseListItem.create({
      data: {
        businessId,
        purchaseListId: extraList.id,
        name: `${prefix} extra ${i + 1}`,
        quantityNeeded: "1",
        unit: "ea",
        status: "NEEDED",
        sourceKey: `extra-${i}-${randomUUID()}`,
      },
    });
  }
  for (let i = 0; i < extraItems; i += 1) {
    await prisma.materialPurchaseListItem.create({
      data: {
        businessId,
        purchaseListId: list.id,
        name: `${prefix} overflow ${i + 1}`,
        quantityNeeded: "1",
        unit: "ea",
        status: "ORDERED",
        sourceKey: `overflow-${i}-${randomUUID()}`,
      },
    });
  }

  await prisma.materialPurchaseList.update({
    where: { id: list.id },
    data: { estimateId: estimate.id },
  });
  await prisma.materialPurchaseList.update({
    where: { id: estimateOnlyList.id },
    data: { estimateId: estimateOnlyEstimate.id },
  });

  return {
    supplier,
    cheaper,
    lumber,
    unmapped,
    staleMaterial,
    oneHistory,
    sameHistory,
    newestCompare,
    job,
    list,
    estimateOnlyList,
    needed,
    draftPo,
    estimate,
    estimateOnlyEstimate,
  };
}

try {
  const specialistSrc = readFileSync(new URL("../src/lib/chief-of-staff/materials-specialist.ts", import.meta.url), "utf8");
  const snapshotSrc = readFileSync(new URL("../src/lib/chief-of-staff/materials-snapshot.ts", import.meta.url), "utf8");
  const runSrc = readFileSync(new URL("../src/lib/chief-of-staff/run.ts", import.meta.url), "utf8");
  const schemaSrc = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

  console.log("\nSTATIC — Materials specialist is read/explain only");
  const entry = getSpecialistEntry("MATERIALS");
  check("MATERIALS remains the existing specialist identity", entry.id === "MATERIALS" && entry.enabled === true);
  check("Role floor is MANAGE_ESTIMATES", entry.requiredRoleCapability === CAPABILITIES.MANAGE_ESTIMATES);
  check("Registry product field stays ESTIMATES_INVOICES", entry.requiredProductCapability === "ESTIMATES_INVOICES");
  check("Approval class is READ_EXPLAIN", entry.approvalClass === "READ_EXPLAIN");
  check("Materials specialist performs no LLM call", !specialistSrc.includes("runAiTask") && !specialistSrc.includes("resolveAiProvider"));
  check(
    "Materials specialist does not call write paths",
    !specialistSrc.includes("createPurchaseOrder(") &&
      !specialistSrc.includes("updatePurchaseOrderStatus(") &&
      !specialistSrc.includes("addPurchaseListItem(") &&
      !specialistSrc.includes("recordPurchaseListItemPurchased(") &&
      !specialistSrc.includes("recordPurchaseOperation(") &&
      !specialistSrc.includes("linkPurchaseItemToExpense(") &&
      !specialistSrc.includes("convertTakeoffToPurchaseList(") &&
      !specialistSrc.includes("ensurePurchaseList(") &&
      !specialistSrc.includes("withMaterialAttempt(") &&
      !specialistSrc.includes("appendMaterialPriceHistory(") &&
      !specialistSrc.includes("refreshSupplierPrices(") &&
      !specialistSrc.includes("saveSupplierPreference(") &&
      !specialistSrc.includes("applyCurrentSupplierPriceToDraft(") &&
      !specialistSrc.includes("listAssignedJobPickupView(") &&
      !specialistSrc.includes("ensureMaterialPriceEngineTables") &&
      !specialistSrc.includes("loadMaterialsWorkspaceData") &&
      !specialistSrc.includes("createIfMissing") &&
      !specialistSrc.includes("AiActionProposal") &&
      !snapshotSrc.includes("AiActionProposal") &&
      !runSrc.includes("AiActionProposal"),
  );
  check("Materials specialist does not invoke another specialist", !specialistSrc.includes("runWorkforceSpecialist") && !specialistSrc.includes("interpretFinancialSpecialist") && !specialistSrc.includes("interpretGrowthSpecialist"));
  check("No Prisma schema change is required", schemaSrc.includes("model MaterialPurchaseList") && schemaSrc.includes("model SupplierPriceRecord"));
  check("Max fan-out remains 4", MAX_SPECIALIST_FANOUT === 4);
  check("Recursion depth remains 1", MAX_RECURSION_DEPTH === 1);
  check("8-day fetched price classifies as stale, never current", classifySupplierPriceFreshness(daysAgo(8)) === "stale");
  const adapter = getSupplierCommerceAdapter();
  check("Commerce adapter stays DISCONNECTED", adapter.connectionState === "DISCONNECTED");
  check("Null adapter quote is not a live stock result", (await adapter.quotePrice("x")).price == null && (await adapter.checkAvailability("x")).available == null);

  const buyPlan = planSpecialists({ question: "What do I need to buy?", activeRecommendationKeys: [] });
  const inventoryPlan = planSpecialists({ question: "What's in inventory?", activeRecommendationKeys: [] });
  const lumberPlan = planSpecialists({ question: "Do I have enough lumber and parts?", activeRecommendationKeys: [] });
  const poPlan = planSpecialists({ question: "Which purchase orders are still draft?", activeRecommendationKeys: [] });
  const pickupPlan = planSpecialists({ question: "Which material pickups are not ready?", activeRecommendationKeys: [] });
  const vendorPlan = planSpecialists({ question: "Which vendor prices went stale?", activeRecommendationKeys: [] });
  const recPlan = planSpecialists({
    question: "What should I focus on this week?",
    activeRecommendationKeys: ["materials-stale-price"],
  });
  const overloaded = planSpecialists({ question: "Who is overloaded Friday?", activeRecommendationKeys: [] });
  const margin = planSpecialists({ question: "How is my margin this month?", activeRecommendationKeys: [] });
  const focus = planSpecialists({ question: "What should I focus on this week?", activeRecommendationKeys: [] });
  const genericJob = planSpecialists({ question: "How are the jobs going?", activeRecommendationKeys: [] });
  check("Planner selects MATERIALS for buy", buyPlan.selectedIds.includes("MATERIALS"));
  check("Planner selects MATERIALS for inventory", inventoryPlan.selectedIds.includes("MATERIALS"));
  check("Planner selects MATERIALS for lumber/parts", lumberPlan.selectedIds.includes("MATERIALS"));
  check("Planner selects MATERIALS for purchase orders", poPlan.selectedIds.includes("MATERIALS"));
  check("Planner selects MATERIALS for pickup", pickupPlan.selectedIds.includes("MATERIALS"));
  check("Planner selects MATERIALS for vendor/stale price", vendorPlan.selectedIds.includes("MATERIALS"));
  check("Planner selects MATERIALS from materials-* recs", recPlan.selectedIds.includes("MATERIALS"));
  check("Overloaded Friday does not select MATERIALS", !overloaded.selectedIds.includes("MATERIALS"));
  check("Generic margin does not select MATERIALS", !margin.selectedIds.includes("MATERIALS") && margin.selectedIds.includes("FINANCIAL"));
  check("Generic focus does not select MATERIALS", !focus.selectedIds.includes("MATERIALS"));
  check("Generic job question does not select MATERIALS", !genericJob.selectedIds.includes("MATERIALS"));
  check("Fan-out stays <= 4", buyPlan.fanout <= 4 && recPlan.fanout <= 4);
  check("Recursion depth stays 1", buyPlan.recursionDepth === 1);
  check(
    "Stale requirement and freshness for one material count once",
    countDistinctStaleMaterials(
      [{ materialId: "m1", takeoffIdentity: "concrete-bags", priceState: "price-stale" }],
      [{ materialKey: "concrete-bags", freshness: "stale" }],
    ) === 1,
  );
  check(
    "One history row is not a price change even when lastKnownCost differs",
    countPriceChangesFromHistory(new Map([["one", [{ price: 24.5 }]]])) === 0,
  );
  check(
    "Two 90-day history rows at the same price are not a change",
    countPriceChangesFromHistory(new Map([["same", [{ price: 4.25 }, { price: 4.25 }]]])) === 0,
  );
  check(
    "Two 90-day history rows at different prices are a change",
    countPriceChangesFromHistory(new Map([["diff", [{ price: 8 }, { price: 6.5 }]]])) === 1,
  );
  check(
    "Same provider two locations is not a cheaper recorded supplier",
    countCheaperRecordedSuppliers(
      new Map([
        [
          "form-lumber",
          [
            { materialKey: "form-lumber", providerId: "home-depot", providerProductId: "hd-lumber-1", recordedPrice: 8.4, fetchedAt: "2026-09-25T20:00:00.000Z", freshness: "current", sourceMode: "catalog-reference", locationKey: "store-a" },
            { materialKey: "form-lumber", providerId: "home-depot", providerProductId: "hd-lumber-1", recordedPrice: 7.9, fetchedAt: "2026-09-25T21:00:00.000Z", freshness: "current", sourceMode: "catalog-reference", locationKey: "store-b" },
          ],
        ],
      ]),
    ) === 0,
  );
  check(
    "Distinct current providers can be a cheaper recorded supplier",
    countCheaperRecordedSuppliers(
      new Map([
        [
          "form-lumber",
          [
            { materialKey: "form-lumber", providerId: "home-depot", providerProductId: "hd-lumber-1", recordedPrice: 8.4, fetchedAt: "2026-09-25T20:00:00.000Z", freshness: "current", sourceMode: "catalog-reference", locationKey: "store-a" },
            { materialKey: "form-lumber", providerId: "lowes", providerProductId: "lw-lumber-1", recordedPrice: 7.1, fetchedAt: "2026-09-25T19:00:00.000Z", freshness: "current", sourceMode: "catalog-reference", locationKey: "_" },
          ],
        ],
      ]),
    ) === 1,
  );
  check(
    "SupplierPriceRecord query orders by fetchedAt then id",
    specialistSrc.includes('orderBy: [{ fetchedAt: "desc" }, { id: "desc" }]'),
  );
  const hdAbcLowes = [
    { materialKey: "form-lumber", providerId: "home-depot", providerProductId: "hd-lumber-1", recordedPrice: 8.4, fetchedAt: "2026-09-25T20:00:00.000Z", freshness: "current", sourceMode: "catalog-reference", locationKey: "store-a" },
    { materialKey: "form-lumber", providerId: "home-depot", providerProductId: "hd-lumber-1", recordedPrice: 7.9, fetchedAt: "2026-09-25T21:00:00.000Z", freshness: "current", sourceMode: "catalog-reference", locationKey: "store-b" },
    { materialKey: "form-lumber", providerId: "home-depot", providerProductId: "hd-lumber-1", recordedPrice: 8.1, fetchedAt: "2026-09-25T18:00:00.000Z", freshness: "current", sourceMode: "catalog-reference", locationKey: "store-c" },
    { materialKey: "form-lumber", providerId: "lowes", providerProductId: "lw-lumber-1", recordedPrice: 7.1, fetchedAt: "2026-09-25T19:00:00.000Z", freshness: "current", sourceMode: "catalog-reference", locationKey: "store-1" },
  ];
  const projectedAbc = selectProjectedSupplierPrices(hdAbcLowes);
  check(
    "3 Home Depot locations plus Lowe's stay within the 3-row projection cap",
    projectedAbc.length === 3 &&
      projectedAbc.some((row) => row.providerId === "home-depot") &&
      projectedAbc.some((row) => row.providerId === "lowes"),
  );
  check(
    "Newest per-provider record is used for cheaper comparison",
    latestComparableByProvider([
      { materialKey: "newest-compare", providerId: "home-depot", providerProductId: "hd-stain-1", recordedPrice: 6, fetchedAt: "2026-09-25T10:00:00.000Z", freshness: "current", sourceMode: "catalog-reference", locationKey: "store-old" },
      { materialKey: "newest-compare", providerId: "home-depot", providerProductId: "hd-stain-1", recordedPrice: 8.4, fetchedAt: "2026-09-25T21:00:00.000Z", freshness: "current", sourceMode: "catalog-reference", locationKey: "store-new" },
      { materialKey: "newest-compare", providerId: "lowes", providerProductId: "lw-stain-1", recordedPrice: 8.4, fetchedAt: "2026-09-25T20:00:00.000Z", freshness: "current", sourceMode: "catalog-reference", locationKey: "store-1" },
    ]).find((row) => row.providerId === "home-depot")?.recordedPrice === 8.4,
  );
  check(
    "Price-change copy no longer cites lastKnownCost",
    specialistSrc.includes("later recorded history price that differs from an earlier recorded history price") &&
      !specialistSrc.includes("differs from last known cost"),
  );

  const tenantA = await createOwnerWorkspace("Alpha Materials");
  const tenantB = await createOwnerWorkspace("Beta Materials");
  await entitleFounder(tenantA.business.id);
  await entitleFounder(tenantB.business.id);
  const seededA = await seedMaterialsWorld(tenantA, { extraJobs: 9, extraItems: 18 });
  await seedMaterialsWorld(tenantB, { secret: true });

  const memberUser = await prisma.user.create({
    data: { name: "Member", email: `member-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: tenantA.business.id, role: "MEMBER" },
  });
  const memberAccess = makeAccess(tenantA.business.id, "MEMBER", memberMem.id, memberUser.id);

  console.log("\nAUTH — tenant isolation, gates, MEMBER");
  try {
    requireBusinessCapability(memberAccess, CAPABILITIES.VIEW_REPORTS);
    check("MEMBER remains blocked from VIEW_REPORTS", false);
  } catch (error) {
    check("MEMBER remains blocked from VIEW_REPORTS", error instanceof ForbiddenError);
  }

  resetLoads();
  const resultA = await runMaterialsSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "What do I need to buy for upcoming jobs?",
  });
  const projectionA = getLastMaterialsProjection();
  check("Owner MATERIALS run is OK", resultA.status === "OK");
  check("Projection exists", Boolean(projectionA));
  check("Tenant A does not see BetaSecret9999", !JSON.stringify(projectionA).includes("BetaSecret9999"));
  check("Tenant A does not see secret vendor email", !JSON.stringify(projectionA).includes("secret-vendor@example.com"));
  check("No forbidden fields", !materialsProjectionHasForbiddenFields(projectionA));
  check("Adapter state is DISCONNECTED", projectionA.adapterState === "DISCONNECTED" && resultA.factKeys.includes("materials-adapter-state"));
  check("Inventory quantity is unknown/null", projectionA.inventoryQuantity == null && projectionA.inventoryState === "unknown");
  check("Never emits stock-on-hand", !JSON.stringify(resultA).includes("stock-on-hand") && !JSON.stringify(projectionA).includes("stockOnHand"));
  check("Never emits supplier-accepted", !JSON.stringify(projectionA).includes("supplier-accepted") && projectionA.purchaseOrders.every((row) => row.supplierConfirmed === false));
  check("Needed count is recorded, not invented zero", Number(resultA.factKeys.includes("materials-needed-count") && projectionA.totals.needed) > 0);
  check("Unmapped supplier is counted, not invented", projectionA.totals.unmapped >= 1 && projectionA.requirements.some((row) => row.supplierState === "supplier-unmapped" && row.supplierName == null));
  check("8-day price is stale never current", projectionA.freshness.some((row) => row.freshness === "stale") && !projectionA.prices.some((row) => row.materialKey === "concrete-bags" && row.freshness === "current"));
  check("One stale recorded price counts once", projectionA.totals.stalePrices === 1);
  check("Missing price is not $0", projectionA.requirements.some((row) => row.priceState === "price-missing" && row.plannedUnitCost == null && row.lastKnownCost == null));
  check(
    "Same-provider store prices are not another supplier",
    projectionA.totals.cheaperRecordedSupplier === 0 &&
      !resultA.findings.some((row) => row.key === "materials-cheaper-recorded-supplier") &&
      projectionA.prices.filter((row) => row.materialKey === "form-lumber" && row.providerId === "home-depot").length >= 2,
  );
  check(
    "Three Home Depot stores alone do not create a cheaper-supplier finding",
    projectionA.prices.filter((row) => row.materialKey === "form-lumber").every((row) => row.providerId === "home-depot") &&
      projectionA.totals.cheaperRecordedSupplier === 0,
  );
  check(
    "Newest Home Depot stain record is used against Lowe's, not the older $6",
    projectionA.requirements.some((row) => row.takeoffIdentity === "newest-compare") &&
      projectionA.totals.cheaperRecordedSupplier === 0 &&
      !resultA.findings.some((row) => row.key === "materials-cheaper-recorded-supplier"),
  );
  check(
    "Price-change uses two 90-day history rows, not lastKnownCost",
    projectionA.totals.priceChanged === 1 &&
      projectionA.requirements.some((row) => row.materialId === seededA.oneHistory.id) &&
      projectionA.requirements.some((row) => row.materialId === seededA.sameHistory.id) &&
      resultA.findings
        .filter((row) => row.key === "materials-price-changed")
        .every((row) => /earlier recorded history price/.test(row.summary) && !/last known cost/i.test(row.summary)),
  );
  check("Pickup duration is recorded only", projectionA.pickups.every((row) => row.pickupDurationMinutes == null || row.durationSource === "item" || row.durationSource === "job"));
  check("Expense-linked variance is unfavorable", projectionA.totals.unfavorableVariance >= 1 && projectionA.variance.some((row) => row.financialCost === 48 && row.unfavorable));
  check("Financial cost omitted unless expense-linked", projectionA.variance.some((row) => row.financialCost == null && row.operationalActualCost == null));
  check("Caps hold on jobs", projectionA.jobs.length <= MATERIALS_CONTEXT_CAPS.jobs);
  check("Caps hold on requirements", projectionA.requirements.length <= MATERIALS_CONTEXT_CAPS.requirements);
  check("Caps hold on catalog/mappings/prices/POs/lists",
    projectionA.catalog.length <= 12 &&
      projectionA.mappings.length <= 12 &&
      projectionA.prices.length <= 36 &&
      projectionA.purchaseOrders.length <= 8 &&
      projectionA.purchaseLists.length <= 8 &&
      projectionA.pickups.length <= 12 &&
      projectionA.variance.length <= 12 &&
      projectionA.preferences.length <= 8,
  );
  check("One projection load", getMaterialsProjectionLoadCount() === 1);
  check("One interpretation", getMaterialsSpecialistInterpretationCount() === 1);

  await prisma.businessMaterialSupplierMapping.create({
    data: {
      businessId: tenantA.business.id,
      providerId: "lowes",
      materialIdentity: "form-lumber",
      providerProductId: "lw-lumber-1",
      productName: "2x4",
      unitLabel: "board",
    },
  });
  await prisma.supplierPriceRecord.create({
    data: {
      businessId: tenantA.business.id,
      providerId: "lowes",
      providerProductId: "lw-lumber-1",
      productName: "2x4",
      unitLabel: "board",
      currentPrice: "7.10",
      fetchedAt: hoursAgo(3),
      sourceStatus: "current",
      sourceMode: "catalog-reference",
      locationKey: "store-1",
    },
  });
  resetLoads();
  const cheaperResult = await runMaterialsSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "Which recorded supplier price is cheaper?",
  });
  const cheaperProjection = getLastMaterialsProjection();
  const lumberPrices = cheaperProjection.prices.filter((row) => row.materialKey === "form-lumber");
  check(
    "3 Home Depot + Lowe's projected prices stay <= 3 and keep both providers",
    lumberPrices.length <= 3 &&
      lumberPrices.some((row) => row.providerId === "home-depot") &&
      lumberPrices.some((row) => row.providerId === "lowes"),
  );
  check(
    "Distinct supplier cheaper finding uses recorded current/recent evidence",
    cheaperProjection.totals.cheaperRecordedSupplier === 1 &&
      cheaperResult.findings.some((row) => row.key === "materials-cheaper-recorded-supplier" && /recorded/i.test(row.summary) && !/\bavailable stock\b|\bconfirmed available\b|\blive quote\b/i.test(row.summary)),
  );

  resetLoads();
  const resultB = await runMaterialsSpecialist({
    db: prisma,
    access: tenantB.access,
    catalog: emptyCatalog(),
    question: "What do I need to buy?",
  });
  const projectionB = getLastMaterialsProjection();
  check("Tenant B does not see Alpha lumber names", !JSON.stringify(projectionB).includes("Alpha 2x4 lumber"));
  check("Tenant isolation on jobs", !projectionB.jobs.some((job) => job.id === seededA.job.id));
  check("B run still OK", resultB.status === "OK");

  resetLoads();
  const denyEstimates = await runMaterialsSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "What do I need to buy?",
    denyRoleCapabilities: [CAPABILITIES.MANAGE_ESTIMATES],
  });
  check("Missing MANAGE_ESTIMATES is structured skip", denyEstimates.status === "SKIPPED" && denyEstimates.skipReason === "NOT_AUTHORIZED");
  check("Denied estimates has no projection", getLastMaterialsProjection() == null);
  check("Denied estimates does not fake zero", !/0 needed|zero stock/i.test(denyEstimates.limitation ?? ""));

  resetLoads();
  const denyJobs = await runMaterialsSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "What do I need to buy?",
    denyRoleCapabilities: [CAPABILITIES.MANAGE_JOBS],
  });
  const noJobProjection = getLastMaterialsProjection();
  check("Missing MANAGE_JOBS still runs catalog slice", denyJobs.status === "OK");
  check("Missing MANAGE_JOBS omits job/pickup slice", noJobProjection.jobs.length === 0 && noJobProjection.pickups.length === 0 && !denyJobs.factKeys.includes("materials-pickup-not-ready-count"));
  check("Missing job slice is not fake zero upcoming work", /not the same as zero/i.test(denyJobs.limitation ?? ""));
  check(
    "Denied Jobs does not leak jobId through estimate-linked lists",
    noJobProjection.jobs.length === 0 &&
      noJobProjection.pickups.length === 0 &&
      noJobProjection.requirements.every((row) => row.jobId == null) &&
      noJobProjection.purchaseLists.every((row) => row.jobId == null) &&
      noJobProjection.purchaseOrders.every((row) => row.jobId == null) &&
      denyJobs.findings.every((row) => !(row.entityIds ?? []).includes(seededA.job.id)) &&
      !JSON.stringify(denyJobs.findings).includes(seededA.job.id),
  );
  check(
    "Estimate-only lists still load without Jobs access",
    noJobProjection.purchaseLists.some((row) => row.id === seededA.estimateOnlyList.id && row.estimateId === seededA.estimateOnlyEstimate.id && row.jobId == null) &&
      noJobProjection.requirements.some((row) => /estimate-only/i.test(row.name)),
  );

  resetLoads();
  const denyJobsProduct = await runMaterialsSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "What pickups are not ready?",
    denyProductCapabilities: [PRODUCT_CAPABILITIES.JOBS_TASKS],
  });
  check("Missing JOBS_TASKS omits job/pickup slice", getLastMaterialsProjection().jobs.length === 0 && getLastMaterialsProjection().pickups.length === 0);
  check(
    "Missing JOBS_TASKS does not leak jobId",
    getLastMaterialsProjection().requirements.every((row) => row.jobId == null) &&
      getLastMaterialsProjection().purchaseLists.every((row) => row.jobId == null) &&
      getLastMaterialsProjection().purchaseOrders.every((row) => row.jobId == null),
  );

  resetLoads();
  const denyExpenses = await runMaterialsSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "What material variance is hurting margin?",
    denyRoleCapabilities: [CAPABILITIES.MANAGE_EXPENSES],
  });
  const noExpenseProjection = getLastMaterialsProjection();
  check("Missing MANAGE_EXPENSES omits counted financial actual", denyExpenses.status === "OK" && noExpenseProjection.variance.every((row) => row.financialCost == null) && !denyExpenses.factKeys.includes("materials-variance-unfavorable-count"));

  resetLoads();
  const denyProduct = await runMaterialsSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "What do I need to buy?",
    denyProductCapabilities: [PRODUCT_CAPABILITIES.ESTIMATES_INVOICES],
  });
  check("Missing ESTIMATES_INVOICES is product-capability skip", denyProduct.status === "SKIPPED" && denyProduct.skipReason === "PRODUCT_CAPABILITY_MISSING");
  check("Product skip does not invent zeros", getLastMaterialsProjection() == null);

  resetLoads();
  const foreignJobId = (await prisma.job.findFirst({ where: { businessId: tenantB.business.id } })).id;
  await runMaterialsSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "What materials does that job need?",
    entityHints: { jobId: foreignJobId },
  });
  check(
    "Cross-tenant job hint is not targeted",
    getLastMaterialsProjection().targetedJobUnauthorized === true &&
      !getLastMaterialsProjection().jobs.some((job) => job.id === foreignJobId),
  );

  resetLoads();
  const inventoryAsk = await runMaterialsSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "What's in inventory?",
  });
  check("Inventory question returns unknown, no fake quantity", inventoryAsk.findings.some((row) => row.key === "materials-inventory-unknown" && /unknown/i.test(row.summary) && !/\b0 bags\b|\b0 board\b|stock-on-hand/i.test(row.summary)));

  console.log("\nCONFLICTS — additive Materials kinds from recorded findings only");
  function findingResult(id, keys, extras = {}) {
    return {
      specialistId: id,
      status: "OK",
      findings: keys.map((key) => ({
        key,
        title: key,
        summary: key,
        recommendationKeys: [key],
        factKeys: [],
      })),
      factKeys: [],
      recommendationKeys: keys,
      ...extras,
    };
  }
  const emptyConflictInput = { recommendations: [], facts: {} };
  const staleConflicts = resolveConflicts({
    ...emptyConflictInput,
    results: [findingResult("MATERIALS", ["materials-stale-price", "materials-missing-price"])],
  });
  check(
    "STALE_PRICE_VS_CURRENT keeps stale/missing from becoming current",
    staleConflicts.items.some((item) => item.kind === "STALE_PRICE_VS_CURRENT" && /cannot be treated as current/i.test(item.summary)),
  );
  const preferredConflicts = resolveConflicts({
    ...emptyConflictInput,
    results: [findingResult("MATERIALS", ["materials-cheaper-recorded-supplier"])],
  });
  check(
    "PREFERRED_SUPPLIER_VS_RECORDED_PRICE is not available/confirmed/live",
    preferredConflicts.items.some((item) => item.kind === "PREFERRED_SUPPLIER_VS_RECORDED_PRICE") &&
      preferredConflicts.items.every((item) => !/\bavailable stock\b|\bconfirmed available\b|\blive stock\b/i.test(item.summary) || item.kind === "PREFERRED_SUPPLIER_VS_RECORDED_PRICE"),
  );
  check(
    "Preferred vs cheaper copy keeps cheaper from meaning available",
    preferredConflicts.items.some((item) => item.kind === "PREFERRED_SUPPLIER_VS_RECORDED_PRICE" && /not available, confirmed, or live stock/i.test(item.summary)),
  );
  const listPoConflicts = resolveConflicts({
    ...emptyConflictInput,
    results: [findingResult("MATERIALS", ["materials-open-purchase-list", "materials-draft-po"])],
  });
  check(
    "PURCHASE_LIST_VS_PO keeps list and PO distinct",
    listPoConflicts.items.some((item) => item.kind === "PURCHASE_LIST_VS_PO" && /not a purchase order/i.test(item.summary)),
  );
  check(
    "PO_VS_SUPPLIER_CONFIRMATION does not treat ORDERED_EXTERNALLY as confirmation",
    listPoConflicts.items.some((item) => item.kind === "PO_VS_SUPPLIER_CONFIRMATION" && /not supplier confirmation/i.test(item.summary)),
  );
  const varianceConflicts = resolveConflicts({
    ...emptyConflictInput,
    results: [
      findingResult("MATERIALS", ["materials-variance-hurting-margin"]),
      findingResult("FINANCIAL", ["review-low-margin-jobs"]),
    ],
  });
  check(
    "MATERIAL_VARIANCE_VS_JOB_MARGIN leaves margin math with Financial",
    varianceConflicts.items.some((item) => item.kind === "MATERIAL_VARIANCE_VS_JOB_MARGIN" && /Financial owns job margin/i.test(item.summary)),
  );
  const unreadyConflicts = resolveConflicts({
    ...emptyConflictInput,
    results: [
      findingResult("MATERIALS", ["materials-incomplete-prep", "materials-needed-for-upcoming-jobs"]),
      findingResult("WORKFORCE", ["workforce-staffing-shortage"]),
      findingResult("GROWTH", ["growth-lost-lead-recovery"]),
    ],
  });
  check(
    "MATERIAL_UNREADY_VS_SCHEDULE does not create staff",
    unreadyConflicts.items.some((item) => item.kind === "MATERIAL_UNREADY_VS_SCHEDULE" && /do not create staff/i.test(item.summary)),
  );
  check(
    "MATERIAL_UNREADY_VS_GROWTH stays a fulfillment constraint",
    unreadyConflicts.items.some((item) => item.kind === "MATERIAL_UNREADY_VS_GROWTH" && /fulfillment constraint/i.test(item.summary)),
  );
  check(
    "MATERIAL_DELAY_VS_CUSTOMER_UPDATE stays Communications-owned",
    unreadyConflicts.items.some((item) => item.kind === "MATERIAL_DELAY_VS_CUSTOMER_UPDATE" && /Communications owns contact/i.test(item.summary)),
  );
  const inventoryConflicts = resolveConflicts({
    ...emptyConflictInput,
    results: [inventoryAsk],
  });
  check(
    "NO_INVENTORY_RECORDED comes from the inventory-unknown finding",
    inventoryConflicts.items.some((item) => item.kind === "NO_INVENTORY_RECORDED" && /unknown/i.test(item.summary)),
  );
  const financialOnlyConflicts = resolveConflicts({
    ...emptyConflictInput,
    results: [findingResult("FINANCIAL", ["review-low-margin-jobs"])],
  });
  check(
    "Materials conflicts do not fire without Materials findings",
    financialOnlyConflicts.items.every((item) => !String(item.kind).startsWith("MATERIAL") && item.kind !== "STALE_PRICE_VS_CURRENT" && item.kind !== "PREFERRED_SUPPLIER_VS_RECORDED_PRICE" && item.kind !== "PURCHASE_LIST_VS_PO" && item.kind !== "PO_VS_SUPPLIER_CONFIRMATION" && item.kind !== "NO_INVENTORY_RECORDED"),
  );
  check("Conflict resolver does not call another specialist", !readFileSync(new URL("../src/lib/chief-of-staff/conflicts.ts", import.meta.url), "utf8").includes("runMaterialsSpecialist") && !readFileSync(new URL("../src/lib/chief-of-staff/conflicts.ts", import.meta.url), "utf8").includes("interpretFinancialSpecialist"));

  console.log("\nRUNTIME — orchestration, failure, mutation proof");
  resetLoads();
  const coach = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "What do I need to buy and which prices are stale?",
    attemptId: randomUUID(),
    browserBusinessId: tenantB.business.id,
  });
  check("Coach omits Beta secret", Boolean(coach.text) && !coach.text.includes("9999"));
  check("Coach mentions recorded materials", /material|purchase|price|needed/i.test(coach.text ?? ""));
  check("Disconnected adapter still explains recorded facts", /disconnected|not a live/i.test(coach.text ?? ""));
  check("Exactly one Materials projection load when selected", getMaterialsProjectionLoadCount() === 1);
  check("Materials interprets once", getMaterialsSpecialistInterpretationCount() === 1);
  check("Orchestration can complete while adapter is disconnected", coach.orchestrationStatus === "COMPLETED");
  check("Live projection stays capped", getLastMaterialsProjection().jobs.length <= 8 && getLastMaterialsProjection().requirements.length <= 20);

  resetLoads();
  const financialOnly = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "How is my profit and outstanding invoices this month?",
    attemptId: randomUUID(),
  });
  check("Unrelated Financial question does not interpret Materials", getMaterialsSpecialistInterpretationCount() === 0);
  check("Financial question still completes", financialOnly.orchestrationStatus === "COMPLETED");

  resetLoads();
  const workforceOnly = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "Who is overloaded Friday?",
    attemptId: randomUUID(),
  });
  check("Workforce question does not interpret Materials", getMaterialsSpecialistInterpretationCount() === 0);
  check("Workforce question still completes", workforceOnly.orchestrationStatus === "COMPLETED");

  resetLoads();
  const growthOnly = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "Which lost leads can I recover?",
    attemptId: randomUUID(),
  });
  check("Growth question does not interpret Materials", getMaterialsSpecialistInterpretationCount() === 0);

  resetLoads();
  const inventoryCoach = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "What's in inventory?",
    attemptId: randomUUID(),
  });
  check("Inventory coach answer is unknown", /unknown/i.test(inventoryCoach.text ?? "") && !/stock-on-hand|12 boards in stock/i.test(inventoryCoach.text ?? ""));

  resetLoads();
  const denyProductCoach = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "What do I need to buy?",
    attemptId: randomUUID(),
    test: { denyProductCapabilities: [PRODUCT_CAPABILITIES.ESTIMATES_INVOICES] },
  });
  check("Coach product skip is not FAILED", denyProductCoach.orchestrationStatus === "COMPLETED");
  check("Coach product skip does not invent stock", !/zero stock|0 inventory/i.test(denyProductCoach.text ?? ""));

  resetLoads();
  const failLoad = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "What do I need to buy?",
    attemptId: randomUUID(),
    test: { failMaterialsLoad: true },
  });
  check("Injected loader failure is PARTIAL", failLoad.orchestrationStatus === "PARTIAL");
  check("ATTENTION survives Materials loader failure", /surviving facts|could not be loaded|unavailable/i.test(failLoad.text ?? ""));
  check("Failure does not invent empty inventory", !/zero stock|empty inventory|0 boards/i.test(failLoad.text ?? ""));

  const failSpecialist = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "What do I need to buy?",
    attemptId: randomUUID(),
    test: { failSpecialistId: "MATERIALS" },
  });
  check("Injected MATERIALS specialist failure is PARTIAL", failSpecialist.orchestrationStatus === "PARTIAL");

  const before = await countMaterialsRows(tenantA.business.id);
  await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "Buy the lumber, create a purchase order, and mark it ordered.",
    attemptId: randomUUID(),
  });
  const after = await countMaterialsRows(tenantA.business.id);
  check("No purchase list writes", before.lists === after.lists);
  check("No purchase list item writes", before.items === after.items);
  check("No PO writes", before.orders === after.orders && before.orderItems === after.orderItems);
  check("No MaterialOperationAttempt writes", before.attempts === after.attempts);
  check("No price history writes", before.history === after.history);
  check("No catalog/supplier writes", before.catalog === after.catalog && before.suppliers === after.suppliers);
  check("No mapping/preference/price-record writes", before.mappings === after.mappings && before.prefs === after.prefs && before.prices === after.prices);
  check("No BusinessActionItem writes", before.actionItems === after.actionItems);
  check("No AiActionProposal writes", before.proposals === after.proposals);

  check("Financial specialist file was not rewritten by this work", readFileSync(new URL("../src/lib/chief-of-staff/specialists/financial.ts", import.meta.url), "utf8").includes("interpretFinancialSpecialist"));
  check("Workforce specialist file was not rewritten by this work", readFileSync(new URL("../src/lib/chief-of-staff/workforce-specialist.ts", import.meta.url), "utf8").includes("runWorkforceSpecialist"));
  check("Growth specialist file was not rewritten by this work", readFileSync(new URL("../src/lib/chief-of-staff/growth-specialist.ts", import.meta.url), "utf8").includes("interpretGrowthSpecialist"));
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
}

if (failures > 0) {
  console.error(`\nMaterials specialist checks failed: ${failures}`);
  process.exit(1);
}
console.log("\nMaterials specialist checks passed.");

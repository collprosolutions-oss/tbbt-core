/**
 * Deep MATERIALS specialist. Same specialist identity as the PR1 placeholder.
 *
 * Loads one bounded read-only projection when selected. Does not write
 * purchase lists, POs, attempts, action items, or supplier commerce.
 * Does not call Financial, Workforce, Growth, or Communications.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, roleHasCapability, type Capability } from "@/lib/authorization";
import type { CanonicalRecommendationCatalog } from "@/lib/chief-of-staff/recommendations";
import {
  recordMaterialsProjectionLoad,
  recordMaterialsSpecialistInterpretation,
  shouldInjectMaterialsLoadFailure,
} from "@/lib/chief-of-staff/materials-snapshot";
import type {
  CosEntityHints,
  SpecialistFinding,
  SpecialistResult,
  SpecialistSkipReason,
} from "@/lib/chief-of-staff/types";
import {
  getSupplierCommerceAdapter,
  SUPPLIER_COMMERCE_DISCONNECTED_LIMITATION,
} from "@/lib/materials/adapter";
import { financialMaterialCost } from "@/lib/materials/expense-link";
import { asMoneyNumber } from "@/lib/materials/money";
import {
  classifySupplierPriceFreshness,
} from "@/lib/material-pricing/freshness";
import type { SupplierPriceFreshness } from "@/lib/material-pricing/types";
import { getProductCapabilityDefinition } from "@/lib/product-catalog";
import { PRODUCT_CAPABILITIES, type ProductCapabilityCode } from "@/lib/product-catalog/codes";
import { resolveProductEntitlement } from "@/lib/product-entitlements";

type Db = PrismaClient | Prisma.TransactionClient;

const PRICE_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;
const REQUIREMENT_STATUSES = ["NEEDED", "PLANNED", "ORDERED"] as const;
const RELEVANT_PO_STATUSES = ["DRAFT", "READY", "ORDERED_EXTERNALLY"] as const;
const COMPARABLE_FRESHNESS = new Set<SupplierPriceFreshness>(["current", "recently_checked"]);

export const MATERIALS_OWNED_RECOMMENDATION_KEYS = [
  "materials-needed-for-upcoming-jobs",
  "materials-incomplete-prep",
  "materials-open-purchase-list",
  "materials-draft-po",
  "materials-stale-price",
  "materials-missing-price",
  "materials-unmapped-supplier",
  "materials-price-changed",
  "materials-cheaper-recorded-supplier",
  "materials-variance-hurting-margin",
  "materials-adapter-disconnected",
] as const;

export type MaterialsOwnedRecommendationKey = (typeof MATERIALS_OWNED_RECOMMENDATION_KEYS)[number];

export const MATERIALS_CONTEXT_CAPS = {
  jobs: 8,
  requirements: 20,
  catalog: 12,
  mappings: 12,
  pricesPerMaterial: 3,
  pricedMaterials: 12,
  freshness: 12,
  purchaseLists: 8,
  purchaseOrders: 8,
  variance: 12,
  pickups: 12,
  preferences: 8,
  findings: 16,
  facts: 24,
  entityIds: 4,
} as const;

export const MATERIALS_REQUIRED_PRODUCT_CAPABILITIES = [
  PRODUCT_CAPABILITIES.ESTIMATES_INVOICES,
] as const;

const FORBIDDEN_PROJECTION_KEYS = [
  "email",
  "phone",
  "contactEmail",
  "contactPhone",
  "contactValue",
  "accountReference",
  "rawMetadata",
  "stockOnHand",
  "stock-on-hand",
  "supplierAccepted",
  "supplier-accepted",
  "hourlyWage",
  "workforceNotes",
  "propertyAccessInstructions",
  "secret",
  "apiKey",
  "password",
];

export function isMaterialsOwnedRecommendationKey(key: string): boolean {
  return key.startsWith("materials-");
}

export function materialsEntitlementLimitation(reason: SpecialistSkipReason, missing?: readonly string[]) {
  if (reason === "NOT_AUTHORIZED") {
    return "Materials catalog and supplier records were not loaded because this role cannot manage estimates. Missing Materials data is not treated as empty recorded requirements.";
  }
  if (reason === "NOT_ENTITLED") {
    return "Materials records were not loaded because this workspace does not have an active operating subscription. Missing Materials data is not treated as zero.";
  }
  if (reason === "PRODUCT_CAPABILITY_MISSING") {
    const names = (missing ?? MATERIALS_REQUIRED_PRODUCT_CAPABILITIES).map(
      (code) => getProductCapabilityDefinition(code as ProductCapabilityCode).displayName,
    );
    return `Materials intelligence was not loaded because this workspace does not have ${names.join(" and ")}. Missing Materials data is not treated as empty recorded requirements.`;
  }
  return "Recorded Materials data is unavailable. Missing Materials data is not treated as zero.";
}

export const MATERIALS_FAILURE_LIMITATION =
  "Recorded Materials data could not be loaded. No empty inventory, zero cost, or invented supplier was substituted.";

export type MaterialsUnknownState =
  | "unknown"
  | "price-missing"
  | "price-stale"
  | "supplier-unmapped"
  | "no-requirement";

export type MaterialsJobProjection = {
  id: string;
  status: string;
  scheduledAt: string | null;
  pickupDurationMinutes: number | null;
  targeted: boolean;
};

export type MaterialsRequirementProjection = {
  id: string;
  purchaseListId: string;
  jobId: string | null;
  estimateId: string | null;
  name: string;
  status: string;
  quantityNeeded: number | null;
  unit: string;
  materialId: string | null;
  takeoffIdentity: string | null;
  supplierId: string | null;
  supplierName: string | null;
  preferredSupplierId: string | null;
  plannedUnitCost: number | null;
  lastKnownCost: number | null;
  priceState: MaterialsUnknownState | "recorded";
  supplierState: MaterialsUnknownState | "recorded";
  pickupRequired: boolean;
  pickupReady: boolean;
  pickupDurationMinutes: number | null;
};

export type MaterialsCatalogRef = {
  id: string;
  name: string;
  unit: string;
  takeoffIdentity: string | null;
  lastKnownCost: number | null;
  lastKnownCostAt: string | null;
  preferredSupplierId: string | null;
};

export type MaterialsMappingRef = {
  materialIdentity: string;
  providerId: string;
  providerProductId: string | null;
  productName: string | null;
  unitLabel: string | null;
};

export type MaterialsPriceRef = {
  materialKey: string;
  providerId: string;
  providerProductId: string | null;
  recordedPrice: number | null;
  fetchedAt: string | null;
  freshness: SupplierPriceFreshness;
  sourceMode: string | null;
  locationKey: string | null;
};

export type MaterialsPurchaseListRef = {
  id: string;
  jobId: string | null;
  estimateId: string | null;
};

export type MaterialsPurchaseOrderRef = {
  id: string;
  purchaseListId: string;
  jobId: string | null;
  supplierId: string | null;
  status: string;
  supplierConfirmed: false;
};

export type MaterialsVarianceRef = {
  purchaseListItemId: string;
  name: string;
  estimatedCost: number | null;
  operationalActualCost: number | null;
  financialCost: number | null;
  costDelta: number | null;
  unfavorable: boolean;
};

export type MaterialsPickupRef = {
  purchaseListItemId: string;
  jobId: string | null;
  name: string;
  pickupRequired: boolean;
  pickupReady: boolean;
  pickupDurationMinutes: number | null;
  durationSource: "item" | "job" | "unknown";
};

export type MaterialsPreferenceRef = {
  providerId: string;
  enabled: boolean;
};

export type MaterialsDependencySignal = {
  domain: "FINANCIAL" | "WORKFORCE" | "GROWTH" | "COMMUNICATIONS";
  kind: string;
  summary: string;
};

export type MaterialsProjectionTotals = {
  jobs: number;
  requirements: number;
  needed: number;
  unmapped: number;
  stalePrices: number;
  missingPrices: number;
  openPurchaseOrders: number;
  draftPurchaseOrders: number;
  incompletePrep: number;
  pickupNotReady: number;
  unfavorableVariance: number;
  priceChanged: number;
  cheaperRecordedSupplier: number;
};

export type MaterialsProjection = {
  totals: MaterialsProjectionTotals;
  jobs: MaterialsJobProjection[];
  requirements: MaterialsRequirementProjection[];
  catalog: MaterialsCatalogRef[];
  mappings: MaterialsMappingRef[];
  prices: MaterialsPriceRef[];
  freshness: Array<{ materialKey: string; freshness: SupplierPriceFreshness }>;
  purchaseLists: MaterialsPurchaseListRef[];
  purchaseOrders: MaterialsPurchaseOrderRef[];
  variance: MaterialsVarianceRef[];
  pickups: MaterialsPickupRef[];
  preferences: MaterialsPreferenceRef[];
  adapterState: "DISCONNECTED";
  adapterLimitation: string;
  inventoryQuantity: null;
  inventoryState: "unknown";
  canReadJobs: boolean;
  canReadExpenses: boolean;
  canReadEstimates: boolean;
  targetedJobUnauthorized: boolean;
  signals: MaterialsDependencySignal[];
  snapshotReused: false;
};

export type MaterialsSpecialistInput = {
  db: Db;
  access: BusinessAccess;
  catalog: CanonicalRecommendationCatalog;
  question: string;
  entityHints?: CosEntityHints;
  denyProductCapabilities?: ProductCapabilityCode[];
  denyRoleCapabilities?: Capability[];
};

let lastMaterialsProjection: MaterialsProjection | null = null;

export function resetLastMaterialsProjection() {
  lastMaterialsProjection = null;
}

export function getLastMaterialsProjection() {
  return lastMaterialsProjection;
}

function money(value: { toString(): string } | null | undefined) {
  return asMoneyNumber(value);
}

function addFact(facts: Record<string, string>, keys: string[], key: string, value: string) {
  if (keys.includes(key) || keys.length >= MATERIALS_CONTEXT_CAPS.facts) return;
  facts[key] = value;
  keys.push(key);
}

function hasRole(
  access: BusinessAccess,
  capability: Capability,
  deny?: Capability[],
) {
  if (deny?.includes(capability)) return false;
  return roleHasCapability(access.workspace.role, capability);
}

function hasDeniedProduct(code: ProductCapabilityCode, deny?: ProductCapabilityCode[]) {
  return Boolean(deny?.includes(code));
}

function staleMaterialKey(row: {
  materialId?: string | null;
  takeoffIdentity?: string | null;
  materialKey?: string;
}) {
  return row.takeoffIdentity || row.materialKey || row.materialId || null;
}

export function countDistinctStaleMaterials(
  requirements: Array<{
    materialId: string | null;
    takeoffIdentity: string | null;
    priceState: string;
  }>,
  freshnessRows: Array<{ materialKey: string; freshness: SupplierPriceFreshness }>,
) {
  const keys = new Set<string>();
  for (const row of requirements) {
    if (row.priceState !== "price-stale") continue;
    const key = staleMaterialKey(row);
    if (key) keys.add(key);
  }
  for (const row of freshnessRows) {
    if (row.freshness !== "stale") continue;
    const key = staleMaterialKey(row);
    if (key) keys.add(key);
  }
  return keys.size;
}

export function countPriceChangesFromHistory(
  historyByMaterial: Map<string, Array<{ price: { toString(): string } | number | null }>>,
) {
  let changed = 0;
  for (const rows of historyByMaterial.values()) {
    const prices = rows
      .map((row) => money(row.price))
      .filter((value): value is number => value != null);
    if (prices.length < 2) continue;
    if (prices.some((value) => value !== prices[0])) changed += 1;
  }
  return changed;
}

function fetchedAtMs(row: { fetchedAt?: string | null }) {
  if (!row.fetchedAt) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(row.fetchedAt);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

function priceRowKey(row: MaterialsPriceRef) {
  return `${row.providerId}\0${row.providerProductId ?? ""}\0${row.locationKey ?? ""}\0${row.fetchedAt ?? ""}`;
}

export function latestComparableByProvider(rows: MaterialsPriceRef[]) {
  const latestByProvider = new Map<string, MaterialsPriceRef>();
  for (const row of rows) {
    if (row.recordedPrice == null || !COMPARABLE_FRESHNESS.has(row.freshness)) continue;
    const existing = latestByProvider.get(row.providerId);
    if (!existing || fetchedAtMs(row) > fetchedAtMs(existing)) {
      latestByProvider.set(row.providerId, row);
    }
  }
  return [...latestByProvider.values()].sort((a, b) => fetchedAtMs(b) - fetchedAtMs(a));
}

export function selectProjectedSupplierPrices(
  rows: MaterialsPriceRef[],
  cap = MATERIALS_CONTEXT_CAPS.pricesPerMaterial,
) {
  const selected: MaterialsPriceRef[] = [];
  const seen = new Set<string>();
  for (const row of latestComparableByProvider(rows)) {
    if (selected.length >= cap) break;
    selected.push(row);
    seen.add(priceRowKey(row));
  }
  const rest = [...rows].sort((a, b) => fetchedAtMs(b) - fetchedAtMs(a));
  for (const row of rest) {
    if (selected.length >= cap) break;
    const key = priceRowKey(row);
    if (seen.has(key)) continue;
    selected.push(row);
    seen.add(key);
  }
  return selected;
}

export function countCheaperRecordedSuppliers(
  pricesByIdentity: Map<string, MaterialsPriceRef[]>,
) {
  let cheaper = 0;
  for (const recorded of pricesByIdentity.values()) {
    const latestByProvider = latestComparableByProvider(recorded);
    if (latestByProvider.length < 2) continue;
    const pricesOnly = latestByProvider.map((row) => row.recordedPrice as number);
    if (Math.min(...pricesOnly) < Math.max(...pricesOnly)) cheaper += 1;
  }
  return cheaper;
}

function assertSafeProjection(projection: MaterialsProjection) {
  const raw = JSON.stringify(projection);
  for (const key of FORBIDDEN_PROJECTION_KEYS) {
    if (raw.includes(`"${key}"`)) {
      throw new Error("Materials projection leaked a forbidden field.");
    }
  }
  if (/"stock-on-hand"|"supplier-accepted"|"stockOnHand"|"supplierAccepted"/.test(raw)) {
    throw new Error("Materials projection invented inventory or supplier confirmation.");
  }
}

export function materialsProjectionHasForbiddenFields(value: unknown) {
  const raw = JSON.stringify(value);
  return (
    FORBIDDEN_PROJECTION_KEYS.some(
      (key) => raw.includes(`"${key}"`) || new RegExp(`"${key}":`, "i").test(raw),
    ) || /"stock-on-hand"|"supplier-accepted"/.test(raw)
  );
}

function startOfToday(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function inventoryQuestion(question: string) {
  return /\b(inventory|stock(?: on hand)?|in stock|how many .* (?:on hand|in stock))\b/i.test(question);
}

function emptyTotals(): MaterialsProjectionTotals {
  return {
    jobs: 0,
    requirements: 0,
    needed: 0,
    unmapped: 0,
    stalePrices: 0,
    missingPrices: 0,
    openPurchaseOrders: 0,
    draftPurchaseOrders: 0,
    incompletePrep: 0,
    pickupNotReady: 0,
    unfavorableVariance: 0,
    priceChanged: 0,
    cheaperRecordedSupplier: 0,
  };
}

type GateDecision =
  | { status: "ok"; canJobs: boolean; canExpenses: boolean; canEstimates: boolean }
  | { status: "skip"; skipReason: SpecialistSkipReason; limitation: string };

async function resolveMaterialsGates(
  db: Db,
  access: BusinessAccess,
  denyProductCapabilities?: ProductCapabilityCode[],
  denyRoleCapabilities?: Capability[],
): Promise<GateDecision> {
  const canManageEstimates = hasRole(access, CAPABILITIES.MANAGE_ESTIMATES, denyRoleCapabilities);
  if (!canManageEstimates) {
    return {
      status: "skip",
      skipReason: "NOT_AUTHORIZED",
      limitation: materialsEntitlementLimitation("NOT_AUTHORIZED"),
    };
  }

  const business = await db.business.findFirst({
    where: { id: access.businessId },
    select: { id: true, slug: true },
  });
  if (!business) {
    return {
      status: "skip",
      skipReason: "UNAVAILABLE",
      limitation: materialsEntitlementLimitation("UNAVAILABLE"),
    };
  }

  const entitlement = await resolveProductEntitlement(db, business);
  if (!entitlement.operating.canOperate) {
    return {
      status: "skip",
      skipReason: "NOT_ENTITLED",
      limitation: materialsEntitlementLimitation("NOT_ENTITLED"),
    };
  }

  const hasEstimatesInvoices =
    entitlement.capabilities.includes(PRODUCT_CAPABILITIES.ESTIMATES_INVOICES) &&
    !hasDeniedProduct(PRODUCT_CAPABILITIES.ESTIMATES_INVOICES, denyProductCapabilities);
  if (!hasEstimatesInvoices) {
    return {
      status: "skip",
      skipReason: "PRODUCT_CAPABILITY_MISSING",
      limitation: materialsEntitlementLimitation("PRODUCT_CAPABILITY_MISSING", [
        PRODUCT_CAPABILITIES.ESTIMATES_INVOICES,
      ]),
    };
  }

  const canJobsRole = hasRole(access, CAPABILITIES.MANAGE_JOBS, denyRoleCapabilities);
  const canJobsProduct =
    entitlement.capabilities.includes(PRODUCT_CAPABILITIES.JOBS_TASKS) &&
    !hasDeniedProduct(PRODUCT_CAPABILITIES.JOBS_TASKS, denyProductCapabilities);
  const canExpenses = hasRole(access, CAPABILITIES.MANAGE_EXPENSES, denyRoleCapabilities);

  return {
    status: "ok",
    canJobs: canJobsRole && canJobsProduct,
    canExpenses,
    canEstimates: true,
  };
}

function capInMemory<T>(rows: T[], cap: number) {
  return rows.slice(0, cap);
}

function groupTake<T>(rows: T[], keyOf: (row: T) => string, perKey: number, maxKeys: number) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!grouped.has(key) && grouped.size >= maxKeys) continue;
    const list = grouped.get(key) ?? [];
    if (list.length >= perKey) continue;
    list.push(row);
    grouped.set(key, list);
  }
  return [...grouped.values()].flat();
}

export async function loadMaterialsProjection(input: {
  db: Db;
  access: BusinessAccess;
  entityHints?: CosEntityHints;
  canJobs: boolean;
  canExpenses: boolean;
  canEstimates: boolean;
  now?: Date;
}): Promise<MaterialsProjection> {
  recordMaterialsProjectionLoad();
  if (shouldInjectMaterialsLoadFailure()) {
    throw new Error("injected materials load failure");
  }

  const now = input.now ?? new Date();
  const lookback = new Date(now.getTime() - PRICE_LOOKBACK_MS);
  const upcomingFrom = startOfToday(now);
  const businessId = input.access.businessId;
  const adapter = getSupplierCommerceAdapter();

  let targetedJobUnauthorized = false;
  let targetedJobId: string | null = null;
  if (input.entityHints?.jobId) {
    if (!input.canJobs) {
      targetedJobId = null;
    } else {
      const hinted = await input.db.job.findFirst({
        where: { id: input.entityHints.jobId, businessId },
        select: { id: true, businessId: true },
      });
      if (!hinted) targetedJobUnauthorized = true;
      else targetedJobId = hinted.id;
    }
  }

  const jobs = input.canJobs
    ? await input.db.job.findMany({
        where: {
          businessId,
          status: { not: "CANCELLED" },
          scheduledAt: { gte: upcomingFrom },
          OR: [
            { pickupDurationMinutes: { not: null } },
            { materialPurchaseLists: { some: {} } },
            { materialPurchaseOrders: { some: {} } },
          ],
        },
        orderBy: { scheduledAt: "asc" },
        take: MATERIALS_CONTEXT_CAPS.jobs + (targetedJobId ? 1 : 0),
        select: {
          id: true,
          status: true,
          scheduledAt: true,
          pickupDurationMinutes: true,
        },
      })
    : [];

  if (targetedJobId && input.canJobs && !jobs.some((job) => job.id === targetedJobId)) {
    const extra = await input.db.job.findFirst({
      where: { id: targetedJobId, businessId, status: { not: "CANCELLED" } },
      select: { id: true, status: true, scheduledAt: true, pickupDurationMinutes: true },
    });
    if (extra) jobs.unshift(extra);
  }

  const jobRows = capInMemory(
    targetedJobId ? [...jobs.filter((job) => job.id === targetedJobId), ...jobs.filter((job) => job.id !== targetedJobId)] : jobs,
    MATERIALS_CONTEXT_CAPS.jobs,
  );
  const jobIds = jobRows.map((job) => job.id);
  const jobPickupById = new Map(jobRows.map((job) => [job.id, job.pickupDurationMinutes]));

  const listWhere: Prisma.MaterialPurchaseListWhereInput = { businessId };
  let canQueryLists = false;
  if (input.canJobs && input.canEstimates) {
    const listOr: Prisma.MaterialPurchaseListWhereInput[] = [];
    if (jobIds.length > 0) listOr.push({ jobId: { in: jobIds } });
    listOr.push({ estimateId: { not: null }, jobId: null });
    listWhere.OR = listOr;
    canQueryLists = listOr.length > 0;
  } else if (input.canJobs && jobIds.length > 0) {
    listWhere.jobId = { in: jobIds };
    canQueryLists = true;
  } else if (input.canEstimates) {
    listWhere.estimateId = { not: null };
    listWhere.jobId = null;
    canQueryLists = true;
  }

  const purchaseLists = canQueryLists
    ? await input.db.materialPurchaseList.findMany({
        where: listWhere,
        orderBy: { updatedAt: "desc" },
        take: MATERIALS_CONTEXT_CAPS.purchaseLists,
        select: { id: true, jobId: true, estimateId: true },
      })
    : [];

  const listIds = purchaseLists.map((row) => row.id);
  const listById = new Map(purchaseLists.map((row) => [row.id, row]));

  const [items, purchaseOrders, preferences] = await Promise.all([
    listIds.length > 0
      ? input.db.materialPurchaseListItem.findMany({
          where: {
            businessId,
            purchaseListId: { in: listIds },
            status: { in: [...REQUIREMENT_STATUSES] },
          },
          orderBy: { createdAt: "asc" },
          take: MATERIALS_CONTEXT_CAPS.requirements,
          select: {
            id: true,
            purchaseListId: true,
            name: true,
            status: true,
            quantityNeeded: true,
            unit: true,
            materialId: true,
            supplierId: true,
            plannedUnitCost: true,
            plannedCost: true,
            actualCost: true,
            estimatedCost: true,
            estimatedQuantity: true,
            pickupRequired: true,
            pickupReady: true,
            pickupDurationMinutes: true,
            expenseId: true,
            material: {
              select: {
                id: true,
                name: true,
                unit: true,
                takeoffIdentity: true,
                lastKnownCost: true,
                lastKnownCostAt: true,
                preferredSupplierId: true,
              },
            },
            supplier: { select: { id: true, name: true, preferred: true } },
            expense: input.canExpenses
              ? { select: { amount: true, voidedAt: true } }
              : false,
          },
        })
      : Promise.resolve([]),
    listIds.length > 0
      ? input.db.materialPurchaseOrder.findMany({
          where: {
            businessId,
            purchaseListId: { in: listIds },
            status: { in: [...RELEVANT_PO_STATUSES] },
          },
          orderBy: { updatedAt: "desc" },
          take: MATERIALS_CONTEXT_CAPS.purchaseOrders,
          select: {
            id: true,
            purchaseListId: true,
            jobId: true,
            supplierId: true,
            status: true,
          },
        })
      : Promise.resolve([]),
    input.db.businessSupplierPreference.findMany({
      where: { businessId },
      take: MATERIALS_CONTEXT_CAPS.preferences,
      select: { providerId: true, enabled: true },
    }),
  ]);

  const referencedMaterialIds = [
    ...new Set(items.map((item) => item.materialId).filter((id): id is string => Boolean(id))),
  ].slice(0, MATERIALS_CONTEXT_CAPS.catalog);
  const referencedIdentities = [
    ...new Set(
      items
        .map((item) => item.material?.takeoffIdentity)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  const [catalogRows, historyRows, mappingsAll] = await Promise.all([
    referencedMaterialIds.length > 0
      ? input.db.materialCatalogItem.findMany({
          where: { businessId, id: { in: referencedMaterialIds } },
          take: MATERIALS_CONTEXT_CAPS.catalog,
          select: {
            id: true,
            name: true,
            unit: true,
            takeoffIdentity: true,
            lastKnownCost: true,
            lastKnownCostAt: true,
            preferredSupplierId: true,
          },
        })
      : Promise.resolve([]),
    referencedMaterialIds.length > 0
      ? input.db.materialPriceHistory.findMany({
          where: {
            businessId,
            materialId: { in: referencedMaterialIds },
            observedAt: { gte: lookback },
          },
          orderBy: { observedAt: "desc" },
          take: 80,
          select: {
            materialId: true,
            supplierId: true,
            price: true,
            observedAt: true,
            source: true,
          },
        })
      : Promise.resolve([]),
    referencedIdentities.length > 0
      ? input.db.businessMaterialSupplierMapping.findMany({
          where: { businessId, materialIdentity: { in: referencedIdentities } },
          take: MATERIALS_CONTEXT_CAPS.mappings,
          select: {
            materialIdentity: true,
            providerId: true,
            providerProductId: true,
            productName: true,
            unitLabel: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const mappings = capInMemory(mappingsAll, MATERIALS_CONTEXT_CAPS.mappings);
  const priceRows =
    mappings.length > 0
      ? await input.db.supplierPriceRecord.findMany({
          where: {
            businessId,
            OR: mappings.map((row) => ({
              providerId: row.providerId,
              providerProductId: row.providerProductId,
            })),
          },
          orderBy: [{ fetchedAt: "desc" }, { id: "desc" }],
          take: 40,
          select: {
            id: true,
            providerId: true,
            providerProductId: true,
            productName: true,
            currentPrice: true,
            fetchedAt: true,
            sourceStatus: true,
            sourceMode: true,
            locationKey: true,
          },
        })
      : [];

  const catalogById = new Map(catalogRows.map((row) => [row.id, row]));
  const mappingByIdentity = new Map(mappings.map((row) => [row.materialIdentity, row]));
  const historyCapped = groupTake(
    historyRows,
    (row) => row.materialId,
    MATERIALS_CONTEXT_CAPS.pricesPerMaterial,
    MATERIALS_CONTEXT_CAPS.pricedMaterials,
  );
  const historyByMaterial = new Map<string, typeof historyCapped>();
  for (const row of historyCapped) {
    const list = historyByMaterial.get(row.materialId) ?? [];
    list.push(row);
    historyByMaterial.set(row.materialId, list);
  }

  const candidatesByIdentity = new Map<string, MaterialsPriceRef[]>();
  for (const mapping of mappings) {
    const records = priceRows.filter(
      (row) =>
        row.providerId === mapping.providerId && row.providerProductId === mapping.providerProductId,
    );
    for (const record of records) {
      const freshness = classifySupplierPriceFreshness(record.fetchedAt, now);
      const ref: MaterialsPriceRef = {
        materialKey: mapping.materialIdentity,
        providerId: record.providerId,
        providerProductId: record.providerProductId,
        recordedPrice: money(record.currentPrice),
        fetchedAt: record.fetchedAt?.toISOString() ?? null,
        freshness,
        sourceMode: record.sourceMode,
        locationKey: record.locationKey,
      };
      const existing = candidatesByIdentity.get(mapping.materialIdentity) ?? [];
      existing.push(ref);
      candidatesByIdentity.set(mapping.materialIdentity, existing);
    }
  }

  const cheaperCandidates = new Map<string, MaterialsPriceRef[]>();
  const prices: MaterialsPriceRef[] = [];
  const freshnessRows: Array<{ materialKey: string; freshness: SupplierPriceFreshness }> = [];
  for (const [identity, candidates] of candidatesByIdentity) {
    if (cheaperCandidates.size >= MATERIALS_CONTEXT_CAPS.pricedMaterials) break;
    cheaperCandidates.set(identity, candidates);
    const selected = selectProjectedSupplierPrices(candidates);
    prices.push(...selected);
    const newest = [...candidates].sort((a, b) => fetchedAtMs(b) - fetchedAtMs(a))[0];
    if (newest) {
      freshnessRows.push({
        materialKey: identity,
        freshness: newest.freshness,
      });
    }
  }

  const pricesByIdentity = cheaperCandidates;
  const priced = groupTake(
    prices,
    (row) => row.materialKey,
    MATERIALS_CONTEXT_CAPS.pricesPerMaterial,
    MATERIALS_CONTEXT_CAPS.pricedMaterials,
  );
  const freshness = capInMemory(freshnessRows, MATERIALS_CONTEXT_CAPS.freshness);

  const requirements: MaterialsRequirementProjection[] = items.map((item) => {
    const list = listById.get(item.purchaseListId);
    const catalog = item.materialId ? catalogById.get(item.materialId) ?? item.material : item.material;
    const identity = catalog?.takeoffIdentity ?? null;
    const mapped = identity ? mappingByIdentity.get(identity) : undefined;
    const recordedPrices = identity ? pricesByIdentity.get(identity) ?? [] : [];
    const lastKnown = money(catalog?.lastKnownCost ?? null);
    const planned = money(item.plannedUnitCost);
    const latestFresh = recordedPrices[0];
    const latestHistory = item.materialId ? historyByMaterial.get(item.materialId)?.[0] : undefined;
    let priceState: MaterialsRequirementProjection["priceState"] = "recorded";
    if (latestFresh?.freshness === "stale" || (latestFresh == null && lastKnown == null && planned == null && !latestHistory)) {
      priceState = latestFresh?.freshness === "stale" ? "price-stale" : lastKnown == null && planned == null && !latestHistory ? "price-missing" : "recorded";
    } else if (latestFresh?.freshness === "unavailable" && lastKnown == null && planned == null && !latestHistory) {
      priceState = "price-missing";
    }
    const supplierState: MaterialsRequirementProjection["supplierState"] =
      item.supplierId || mapped ? "recorded" : "supplier-unmapped";
    const jobMinutes =
      input.canJobs && list?.jobId ? jobPickupById.get(list.jobId) ?? null : null;
    const pickupMinutes = item.pickupDurationMinutes ?? jobMinutes;
    return {
      id: item.id,
      purchaseListId: item.purchaseListId,
      jobId: input.canJobs ? list?.jobId ?? null : null,
      estimateId: list?.estimateId ?? null,
      name: item.name,
      status: item.status,
      quantityNeeded: money(item.quantityNeeded),
      unit: item.unit,
      materialId: item.materialId,
      takeoffIdentity: identity,
      supplierId: item.supplierId,
      supplierName: item.supplier?.name ?? null,
      preferredSupplierId: catalog?.preferredSupplierId ?? null,
      plannedUnitCost: planned,
      lastKnownCost: lastKnown,
      priceState,
      supplierState,
      pickupRequired: item.pickupRequired,
      pickupReady: item.pickupReady,
      pickupDurationMinutes: pickupMinutes,
    };
  });

  const variance: MaterialsVarianceRef[] = items.flatMap((item) => {
    const estimatedCost = money(item.estimatedCost ?? item.plannedCost);
    const operationalActualCost = money(item.actualCost);
    const expense =
      input.canExpenses && "expense" in item
        ? (item.expense as { amount: { toString(): string }; voidedAt: Date | null } | null)
        : null;
    const financial = input.canExpenses
      ? financialMaterialCost({
          actualCost: item.actualCost,
          expense,
        })
      : { amount: null, source: "UNLINKED_OPERATIONAL" as const };
    const financialCost = financial.source === "EXPENSE" ? financial.amount : null;
    const compared = financialCost ?? null;
    const costDelta =
      estimatedCost != null && compared != null ? compared - estimatedCost : null;
    if (estimatedCost == null && operationalActualCost == null && financialCost == null) {
      return [];
    }
    return [
      {
        purchaseListItemId: item.id,
        name: item.name,
        estimatedCost,
        operationalActualCost,
        financialCost,
        costDelta,
        unfavorable: costDelta != null && costDelta > 0,
      },
    ];
  });

  const pickups: MaterialsPickupRef[] = input.canJobs
    ? items
        .filter((item) => item.pickupRequired)
        .map((item) => {
          const list = listById.get(item.purchaseListId);
          const jobMinutes = list?.jobId ? jobPickupById.get(list.jobId) ?? null : null;
          const itemMinutes = item.pickupDurationMinutes;
          return {
            purchaseListItemId: item.id,
            jobId: list?.jobId ?? null,
            name: item.name,
            pickupRequired: true,
            pickupReady: item.pickupReady,
            pickupDurationMinutes: itemMinutes ?? jobMinutes,
            durationSource: itemMinutes != null ? "item" : jobMinutes != null ? "job" : "unknown",
          };
        })
    : [];

  const cheaperRecorded = countCheaperRecordedSuppliers(pricesByIdentity);
  const priceChanged = countPriceChangesFromHistory(historyByMaterial);

  const unmapped = requirements.filter((row) => row.supplierState === "supplier-unmapped").length;
  const stalePrices = countDistinctStaleMaterials(requirements, freshness);
  const missingPrices = requirements.filter((row) => row.priceState === "price-missing").length;
  const needed = requirements.filter((row) => row.status === "NEEDED").length;
  const incompletePrep = requirements.filter(
    (row) => row.pickupRequired && (!row.pickupReady || row.pickupDurationMinutes == null),
  ).length;
  const pickupNotReady = pickups.filter((row) => !row.pickupReady).length;
  const unfavorableVariance = variance.filter((row) => row.unfavorable && row.financialCost != null).length;

  const signals: MaterialsDependencySignal[] = [];
  if (unfavorableVariance > 0) {
    signals.push({
      domain: "FINANCIAL",
      kind: "recorded-material-cost",
      summary:
        "Recorded Materials variance exists. Financial owns margin math; Materials only reports recorded estimate vs expense-linked actual.",
    });
  }
  if (input.canJobs && pickups.some((row) => row.pickupDurationMinutes != null)) {
    signals.push({
      domain: "WORKFORCE",
      kind: "pickup-readiness",
      summary:
        "Recorded pickup duration and readiness are available. Workforce owns staffing; Materials does not assign crew.",
    });
  }
  if (needed > 0 && jobRows.length > 0) {
    signals.push({
      domain: "GROWTH",
      kind: "fulfillment-constraint",
      summary:
        "Upcoming jobs have recorded materials still needed. Growth owns demand; Materials only reports fulfillment constraints.",
    });
  }
  if (needed > 0 || pickupNotReady > 0) {
    signals.push({
      domain: "COMMUNICATIONS",
      kind: "customer-update-may-be-needed",
      summary:
        "A customer update may be needed for jobs waiting on materials or pickup. Communications was not contacted and no message was sent.",
    });
  }

  const projection: MaterialsProjection = {
    totals: {
      jobs: jobRows.length,
      requirements: requirements.length,
      needed,
      unmapped,
      stalePrices,
      missingPrices,
      openPurchaseOrders: purchaseOrders.length,
      draftPurchaseOrders: purchaseOrders.filter((row) => row.status === "DRAFT").length,
      incompletePrep,
      pickupNotReady,
      unfavorableVariance,
      priceChanged,
      cheaperRecordedSupplier: cheaperRecorded,
    },
    jobs: jobRows.map((job) => ({
      id: job.id,
      status: job.status,
      scheduledAt: job.scheduledAt?.toISOString() ?? null,
      pickupDurationMinutes: job.pickupDurationMinutes,
      targeted: job.id === targetedJobId,
    })),
    requirements,
    catalog: catalogRows.map((row) => ({
      id: row.id,
      name: row.name,
      unit: row.unit,
      takeoffIdentity: row.takeoffIdentity,
      lastKnownCost: money(row.lastKnownCost),
      lastKnownCostAt: row.lastKnownCostAt?.toISOString() ?? null,
      preferredSupplierId: row.preferredSupplierId,
    })),
    mappings,
    prices: priced,
    freshness,
    purchaseLists: purchaseLists
      .filter((row) => input.canJobs || row.jobId == null)
      .map((row) => ({
        id: row.id,
        jobId: input.canJobs ? row.jobId : null,
        estimateId: row.estimateId,
      })),
    purchaseOrders: purchaseOrders
      .filter((row) => input.canJobs || row.jobId == null)
      .map((row) => ({
        id: row.id,
        purchaseListId: row.purchaseListId,
        jobId: input.canJobs ? row.jobId : null,
        supplierId: row.supplierId,
        status: row.status,
        supplierConfirmed: false,
      })),
    variance: capInMemory(variance, MATERIALS_CONTEXT_CAPS.variance),
    pickups: capInMemory(pickups, MATERIALS_CONTEXT_CAPS.pickups),
    preferences: capInMemory(
      preferences.map((row) => ({ providerId: row.providerId, enabled: row.enabled })),
      MATERIALS_CONTEXT_CAPS.preferences,
    ),
    adapterState: "DISCONNECTED",
    adapterLimitation: adapter.limitation || SUPPLIER_COMMERCE_DISCONNECTED_LIMITATION,
    inventoryQuantity: null,
    inventoryState: "unknown",
    canReadJobs: input.canJobs,
    canReadExpenses: input.canExpenses,
    canReadEstimates: input.canEstimates,
    targetedJobUnauthorized,
    signals,
    snapshotReused: false,
  };

  assertSafeProjection(projection);
  return projection;
}

function findingsFromProjection(
  projection: MaterialsProjection,
  question: string,
  catalogKeys: string[],
): Array<{ key: string; title: string; why: string; entityIds?: string[] }> {
  const findings: Array<{ key: string; title: string; why: string; entityIds?: string[] }> = [];
  const t = projection.totals;
  if (inventoryQuestion(question)) {
    findings.push({
      key: "materials-inventory-unknown",
      title: "Inventory quantity is unknown",
      why: "TBBT does not record inventory quantities. Missing stock is unknown, never zero. No quantity was invented.",
    });
  }

  if (t.needed > 0 && (projection.canReadJobs || projection.canReadEstimates)) {
    findings.push({
      key: "materials-needed-for-upcoming-jobs",
      title: "Materials are still needed",
      why: `${t.needed} recorded material requirement${t.needed === 1 ? " is" : "s are"} NEEDED on upcoming or open purchase lists. This is not live stock and not a supplier confirmation.`,
      entityIds: projection.requirements
        .filter((row) => row.status === "NEEDED")
        .map((row) =>
          projection.canReadJobs ? row.jobId ?? row.estimateId ?? row.id : row.estimateId ?? row.id,
        )
        .filter((id): id is string => Boolean(id))
        .slice(0, MATERIALS_CONTEXT_CAPS.entityIds),
    });
  }
  if (t.incompletePrep > 0 && projection.canReadJobs) {
    findings.push({
      key: "materials-incomplete-prep",
      title: "Material pickup prep is incomplete",
      why: `${t.incompletePrep} recorded pickup requirement${t.incompletePrep === 1 ? " is" : "s are"} not ready or missing a recorded pickup duration. Duration is only stated when it was recorded.`,
    });
  }
  if (projection.purchaseLists.length > 0 && t.needed > 0) {
    findings.push({
      key: "materials-open-purchase-list",
      title: "Open purchase lists have items still needed",
      why: `${projection.purchaseLists.length} recorded purchase list${projection.purchaseLists.length === 1 ? "" : "s"} include materials that are not purchased. A purchase list is not a purchase order.`,
    });
  }
  if (t.draftPurchaseOrders > 0) {
    findings.push({
      key: "materials-draft-po",
      title: "Draft purchase orders are on file",
      why: `${t.draftPurchaseOrders} recorded purchase order${t.draftPurchaseOrders === 1 ? " is" : "s are"} still DRAFT. ORDERED_EXTERNALLY is owner tracking only and is not supplier confirmation.`,
    });
  }
  if (t.stalePrices > 0) {
    findings.push({
      key: "materials-stale-price",
      title: "Some recorded supplier prices are stale",
      why: `${t.stalePrices} recorded price${t.stalePrices === 1 ? " is" : "s are"} older than 7 days. Stale is not current and is not a live quote.`,
    });
  }
  if (t.missingPrices > 0) {
    findings.push({
      key: "materials-missing-price",
      title: "Some materials have no recorded price",
      why: `${t.missingPrices} requirement${t.missingPrices === 1 ? " has" : "s have"} no recorded price. Missing price is unknown, not $0.`,
    });
  }
  if (t.unmapped > 0) {
    findings.push({
      key: "materials-unmapped-supplier",
      title: "Some materials have no recorded supplier mapping",
      why: `${t.unmapped} requirement${t.unmapped === 1 ? " has" : "s have"} no recorded supplier or calculator mapping. An unmapped supplier is not an invented vendor.`,
    });
  }
  if (t.priceChanged > 0) {
    findings.push({
      key: "materials-price-changed",
      title: "Recorded material prices changed",
      why: `${t.priceChanged} material${t.priceChanged === 1 ? " has" : "s have"} a later recorded history price that differs from an earlier recorded history price. This is recorded history, not a live market quote.`,
    });
  }
  if (t.cheaperRecordedSupplier > 0) {
    findings.push({
      key: "materials-cheaper-recorded-supplier",
      title: "Another recorded supplier price is lower",
      why: `${t.cheaperRecordedSupplier} material${t.cheaperRecordedSupplier === 1 ? " has" : "s have"} a cheaper recorded current or recently checked price from another mapped supplier. That is recorded evidence only — not available, confirmed, or live inventory.`,
    });
  }
  if (t.unfavorableVariance > 0) {
    findings.push({
      key: "materials-variance-hurting-margin",
      title: "Recorded material cost is over the estimate",
      why: `${t.unfavorableVariance} requirement${t.unfavorableVariance === 1 ? " has" : "s have"} expense-linked actual cost above recorded estimate. Materials reports the recorded cost inputs; Financial owns margin math.`,
    });
  }
  findings.push({
    key: "materials-adapter-disconnected",
    title: "Supplier commerce is disconnected",
    why: `${projection.adapterLimitation} A null quote or availability response is not a live stock result and not a rejection.`,
  });
  for (const key of catalogKeys) {
    if (findings.some((row) => row.key === key)) continue;
    if (isMaterialsOwnedRecommendationKey(key)) {
      findings.push({
        key,
        title: "Review recorded materials attention",
        why: "An active Materials recommendation is already on the Business Health list. Open the existing materials workspace to review it.",
      });
    }
  }
  return findings.slice(0, MATERIALS_CONTEXT_CAPS.findings);
}

export function projectMaterialsFacts(projection: MaterialsProjection) {
  const facts: Record<string, string> = {};
  const factKeys: string[] = [];
  const t = projection.totals;
  if (projection.canReadEstimates || projection.canReadJobs) {
    addFact(facts, factKeys, "materials-needed-count", String(t.needed));
    addFact(facts, factKeys, "materials-unmapped-count", String(t.unmapped));
    addFact(facts, factKeys, "materials-stale-price-count", String(t.stalePrices));
    addFact(facts, factKeys, "materials-missing-price-count", String(t.missingPrices));
    addFact(facts, factKeys, "materials-open-po-count", String(t.openPurchaseOrders));
    addFact(facts, factKeys, "materials-price-changed-count", String(t.priceChanged));
  }
  if (projection.canReadJobs) {
    addFact(facts, factKeys, "materials-incomplete-prep-count", String(t.incompletePrep));
    addFact(facts, factKeys, "materials-pickup-not-ready-count", String(t.pickupNotReady));
  }
  if (projection.canReadExpenses) {
    addFact(facts, factKeys, "materials-variance-unfavorable-count", String(t.unfavorableVariance));
  }
  addFact(facts, factKeys, "materials-adapter-state", projection.adapterState);
  return { facts, factKeys };
}

export async function runMaterialsSpecialist(input: MaterialsSpecialistInput): Promise<SpecialistResult> {
  recordMaterialsSpecialistInterpretation();
  const catalogKeys = input.catalog.activeRecommendations
    .map((item) => item.key)
    .filter((key) => isMaterialsOwnedRecommendationKey(key));

  const gates = await resolveMaterialsGates(
    input.db,
    input.access,
    input.denyProductCapabilities,
    input.denyRoleCapabilities,
  );
  if (gates.status === "skip") {
    lastMaterialsProjection = null;
    return {
      specialistId: "MATERIALS",
      status: "SKIPPED",
      findings: [],
      factKeys: [],
      recommendationKeys: [],
      limitation: gates.limitation,
      skipReason: gates.skipReason,
    };
  }

  try {
    const projection = await loadMaterialsProjection({
      db: input.db,
      access: input.access,
      entityHints: input.entityHints,
      canJobs: gates.canJobs,
      canExpenses: gates.canExpenses,
      canEstimates: gates.canEstimates,
    });
    lastMaterialsProjection = projection;

    const { factKeys } = projectMaterialsFacts(projection);
    const rawFindings = findingsFromProjection(projection, input.question, catalogKeys);
    const findings: SpecialistFinding[] = rawFindings.map((item) => ({
      key: item.key,
      title: item.title,
      summary: item.why,
      recommendationKeys: isMaterialsOwnedRecommendationKey(item.key) ? [item.key] : [],
      factKeys,
      entityIds: item.entityIds,
    }));

    const limitations: string[] = [];
    if (!gates.canJobs) {
      limitations.push(
        "Job and pickup slices were omitted because Jobs access is missing. That is not the same as zero upcoming material work.",
      );
    }
    if (!gates.canExpenses) {
      limitations.push(
        "Counted financial material actuals were omitted because Expenses access is missing. Operational purchase cost is not treated as a financial expense.",
      );
    }
    if (projection.targetedJobUnauthorized) {
      limitations.push("That job is not in this business workspace, so it was not targeted.");
    }

    return {
      specialistId: "MATERIALS",
      status: "OK",
      findings,
      factKeys,
      recommendationKeys: catalogKeys,
      limitation: limitations.join(" ") || undefined,
    };
  } catch (error) {
    lastMaterialsProjection = null;
    return {
      specialistId: "MATERIALS",
      status: "FAILED",
      findings: [],
      factKeys: [],
      recommendationKeys: [],
      limitation: MATERIALS_FAILURE_LIMITATION,
      failure: {
        specialistId: "MATERIALS",
        message: error instanceof Error ? error.message : "Materials projection could not be loaded.",
      },
    };
  }
}

export function emptyMaterialsProjectionForTests(): MaterialsProjection {
  return {
    totals: emptyTotals(),
    jobs: [],
    requirements: [],
    catalog: [],
    mappings: [],
    prices: [],
    freshness: [],
    purchaseLists: [],
    purchaseOrders: [],
    variance: [],
    pickups: [],
    preferences: [],
    adapterState: "DISCONNECTED",
    adapterLimitation: SUPPLIER_COMMERCE_DISCONNECTED_LIMITATION,
    inventoryQuantity: null,
    inventoryState: "unknown",
    canReadJobs: false,
    canReadExpenses: false,
    canReadEstimates: false,
    targetedJobUnauthorized: false,
    signals: [],
    snapshotReused: false,
  };
}

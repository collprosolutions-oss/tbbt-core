/**
 * Durable, business-scoped persistence for supplier preferences,
 * material mappings, and current supplier prices.
 *
 * Preview shares Production and skips migrate, so reads/writes first
 * ensure tables exist with CREATE TABLE IF NOT EXISTS.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { roundMoney } from "@/lib/estimate-calculators/types";
import { applyCurrentSupplierPriceToDraftItem } from "@/lib/material-pricing/apply";
import { buildOwnerSupplierPricingBoard } from "@/lib/material-pricing/engine";
import { classifySupplierPriceFreshness } from "@/lib/material-pricing/freshness";
import { calculatorMaterialIdentity } from "@/lib/material-pricing/identities";
import { defaultSupplierLocationForBusiness, supplierLocationKey } from "@/lib/material-pricing/location";
import { getSupplierProvider } from "@/lib/material-pricing/registry";
import {
  DEFAULT_SUPPLIER_PROVIDER_ID,
  isSupplierProviderId,
  type OwnerSupplierPricingBoard,
  type SupplierPriceQuote,
  type SupplierProviderId,
} from "@/lib/material-pricing/types";
import { saveDraftMaterialTakeoff } from "@/lib/material-takeoff/ops";
import { lineMaterialTakeoff } from "@/lib/estimate-line-scope";
import { normalizeTakeoffSnapshot } from "@/lib/material-takeoff/engine";
import type { TakeoffSnapshot } from "@/lib/material-takeoff/types";

const CREATE_PREFERENCE_SQL = `
CREATE TABLE IF NOT EXISTS "BusinessSupplierPreference" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "locationZip" TEXT,
    "locationStoreId" TEXT,
    "locationLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BusinessSupplierPreference_pkey" PRIMARY KEY ("id")
);
`;

const CREATE_MAPPING_SQL = `
CREATE TABLE IF NOT EXISTS "BusinessMaterialSupplierMapping" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "materialIdentity" TEXT NOT NULL,
    "takeoffType" TEXT,
    "providerProductId" TEXT NOT NULL,
    "providerSku" TEXT,
    "providerUrl" TEXT,
    "productName" TEXT NOT NULL,
    "unitLabel" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BusinessMaterialSupplierMapping_pkey" PRIMARY KEY ("id")
);
`;

const CREATE_PRICE_SQL = `
CREATE TABLE IF NOT EXISTS "SupplierPriceRecord" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "providerProductId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "sku" TEXT,
    "productUrl" TEXT,
    "unitLabel" TEXT NOT NULL,
    "currentPrice" DECIMAL(65,30) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "locationKey" TEXT NOT NULL DEFAULT '_',
    "locationZip" TEXT,
    "locationStoreId" TEXT,
    "locationLabel" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "sourceStatus" TEXT NOT NULL,
    "sourceMode" TEXT NOT NULL,
    "rawMetadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SupplierPriceRecord_pkey" PRIMARY KEY ("id")
);
`;

let ensureTablesPromise: Promise<void> | null = null;

export async function ensureMaterialPriceEngineTables(
  db: PrismaClient | Prisma.TransactionClient,
) {
  if (!ensureTablesPromise) {
    ensureTablesPromise = (async () => {
      await db.$executeRawUnsafe(CREATE_PREFERENCE_SQL);
      await db.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS "BusinessSupplierPreference_businessId_providerId_key" ON "BusinessSupplierPreference"("businessId", "providerId")`,
      );
      await db.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "BusinessSupplierPreference_businessId_idx" ON "BusinessSupplierPreference"("businessId")`,
      );
      await db.$executeRawUnsafe(CREATE_MAPPING_SQL);
      await db.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS "BusinessMaterialSupplierMapping_businessId_providerId_materialIdentity_key" ON "BusinessMaterialSupplierMapping"("businessId", "providerId", "materialIdentity")`,
      );
      await db.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "BusinessMaterialSupplierMapping_businessId_idx" ON "BusinessMaterialSupplierMapping"("businessId")`,
      );
      await db.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "BusinessMaterialSupplierMapping_businessId_providerId_idx" ON "BusinessMaterialSupplierMapping"("businessId", "providerId")`,
      );
      await db.$executeRawUnsafe(CREATE_PRICE_SQL);
      await db.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS "SupplierPriceRecord_businessId_providerId_providerProductId_locationKey_key" ON "SupplierPriceRecord"("businessId", "providerId", "providerProductId", "locationKey")`,
      );
      await db.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "SupplierPriceRecord_businessId_idx" ON "SupplierPriceRecord"("businessId")`,
      );
      await db.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "SupplierPriceRecord_businessId_providerId_idx" ON "SupplierPriceRecord"("businessId", "providerId")`,
      );
    })().catch((error) => {
      ensureTablesPromise = null;
      throw error;
    });
  }
  await ensureTablesPromise;
}

export async function loadSupplierPreference(
  db: PrismaClient | Prisma.TransactionClient,
  businessId: string,
  providerId: SupplierProviderId = DEFAULT_SUPPLIER_PROVIDER_ID,
) {
  if (!businessId) return null;
  await ensureMaterialPriceEngineTables(db);
  const row = await db.businessSupplierPreference.findUnique({
    where: { businessId_providerId: { businessId, providerId } },
  });
  if (!row || row.businessId !== businessId) return null;
  return row;
}

export async function saveSupplierPreference(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    providerId?: string | null;
    enabled?: boolean;
    locationZip?: string | null;
    locationStoreId?: string | null;
    locationLabel?: string | null;
    seedSuggestedMappings?: boolean;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  const providerId = isSupplierProviderId(input.providerId)
    ? input.providerId
    : DEFAULT_SUPPLIER_PROVIDER_ID;
  const provider = getSupplierProvider(providerId);
  if (!provider.implemented) {
    throw materialPricingError(`${provider.displayName} is not connected yet.`);
  }
  await ensureMaterialPriceEngineTables(db);
  const locationZip = normalizeZip(input.locationZip);
  const locationLabel = input.locationLabel?.trim() || null;
  const enabled = input.enabled !== false;
  const row = await db.businessSupplierPreference.upsert({
    where: {
      businessId_providerId: { businessId: access.businessId, providerId },
    },
    create: {
      businessId: access.businessId,
      providerId,
      enabled,
      locationZip,
      locationStoreId: input.locationStoreId?.trim() || null,
      locationLabel,
    },
    update: {
      enabled,
      locationZip,
      locationStoreId: input.locationStoreId?.trim() || null,
      locationLabel,
    },
  });
  if (input.seedSuggestedMappings !== false) {
    await seedSuggestedMappings(db, access.businessId, providerId);
  }
  return row;
}

export async function seedSuggestedMappings(
  db: PrismaClient | Prisma.TransactionClient,
  businessId: string,
  providerId: SupplierProviderId = DEFAULT_SUPPLIER_PROVIDER_ID,
) {
  await ensureMaterialPriceEngineTables(db);
  const provider = getSupplierProvider(providerId);
  const suggestions = provider.suggestedMappings("concrete-slab");
  for (const suggestion of suggestions) {
    await db.businessMaterialSupplierMapping.upsert({
      where: {
        businessId_providerId_materialIdentity: {
          businessId,
          providerId,
          materialIdentity: suggestion.materialIdentity,
        },
      },
      create: {
        businessId,
        providerId,
        materialIdentity: suggestion.materialIdentity,
        takeoffType: suggestion.takeoffType,
        providerProductId: suggestion.product.productId,
        providerSku: suggestion.product.sku,
        providerUrl: suggestion.product.url,
        productName: suggestion.product.name,
        unitLabel: suggestion.product.unitLabel,
      },
      update: {},
    });
  }
}

export async function refreshSupplierPrices(
  db: PrismaClient,
  access: BusinessAccess,
  input?: {
    providerId?: string | null;
    takeoffType?: string | null;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  const providerId = isSupplierProviderId(input?.providerId)
    ? input.providerId
    : DEFAULT_SUPPLIER_PROVIDER_ID;
  const provider = getSupplierProvider(providerId);
  if (!provider.implemented) {
    throw materialPricingError(`${provider.displayName} is not connected yet.`);
  }
  await ensureMaterialPriceEngineTables(db);
  const business = await db.business.findFirst({
    where: { id: access.businessId },
    select: { id: true, slug: true },
  });
  if (!business || business.id !== access.businessId) {
    throw materialPricingError("That business could not be found.");
  }
  const starting = defaultSupplierLocationForBusiness(business);
  const preference =
    (await loadSupplierPreference(db, access.businessId, providerId)) ??
    (await saveSupplierPreference(db, access, {
      providerId,
      locationZip: starting.zip,
      locationLabel: starting.label,
      seedSuggestedMappings: true,
    }));
  await seedSuggestedMappings(db, access.businessId, providerId);
  const mappings = await db.businessMaterialSupplierMapping.findMany({
    where: { businessId: access.businessId, providerId },
  });
  const now = new Date();
  const quotes: SupplierPriceQuote[] = [];
  for (const mapping of mappings) {
    const quote = await provider.fetchPrice({
      productId: mapping.providerProductId,
      locationZip: preference.locationZip,
      storeId: preference.locationStoreId,
      locationLabel: preference.locationLabel,
      now,
    });
    if (!(quote.currentPrice > 0) || !quote.fetchedAt) {
      continue;
    }
    const locationKey = supplierLocationKey(preference.locationZip);
    const sourceStatus = classifySupplierPriceFreshness(quote.fetchedAt, now);
    await db.supplierPriceRecord.upsert({
      where: {
        businessId_providerId_providerProductId_locationKey: {
          businessId: access.businessId,
          providerId,
          providerProductId: quote.productId,
          locationKey,
        },
      },
      create: {
        businessId: access.businessId,
        providerId,
        providerProductId: quote.productId,
        productName: quote.productName,
        sku: quote.sku,
        productUrl: quote.url,
        unitLabel: quote.unitLabel,
        currentPrice: new Prisma.Decimal(quote.currentPrice.toFixed(2)),
        currency: quote.currency,
        locationKey,
        locationZip: preference.locationZip,
        locationStoreId: preference.locationStoreId,
        locationLabel: preference.locationLabel,
        fetchedAt: quote.fetchedAt,
        sourceStatus,
        sourceMode: quote.sourceMode,
        rawMetadata: quote.rawMetadata ? JSON.stringify(quote.rawMetadata) : null,
      },
      update: {
        productName: quote.productName,
        sku: quote.sku,
        productUrl: quote.url,
        unitLabel: quote.unitLabel,
        currentPrice: new Prisma.Decimal(quote.currentPrice.toFixed(2)),
        locationZip: preference.locationZip,
        locationStoreId: preference.locationStoreId,
        locationLabel: preference.locationLabel,
        fetchedAt: quote.fetchedAt,
        sourceStatus,
        sourceMode: quote.sourceMode,
        rawMetadata: quote.rawMetadata ? JSON.stringify(quote.rawMetadata) : null,
      },
    });
    quotes.push(quote);
  }
  return { preference, quotes };
}

export async function confirmSupplierStorePrice(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    providerId?: string | null;
    productId: string;
    currentPrice: number;
    productName?: string | null;
    sku?: string | null;
    unitLabel?: string | null;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  const cost = roundMoney(input.currentPrice);
  if (!(cost > 0)) {
    throw materialPricingError("Enter a store price greater than 0.");
  }
  const providerId = isSupplierProviderId(input.providerId)
    ? input.providerId
    : DEFAULT_SUPPLIER_PROVIDER_ID;
  const provider = getSupplierProvider(providerId);
  const catalog = provider.lookupProduct(input.productId);
  await ensureMaterialPriceEngineTables(db);
  const preference = await loadSupplierPreference(db, access.businessId, providerId);
  const locationKey = supplierLocationKey(preference?.locationZip);
  const now = new Date();
  const productName = input.productName?.trim() || catalog?.name || "Supplier product";
  await db.supplierPriceRecord.upsert({
    where: {
      businessId_providerId_providerProductId_locationKey: {
        businessId: access.businessId,
        providerId,
        providerProductId: input.productId,
        locationKey,
      },
    },
    create: {
      businessId: access.businessId,
      providerId,
      providerProductId: input.productId,
      productName,
      sku: input.sku ?? catalog?.sku ?? null,
      productUrl: catalog?.url ?? null,
      unitLabel: input.unitLabel?.trim() || catalog?.unitLabel || "ea",
      currentPrice: new Prisma.Decimal(cost.toFixed(2)),
      currency: "USD",
      locationKey,
      locationZip: preference?.locationZip ?? null,
      locationStoreId: preference?.locationStoreId ?? null,
      locationLabel: preference?.locationLabel ?? null,
      fetchedAt: now,
      sourceStatus: "current",
      sourceMode: "owner-confirmed",
      rawMetadata: JSON.stringify({ adapter: provider.id, mode: "owner-confirmed" }),
    },
    update: {
      productName,
      currentPrice: new Prisma.Decimal(cost.toFixed(2)),
      fetchedAt: now,
      sourceStatus: "current",
      sourceMode: "owner-confirmed",
    },
  });
}

export async function loadOwnerSupplierPricingBoard(
  db: PrismaClient | Prisma.TransactionClient,
  input: {
    businessId: string;
    businessSlug: string;
    snapshot?: TakeoffSnapshot | null;
    providerId?: string | null;
  },
): Promise<OwnerSupplierPricingBoard> {
  const providerId = isSupplierProviderId(input.providerId)
    ? input.providerId
    : DEFAULT_SUPPLIER_PROVIDER_ID;
  const provider = getSupplierProvider(providerId);
  const starting = defaultSupplierLocationForBusiness({ slug: input.businessSlug });
  if (!input.businessId) {
    return buildOwnerSupplierPricingBoard({
      snapshot: input.snapshot ?? null,
      providerId,
      locationZip: starting.zip,
      locationLabel: starting.label,
      mappings: [],
      prices: [],
    });
  }
  await ensureMaterialPriceEngineTables(db);
  const [preference, mappings, prices] = await Promise.all([
    db.businessSupplierPreference.findFirst({
      where: { businessId: input.businessId, providerId },
    }),
    db.businessMaterialSupplierMapping.findMany({
      where: { businessId: input.businessId, providerId },
    }),
    db.supplierPriceRecord.findMany({
      where: { businessId: input.businessId, providerId },
    }),
  ]);
  return buildOwnerSupplierPricingBoard({
    snapshot: input.snapshot ?? null,
    providerId,
    locationZip: preference?.locationZip ?? starting.zip,
    locationLabel: preference?.locationLabel ?? starting.label,
    preferredEnabled: preference?.enabled ?? true,
    liveApiAvailable: provider.liveApiAvailable,
    limitation: provider.limitation,
    mappings: mappings
      .filter((row) => row.businessId === input.businessId)
      .map((row) => ({
        materialIdentity: row.materialIdentity,
        providerId: row.providerId,
        providerProductId: row.providerProductId,
        providerSku: row.providerSku,
        providerUrl: row.providerUrl,
        productName: row.productName,
        unitLabel: row.unitLabel,
      })),
    prices: prices
      .filter((row) => row.businessId === input.businessId)
      .map((row) => ({
        providerId: row.providerId,
        providerProductId: row.providerProductId,
        productName: row.productName,
        sku: row.sku,
        currentPrice: Number(row.currentPrice),
        fetchedAt: row.fetchedAt,
        sourceMode: row.sourceMode,
        sourceStatus: row.sourceStatus,
        limitation: provider.limitation,
      })),
  });
}

export async function loadSupplierPricingContextPayload(
  db: PrismaClient | Prisma.TransactionClient,
  input: {
    businessId: string;
    businessSlug: string;
    snapshot?: TakeoffSnapshot | null;
    providerId?: string | null;
  },
): Promise<import("@/lib/material-pricing/types").SupplierPricingContextPayload> {
  const board = await loadOwnerSupplierPricingBoard(db, input);
  await ensureMaterialPriceEngineTables(db);
  const providerId = board.providerId;
  const [mappings, prices] = input.businessId
    ? await Promise.all([
        db.businessMaterialSupplierMapping.findMany({
          where: { businessId: input.businessId, providerId },
        }),
        db.supplierPriceRecord.findMany({
          where: { businessId: input.businessId, providerId },
        }),
      ])
    : [[], []];
  const { rows: _rows, ...meta } = board;
  return {
    ...meta,
    mappings: mappings
      .filter((row) => row.businessId === input.businessId)
      .map((row) => ({
        materialIdentity: row.materialIdentity,
        providerId: row.providerId,
        providerProductId: row.providerProductId,
        providerSku: row.providerSku,
        providerUrl: row.providerUrl,
        productName: row.productName,
        unitLabel: row.unitLabel,
      })),
    prices: prices
      .filter((row) => row.businessId === input.businessId)
      .map((row) => ({
        providerId: row.providerId,
        providerProductId: row.providerProductId,
        productName: row.productName,
        sku: row.sku,
        currentPrice: Number(row.currentPrice),
        fetchedAt: row.fetchedAt ? row.fetchedAt.toISOString() : null,
        sourceMode: row.sourceMode,
        sourceStatus: row.sourceStatus,
        limitation: board.limitation,
      })),
  };
}

export async function applyCurrentSupplierPriceToDraft(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    estimateId: string;
    lineItemId?: string | null;
    itemId: string;
    snapshot: TakeoffSnapshot;
    supplierUnitCost?: number | null;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  const snapshot = normalizeTakeoffSnapshot(input.snapshot);
  if (!snapshot) {
    throw materialPricingError("Calculate or enter a material takeoff first.");
  }
  const item = snapshot.items.find((row) => row.id === input.itemId);
  if (!item) {
    throw materialPricingError("That takeoff item was not found.");
  }
  const identity = calculatorMaterialIdentity(item);
  const board = await loadOwnerSupplierPricingBoard(db, {
    businessId: access.businessId,
    businessSlug: "",
    snapshot,
  });
  const row = board.rows.find((candidate) => candidate.itemId === input.itemId);
  const cost =
    input.supplierUnitCost != null && input.supplierUnitCost > 0
      ? roundMoney(input.supplierUnitCost)
      : row?.supplierUnitCost ?? null;
  if (cost == null || !(cost > 0)) {
    throw materialPricingError(`No current supplier price is available for ${item.label}.`);
  }
  if (row?.mappingStatus === "not-a-product") {
    throw materialPricingError("Material pickup / procurement is not a supplier product.");
  }
  const next = applyCurrentSupplierPriceToDraftItem(snapshot, input.itemId, cost);
  await saveDraftMaterialTakeoff(db, access, {
    estimateId: input.estimateId,
    lineItemId: input.lineItemId,
    snapshot: next,
  });
  return { snapshot: next, identity, appliedCost: cost };
}

export async function loadDraftTakeoffForEstimate(
  db: PrismaClient,
  access: BusinessAccess,
  estimateId: string,
  lineItemId?: string | null,
) {
  const estimate = access.assertOwned(
    await db.estimate.findFirst({
      where: { id: estimateId, ...access.scope },
      select: { id: true, businessId: true, status: true },
    }),
  );
  if (estimate.status !== "DRAFT") {
    throw materialPricingError("Only a draft estimate can use a current supplier price.");
  }
  if (lineItemId) {
    const line = access.assertOwned(
      await db.lineItem.findFirst({
        where: { id: lineItemId, estimateId: estimate.id, ...access.scope },
      }),
    );
    return lineMaterialTakeoff(line.description);
  }
  return null;
}

function normalizeZip(value?: string | null) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  if (!/^\d{5}(?:-\d{4})?$/.test(trimmed)) {
    throw materialPricingError("Enter a 5-digit ZIP for supplier pricing location.");
  }
  return trimmed.slice(0, 5);
}

export function materialPricingError(message: string) {
  const error = new Error(message);
  error.name = "EstimateLineError";
  return error;
}

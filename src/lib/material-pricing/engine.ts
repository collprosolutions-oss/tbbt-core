/**
 * Resolve calculator material identity → mapping → current supplier price.
 * Does not mutate takeoff snapshots or business defaults.
 */
import { HOME_DEPOT_CATALOG } from "@/lib/material-pricing/home-depot";
import {
  classifySupplierPriceFreshness,
  describeSupplierPriceCheck,
  supplierPriceFreshnessLabel,
} from "@/lib/material-pricing/freshness";
import { calculatorMaterialIdentity, materialSupportsSupplierProduct } from "@/lib/material-pricing/identities";
import { getSupplierProvider } from "@/lib/material-pricing/registry";
import {
  DEFAULT_SUPPLIER_PROVIDER_ID,
  type OwnerMaterialPriceRow,
  type OwnerSupplierPricingBoard,
  type SupplierPriceQuote,
  type SupplierProviderId,
} from "@/lib/material-pricing/types";
import type { TakeoffItem, TakeoffSnapshot } from "@/lib/material-takeoff/types";

export type StoredMaterialMapping = {
  materialIdentity: string;
  providerId: string;
  providerProductId: string;
  providerSku: string | null;
  providerUrl: string | null;
  productName: string;
  unitLabel: string;
};

export type StoredSupplierPrice = {
  providerId: string;
  providerProductId: string;
  productName: string;
  sku: string | null;
  currentPrice: number;
  fetchedAt: Date | string | null;
  sourceMode: string;
  sourceStatus: string;
  limitation?: string | null;
};

export function resolveSupplierQuoteForIdentity(input: {
  materialIdentity: string;
  providerId?: SupplierProviderId | string | null;
  mappings: StoredMaterialMapping[];
  prices: StoredSupplierPrice[];
  catalogFallback?: boolean;
  now?: Date;
}): {
  mapping: StoredMaterialMapping | null;
  quote: SupplierPriceQuote | null;
  suggested: boolean;
} {
  const provider = getSupplierProvider(input.providerId);
  const mapping =
    input.mappings.find(
      (row) =>
        row.materialIdentity === input.materialIdentity &&
        row.providerId === provider.id,
    ) ?? null;

  let productId = mapping?.providerProductId ?? null;
  let suggested = false;
  if (!productId && input.catalogFallback !== false) {
    const suggestion = provider
      .suggestedMappings()
      .find((row) => row.materialIdentity === input.materialIdentity);
    if (suggestion) {
      productId = suggestion.product.productId;
      suggested = !mapping;
    }
  }
  if (!productId) {
    return { mapping, quote: null, suggested: false };
  }

  const stored = input.prices.find(
    (row) =>
      row.providerId === provider.id && row.providerProductId === productId,
  );
  const catalog = provider.lookupProduct(productId);
  const now = input.now ?? new Date();

  if (stored && stored.currentPrice > 0) {
    const fetchedAt =
      stored.fetchedAt instanceof Date
        ? stored.fetchedAt
        : stored.fetchedAt
          ? new Date(stored.fetchedAt)
          : null;
    return {
      mapping:
        mapping ??
        (catalog
          ? {
              materialIdentity: input.materialIdentity,
              providerId: provider.id,
              providerProductId: catalog.productId,
              providerSku: catalog.sku,
              providerUrl: catalog.url,
              productName: catalog.name,
              unitLabel: catalog.unitLabel,
            }
          : null),
      suggested,
      quote: {
        providerId: provider.id,
        productId,
        sku: stored.sku ?? catalog?.sku ?? null,
        url: catalog?.url ?? null,
        productName: stored.productName || catalog?.name || "",
        unitLabel: catalog?.unitLabel || mapping?.unitLabel || "",
        currentPrice: stored.currentPrice,
        currency: "USD",
        locationZip: null,
        locationStoreId: null,
        locationLabel: null,
        fetchedAt,
        sourceStatus: classifySupplierPriceFreshness(fetchedAt, now),
        sourceMode:
          stored.sourceMode === "owner-confirmed" || stored.sourceMode === "live-api"
            ? stored.sourceMode
            : "catalog-reference",
        limitation: stored.limitation ?? provider.limitation,
        rawMetadata: null,
      },
    };
  }

  if (catalog && "catalogUnitPrice" in (catalog as object)) {
    return {
      mapping:
        mapping ?? {
          materialIdentity: input.materialIdentity,
          providerId: provider.id,
          providerProductId: catalog.productId,
          providerSku: catalog.sku,
          providerUrl: catalog.url,
          productName: catalog.name,
          unitLabel: catalog.unitLabel,
        },
      suggested,
      quote: null,
    };
  }

  if (catalog) {
    return {
      mapping:
        mapping ?? {
          materialIdentity: input.materialIdentity,
          providerId: provider.id,
          providerProductId: catalog.productId,
          providerSku: catalog.sku,
          providerUrl: catalog.url,
          productName: catalog.name,
          unitLabel: catalog.unitLabel,
        },
      suggested,
      quote: {
        providerId: provider.id,
        productId: catalog.productId,
        sku: catalog.sku,
        url: catalog.url,
        productName: catalog.name,
        unitLabel: catalog.unitLabel,
        currentPrice: 0,
        currency: "USD",
        locationZip: null,
        locationStoreId: null,
        locationLabel: null,
        fetchedAt: null,
        sourceStatus: "unavailable",
        sourceMode: "catalog-reference",
        limitation: provider.limitation,
        rawMetadata: null,
      },
    };
  }

  return { mapping, quote: null, suggested };
}

export function catalogReferencePrice(productId: string, providerId?: string | null) {
  const provider = getSupplierProvider(providerId);
  const suggestion = provider
    .suggestedMappings()
    .find((row) => row.product.productId === productId);
  return suggestion ? suggestion.product : provider.lookupProduct(productId);
}

export function buildOwnerMaterialPriceRow(input: {
  item: TakeoffItem;
  mappings: StoredMaterialMapping[];
  prices: StoredSupplierPrice[];
  providerId?: SupplierProviderId | string | null;
  catalogPrices?: Record<string, number>;
  now?: Date;
}): OwnerMaterialPriceRow {
  const identity = calculatorMaterialIdentity(input.item);
  const now = input.now ?? new Date();
  if (!materialSupportsSupplierProduct(input.item)) {
    return {
      itemId: input.item.id,
      label: input.item.label,
      materialIdentity: identity,
      mappingStatus: "not-a-product",
      freshness: "unavailable",
      freshnessLabel: "Unavailable",
      savedUnitCost: input.item.unitCost,
      supplierUnitCost: null,
      supplierProductName: null,
      supplierSku: null,
      checkedAt: null,
      checkedLabel: "Not a supplier product",
      sourceMode: null,
      limitation: null,
      canUseCurrentPrice: false,
    };
  }

  const resolved = resolveSupplierQuoteForIdentity({
    materialIdentity: identity,
    providerId: input.providerId,
    mappings: input.mappings,
    prices: input.prices,
    now,
  });

  const provider = getSupplierProvider(input.providerId);
  const suggestion = provider
    .suggestedMappings()
    .find((row) => row.materialIdentity === identity);
  const catalogPrice =
    suggestion && input.catalogPrices
      ? input.catalogPrices[suggestion.product.productId]
      : suggestion
        ? catalogUnitPrice(suggestion.product.productId)
        : null;

  const mapped = Boolean(resolved.mapping || suggestion);
  const supplierCost =
    resolved.quote && resolved.quote.currentPrice > 0
      ? resolved.quote.currentPrice
      : catalogPrice;
  const freshness =
    resolved.quote && resolved.quote.currentPrice > 0
      ? resolved.quote.sourceStatus
      : supplierCost != null
        ? "stale"
        : "unavailable";
  const checkedAt = resolved.quote?.fetchedAt
    ? resolved.quote.fetchedAt.toISOString()
    : null;

  return {
    itemId: input.item.id,
    label: input.item.label,
    materialIdentity: identity,
    mappingStatus: mapped ? "mapped" : "unmapped",
    freshness,
    freshnessLabel: supplierPriceFreshnessLabel(freshness),
    savedUnitCost: input.item.unitCost,
    supplierUnitCost: supplierCost,
    supplierProductName:
      resolved.quote?.productName ??
      resolved.mapping?.productName ??
      suggestion?.product.name ??
      null,
    supplierSku: resolved.quote?.sku ?? resolved.mapping?.providerSku ?? null,
    checkedAt,
    checkedLabel: resolved.quote?.fetchedAt
      ? describeSupplierPriceCheck(resolved.quote.fetchedAt, now)
      : supplierCost != null
        ? "Not refreshed — catalog reference only"
        : "No supplier price",
    sourceMode: resolved.quote?.sourceMode ?? (supplierCost != null ? "catalog-reference" : null),
    limitation: resolved.quote?.limitation ?? (mapped ? provider.limitation : null),
    canUseCurrentPrice: supplierCost != null && supplierCost > 0,
  };
}

export function buildOwnerSupplierPricingBoard(input: {
  snapshot: TakeoffSnapshot | null;
  providerId?: SupplierProviderId | string | null;
  providerName?: string;
  implemented?: boolean;
  liveApiAvailable?: boolean;
  limitation?: string;
  locationZip?: string | null;
  locationLabel?: string | null;
  preferredEnabled?: boolean;
  mappings: StoredMaterialMapping[];
  prices: StoredSupplierPrice[];
  now?: Date;
}): OwnerSupplierPricingBoard {
  const provider = getSupplierProvider(input.providerId);
  const items = input.snapshot?.items ?? [];
  return {
    providerId: provider.id,
    providerName: input.providerName ?? provider.displayName,
    implemented: input.implemented ?? provider.implemented,
    liveApiAvailable: input.liveApiAvailable ?? provider.liveApiAvailable,
    limitation: input.limitation ?? provider.limitation,
    locationZip: input.locationZip ?? null,
    locationLabel: input.locationLabel ?? null,
    preferredEnabled: input.preferredEnabled ?? true,
    rows: items.map((item) =>
      buildOwnerMaterialPriceRow({
        item,
        mappings: input.mappings,
        prices: input.prices,
        providerId: provider.id,
        now: input.now,
      }),
    ),
  };
}

function catalogUnitPrice(productId: string): number | null {
  const product = HOME_DEPOT_CATALOG[productId];
  return product?.catalogUnitPrice ?? null;
}

export { DEFAULT_SUPPLIER_PROVIDER_ID };

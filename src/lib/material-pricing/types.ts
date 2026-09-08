/**
 * Provider-neutral material price engine types.
 *
 * Calculator material identities stay stable. Supplier product mappings
 * and current supplier prices are a separate layer from:
 *   - BusinessEstimatingDefault (owner-saved starting cost/price)
 *   - project takeoff snapshots (DRAFT overrides)
 *   - SENT / APPROVED / job / invoice encodings (frozen)
 *
 * This file is client-safe (no Prisma).
 */
import type { TakeoffTypeId } from "@/lib/material-takeoff/types";

export const SUPPLIER_PROVIDER_IDS = ["home-depot", "lowes"] as const;
export type SupplierProviderId = (typeof SUPPLIER_PROVIDER_IDS)[number];

export const DEFAULT_SUPPLIER_PROVIDER_ID: SupplierProviderId = "home-depot";

export const SUPPLIER_PROVIDER_LABELS: Record<SupplierProviderId, string> = {
  "home-depot": "Home Depot",
  lowes: "Lowe’s",
};

export const SUPPLIER_PRICE_SOURCE_MODES = [
  "catalog-reference",
  "owner-confirmed",
  "live-api",
] as const;
export type SupplierPriceSourceMode = (typeof SUPPLIER_PRICE_SOURCE_MODES)[number];

export const SUPPLIER_PRICE_FRESHNESS = [
  "current",
  "recently_checked",
  "stale",
  "unavailable",
] as const;
export type SupplierPriceFreshness = (typeof SUPPLIER_PRICE_FRESHNESS)[number];

export const SUPPLIER_PRICE_FRESHNESS_LABELS: Record<SupplierPriceFreshness, string> = {
  current: "Current",
  recently_checked: "Recently checked",
  stale: "Stale",
  unavailable: "Unavailable",
};

/** 24 hours. */
export const SUPPLIER_PRICE_CURRENT_MS = 24 * 60 * 60 * 1000;
/** 7 days. */
export const SUPPLIER_PRICE_RECENT_MS = 7 * 24 * 60 * 60 * 1000;

export const STANDARD_MATERIAL_IDENTITIES = [
  "concrete-bags",
  "wire-mesh",
  "form-lumber",
  "form-stakes",
  "anchor-hardware",
  "sill-gasket",
] as const;
export type StandardMaterialIdentity = (typeof STANDARD_MATERIAL_IDENTITIES)[number];

/** Procurement/trip allowance — never a supplier product. */
export const NON_SUPPLIER_MATERIAL_IDENTITIES = ["pickup-procurement"] as const;
export type NonSupplierMaterialIdentity =
  (typeof NON_SUPPLIER_MATERIAL_IDENTITIES)[number];

export function isSupplierProviderId(value: unknown): value is SupplierProviderId {
  return (
    typeof value === "string" &&
    (SUPPLIER_PROVIDER_IDS as readonly string[]).includes(value)
  );
}

export function isStandardMaterialIdentity(
  value: unknown,
): value is StandardMaterialIdentity {
  return (
    typeof value === "string" &&
    (STANDARD_MATERIAL_IDENTITIES as readonly string[]).includes(value)
  );
}

export function isNonSupplierMaterialIdentity(
  value: unknown,
): value is NonSupplierMaterialIdentity {
  return (
    typeof value === "string" &&
    (NON_SUPPLIER_MATERIAL_IDENTITIES as readonly string[]).includes(value)
  );
}

export type SupplierProductRef = {
  providerId: SupplierProviderId;
  productId: string;
  sku: string | null;
  url: string | null;
  name: string;
  unitLabel: string;
};

export type SupplierPriceQuote = {
  providerId: SupplierProviderId;
  productId: string;
  sku: string | null;
  url: string | null;
  productName: string;
  unitLabel: string;
  currentPrice: number;
  currency: "USD";
  locationZip: string | null;
  locationStoreId: string | null;
  locationLabel: string | null;
  fetchedAt: Date | null;
  sourceStatus: SupplierPriceFreshness;
  sourceMode: SupplierPriceSourceMode;
  limitation: string | null;
  rawMetadata: Record<string, unknown> | null;
};

export type SuggestedMaterialMapping = {
  materialIdentity: string;
  takeoffType: TakeoffTypeId | null;
  product: SupplierProductRef;
};

export type SupplierPriceProvider = {
  id: SupplierProviderId;
  displayName: string;
  liveApiAvailable: boolean;
  implemented: boolean;
  limitation: string;
  lookupProduct(productId: string): SupplierProductRef | null;
  suggestedMappings(takeoffType?: string | null): SuggestedMaterialMapping[];
  fetchPrice(input: {
    productId: string;
    locationZip?: string | null;
    storeId?: string | null;
    locationLabel?: string | null;
    now?: Date;
  }): Promise<SupplierPriceQuote>;
};

export type MaterialMappingStatus = "mapped" | "unmapped" | "not-a-product";

export type OwnerMaterialPriceRow = {
  itemId: string;
  label: string;
  materialIdentity: string;
  mappingStatus: MaterialMappingStatus;
  freshness: SupplierPriceFreshness;
  freshnessLabel: string;
  savedUnitCost: number | null;
  supplierUnitCost: number | null;
  supplierProductName: string | null;
  supplierSku: string | null;
  checkedAt: string | null;
  checkedLabel: string;
  sourceMode: SupplierPriceSourceMode | null;
  limitation: string | null;
  canUseCurrentPrice: boolean;
};

export type OwnerSupplierPricingBoard = {
  providerId: SupplierProviderId;
  providerName: string;
  implemented: boolean;
  liveApiAvailable: boolean;
  limitation: string;
  locationZip: string | null;
  locationLabel: string | null;
  preferredEnabled: boolean;
  rows: OwnerMaterialPriceRow[];
};

export type SupplierPricingContextPayload = Omit<OwnerSupplierPricingBoard, "rows"> & {
  mappings: Array<{
    materialIdentity: string;
    providerId: string;
    providerProductId: string;
    providerSku: string | null;
    providerUrl: string | null;
    productName: string;
    unitLabel: string;
  }>;
  prices: Array<{
    providerId: string;
    providerProductId: string;
    productName: string;
    sku: string | null;
    currentPrice: number;
    fetchedAt: string | null;
    sourceMode: string;
    sourceStatus: string;
    limitation?: string | null;
  }>;
};

export type PublicCustomerMaterialView = {
  description: string;
  quantityLabel: string;
};

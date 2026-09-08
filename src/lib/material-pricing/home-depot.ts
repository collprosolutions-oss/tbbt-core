/**
 * Home Depot supplier adapter.
 *
 * There is no authorized real-time Home Depot pricing API in this
 * environment. This adapter:
 *   - exposes a controlled product catalog for Concrete Slab items
 *   - returns catalog-reference quotes on refresh
 *   - accepts owner-confirmed store prices through the persistence layer
 *   - never scrapes homedepot.com as a production dependency
 *
 * A later authorized live adapter can replace fetchPrice() without
 * changing calculator identities or the estimating engine.
 */
import { classifySupplierPriceFreshness } from "@/lib/material-pricing/freshness";
import type {
  SupplierPriceProvider,
  SupplierPriceQuote,
  SupplierProductRef,
  SuggestedMaterialMapping,
} from "@/lib/material-pricing/types";
import { roundMoney } from "@/lib/estimate-calculators/types";

export const HOME_DEPOT_PROVIDER_ID = "home-depot" as const;

export type HomeDepotCatalogProduct = SupplierProductRef & {
  catalogUnitPrice: number;
};

/**
 * Controlled catalog for the Concrete Slab first pass. Product ids are
 * stable adapter keys (Home Depot internet numbers where publicly known).
 * Catalog unit prices are reference values for owner review — not live
 * quotes and not customer prices.
 */
export const HOME_DEPOT_CATALOG: Record<string, HomeDepotCatalogProduct> = {
  "202080829": {
    providerId: HOME_DEPOT_PROVIDER_ID,
    productId: "202080829",
    sku: "167900",
    url: "https://www.homedepot.com/p/Quikrete-60-lb-Concrete-Mix-110110/202080829",
    name: "Quikrete 60 lb. Concrete Mix",
    unitLabel: "60-lb bag",
    catalogUnitPrice: 6.47,
  },
  "hd-welded-wire-mesh-sheet": {
    providerId: HOME_DEPOT_PROVIDER_ID,
    productId: "hd-welded-wire-mesh-sheet",
    sku: null,
    url: null,
    name: "Welded wire mesh sheet (~50 sq. ft.)",
    unitLabel: "sheet",
    catalogUnitPrice: 12.98,
  },
  "hd-form-board-2x4x8": {
    providerId: HOME_DEPOT_PROVIDER_ID,
    productId: "hd-form-board-2x4x8",
    sku: "161540",
    url: null,
    name: "2 in. x 4 in. x 8 ft. form board / stud",
    unitLabel: "8-ft board",
    catalogUnitPrice: 3.58,
  },
  "hd-form-stake": {
    providerId: HOME_DEPOT_PROVIDER_ID,
    productId: "hd-form-stake",
    sku: null,
    url: null,
    name: "Wood/steel form stake or pin",
    unitLabel: "ea",
    catalogUnitPrice: 1.28,
  },
  "hd-anchor-jbolt": {
    providerId: HOME_DEPOT_PROVIDER_ID,
    productId: "hd-anchor-jbolt",
    sku: null,
    url: null,
    name: "Anchor bolt / J-bolt hardware",
    unitLabel: "ea",
    catalogUnitPrice: 2.48,
  },
  "hd-sill-gasket-lf": {
    providerId: HOME_DEPOT_PROVIDER_ID,
    productId: "hd-sill-gasket-lf",
    sku: null,
    url: null,
    name: "Foam sill sealer (priced per linear foot)",
    unitLabel: "lf",
    catalogUnitPrice: 0.18,
  },
};

export const HOME_DEPOT_CONCRETE_SLAB_MAPPINGS: SuggestedMaterialMapping[] = [
  {
    materialIdentity: "concrete-bags",
    takeoffType: "concrete-slab",
    product: HOME_DEPOT_CATALOG["202080829"],
  },
  {
    materialIdentity: "wire-mesh",
    takeoffType: "concrete-slab",
    product: HOME_DEPOT_CATALOG["hd-welded-wire-mesh-sheet"],
  },
  {
    materialIdentity: "form-lumber",
    takeoffType: "concrete-slab",
    product: HOME_DEPOT_CATALOG["hd-form-board-2x4x8"],
  },
  {
    materialIdentity: "form-stakes",
    takeoffType: "concrete-slab",
    product: HOME_DEPOT_CATALOG["hd-form-stake"],
  },
  {
    materialIdentity: "anchor-hardware",
    takeoffType: "concrete-slab",
    product: HOME_DEPOT_CATALOG["hd-anchor-jbolt"],
  },
  {
    materialIdentity: "sill-gasket",
    takeoffType: "concrete-slab",
    product: HOME_DEPOT_CATALOG["hd-sill-gasket-lf"],
  },
];

export function homeDepotLiveApiConfigured() {
  return false;
}

export function createHomeDepotProvider(options: {
  limitation: string;
}): SupplierPriceProvider {
  return {
    id: HOME_DEPOT_PROVIDER_ID,
    displayName: "Home Depot",
    liveApiAvailable: homeDepotLiveApiConfigured(),
    implemented: true,
    limitation: options.limitation,
    lookupProduct(productId) {
      const product = HOME_DEPOT_CATALOG[productId];
      if (!product) return null;
      const { catalogUnitPrice: _price, ...ref } = product;
      return ref;
    },
    suggestedMappings(takeoffType) {
      if (takeoffType && takeoffType !== "concrete-slab") return [];
      return HOME_DEPOT_CONCRETE_SLAB_MAPPINGS;
    },
    async fetchPrice(input) {
      return catalogQuote(input.productId, {
        locationZip: input.locationZip ?? null,
        locationStoreId: input.storeId ?? null,
        locationLabel: input.locationLabel ?? null,
        now: input.now ?? new Date(),
        limitation: options.limitation,
        liveApiAvailable: homeDepotLiveApiConfigured(),
      });
    },
  };
}

function catalogQuote(
  productId: string,
  input: {
    locationZip: string | null;
    locationStoreId: string | null;
    locationLabel: string | null;
    now: Date;
    limitation: string;
    liveApiAvailable: boolean;
  },
): SupplierPriceQuote {
  const product = HOME_DEPOT_CATALOG[productId];
  if (!product) {
    return {
      providerId: HOME_DEPOT_PROVIDER_ID,
      productId,
      sku: null,
      url: null,
      productName: "",
      unitLabel: "",
      currentPrice: 0,
      currency: "USD",
      locationZip: input.locationZip,
      locationStoreId: input.locationStoreId,
      locationLabel: input.locationLabel,
      fetchedAt: null,
      sourceStatus: "unavailable",
      sourceMode: "catalog-reference",
      limitation: input.limitation,
      rawMetadata: { reason: "unknown-product" },
    };
  }
  const mode = input.liveApiAvailable ? "live-api" : "catalog-reference";
  return {
    providerId: HOME_DEPOT_PROVIDER_ID,
    productId: product.productId,
    sku: product.sku,
    url: product.url,
    productName: product.name,
    unitLabel: product.unitLabel,
    currentPrice: roundMoney(product.catalogUnitPrice),
    currency: "USD",
    locationZip: input.locationZip,
    locationStoreId: input.locationStoreId,
    locationLabel: input.locationLabel,
    fetchedAt: input.now,
    sourceStatus: classifySupplierPriceFreshness(input.now, input.now),
    sourceMode: mode,
    limitation: input.liveApiAvailable
      ? null
      : input.limitation,
    rawMetadata: {
      adapter: "home-depot-catalog",
      liveApi: input.liveApiAvailable,
    },
  };
}

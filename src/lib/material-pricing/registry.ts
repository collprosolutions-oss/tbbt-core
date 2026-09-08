/**
 * Supplier price provider registry. Estimators talk to this registry,
 * never to a named store. Home Depot is the first implemented adapter;
 * Lowe’s is registered so it can be added later without redesign.
 */
import { createHomeDepotProvider } from "@/lib/material-pricing/home-depot";
import {
  DEFAULT_SUPPLIER_PROVIDER_ID,
  isSupplierProviderId,
  SUPPLIER_PROVIDER_LABELS,
  type SupplierPriceProvider,
  type SupplierProviderId,
} from "@/lib/material-pricing/types";

const HOME_DEPOT_LIVE_UNAVAILABLE =
  "Home Depot does not provide an authorized real-time pricing API in this TBBT environment. This adapter uses a controlled product catalog and owner-confirmed store checks. It is not a production scraper and can be replaced later without changing the estimator.";

const LOWES_NOT_IMPLEMENTED =
  "Lowe’s is registered for a later supplier adapter. It is not connected in this pricing-foundation release.";

function createUnimplementedProvider(id: SupplierProviderId): SupplierPriceProvider {
  return {
    id,
    displayName: SUPPLIER_PROVIDER_LABELS[id],
    liveApiAvailable: false,
    implemented: false,
    limitation: LOWES_NOT_IMPLEMENTED,
    lookupProduct() {
      return null;
    },
    suggestedMappings() {
      return [];
    },
    async fetchPrice() {
      return {
        providerId: id,
        productId: "",
        sku: null,
        url: null,
        productName: "",
        unitLabel: "",
        currentPrice: 0,
        currency: "USD",
        locationZip: null,
        locationStoreId: null,
        locationLabel: null,
        fetchedAt: null,
        sourceStatus: "unavailable",
        sourceMode: "catalog-reference",
        limitation: LOWES_NOT_IMPLEMENTED,
        rawMetadata: null,
      };
    },
  };
}

const providers: Record<SupplierProviderId, SupplierPriceProvider> = {
  "home-depot": createHomeDepotProvider({
    limitation: HOME_DEPOT_LIVE_UNAVAILABLE,
  }),
  lowes: createUnimplementedProvider("lowes"),
};

export function listSupplierProviders(): SupplierPriceProvider[] {
  return SUPPLIER_PROVIDER_IDS_INTERNAL.map((id) => providers[id]);
}

const SUPPLIER_PROVIDER_IDS_INTERNAL: SupplierProviderId[] = ["home-depot", "lowes"];

export function getSupplierProvider(
  id?: string | null,
): SupplierPriceProvider {
  if (id && isSupplierProviderId(id)) {
    return providers[id];
  }
  return providers[DEFAULT_SUPPLIER_PROVIDER_ID];
}

export function defaultSupplierProvider(): SupplierPriceProvider {
  return providers[DEFAULT_SUPPLIER_PROVIDER_ID];
}

export { HOME_DEPOT_LIVE_UNAVAILABLE, LOWES_NOT_IMPLEMENTED };

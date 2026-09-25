/**
 * Provider-neutral future supplier commerce adapter.
 *
 * Product lookup, price quote, availability, and cart/order handoff
 * stay DISCONNECTED unless a real licensed integration is connected.
 * This is not the existing Home Depot catalog-reference price helper
 * and it does not scrape retailers.
 */
import {
  SUPPLIER_INTEGRATION_LICENSING_NOTICE,
  type SupplierAdapterState,
} from "@/lib/materials/types";

export const SUPPLIER_COMMERCE_ADAPTER_ID = "unconnected";

export const SUPPLIER_COMMERCE_DISCONNECTED_LIMITATION =
  "No supplier commerce provider is connected. Product lookup, live quotes, availability, and cart/order handoff stay unavailable until a licensed API integration is reviewed and connected. TBBT does not scrape Home Depot, Lowe’s, or other retailers.";

export type SupplierProductLookupResult = {
  providerId: string;
  productId: string;
  name: string;
  sku: string | null;
  url: string | null;
  unitLabel: string | null;
};

export type SupplierPriceQuoteResult = {
  providerId: string;
  productId: string;
  price: number | null;
  currency: "USD";
  available: boolean | null;
  quotedAt: Date | null;
  limitation: string;
};

export type SupplierAvailabilityResult = {
  providerId: string;
  productId: string;
  available: boolean | null;
  locationLabel: string | null;
  limitation: string;
};

export type SupplierCartHandoffResult = {
  providerId: string;
  handoffUrl: string | null;
  orderId: string | null;
  placed: false;
  limitation: string;
};

export type SupplierCommerceAdapter = {
  providerId: string;
  displayName: string;
  connectionState: SupplierAdapterState;
  limitation: string;
  licensingNotice: string;
  lookupProduct(query: string): Promise<SupplierProductLookupResult | null>;
  quotePrice(productId: string): Promise<SupplierPriceQuoteResult>;
  checkAvailability(productId: string): Promise<SupplierAvailabilityResult>;
  createCartHandoff(input: {
    productIds: string[];
  }): Promise<SupplierCartHandoffResult>;
};

function disconnectedAdapter(): SupplierCommerceAdapter {
  return {
    providerId: SUPPLIER_COMMERCE_ADAPTER_ID,
    displayName: "Unconnected supplier adapter",
    connectionState: "DISCONNECTED",
    limitation: SUPPLIER_COMMERCE_DISCONNECTED_LIMITATION,
    licensingNotice: SUPPLIER_INTEGRATION_LICENSING_NOTICE,
    async lookupProduct() {
      return null;
    },
    async quotePrice() {
      return {
        providerId: SUPPLIER_COMMERCE_ADAPTER_ID,
        productId: "",
        price: null,
        currency: "USD",
        available: null,
        quotedAt: null,
        limitation: SUPPLIER_COMMERCE_DISCONNECTED_LIMITATION,
      };
    },
    async checkAvailability() {
      return {
        providerId: SUPPLIER_COMMERCE_ADAPTER_ID,
        productId: "",
        available: null,
        locationLabel: null,
        limitation: SUPPLIER_COMMERCE_DISCONNECTED_LIMITATION,
      };
    },
    async createCartHandoff() {
      return {
        providerId: SUPPLIER_COMMERCE_ADAPTER_ID,
        handoffUrl: null,
        orderId: null,
        placed: false,
        limitation: SUPPLIER_COMMERCE_DISCONNECTED_LIMITATION,
      };
    },
  };
}

export function getSupplierCommerceAdapter(): SupplierCommerceAdapter {
  return disconnectedAdapter();
}

export function supplierAdapterIsConnected(adapter = getSupplierCommerceAdapter()) {
  return adapter.connectionState === "CONNECTED";
}

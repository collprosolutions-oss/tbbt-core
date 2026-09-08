/**
 * Customer-facing material views must never include supplier cost, SKU,
 * markup, store mapping, provider timestamps, or other internals.
 */
import type { PublicCustomerMaterialView } from "@/lib/material-pricing/types";

const INTERNAL_PRICING_KEYS = [
  "unitCost",
  "customerUnitPrice",
  "markupPercent",
  "markup",
  "supplier",
  "provider",
  "sku",
  "fetchedAt",
  "sourceStatus",
  "sourceMode",
  "locationZip",
  "locationStoreId",
  "rawMetadata",
  "Home Depot",
  "home-depot",
] as const;

export function publicCustomerMaterialView(input: {
  description: string;
  quantityLabel: string;
}): PublicCustomerMaterialView {
  return {
    description: input.description,
    quantityLabel: input.quantityLabel,
  };
}

export function customerMaterialViewLeaksInternalPricing(
  view: Record<string, unknown>,
) {
  const keys = Object.keys(view);
  return keys.some(
    (key) =>
      key !== "description" &&
      key !== "quantityLabel" &&
      INTERNAL_PRICING_KEYS.some((internal) =>
        key.toLowerCase().includes(String(internal).toLowerCase()),
      ),
  );
}

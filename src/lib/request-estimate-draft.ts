/**
 * Owner-controlled estimate-draft preparation from a submitted request.
 *
 * This does not send, approve, or create a Job/Invoice. createEstimate()
 * still opens an empty DRAFT today. This helper is the conversion path
 * once the founder wants request lines copied onto that draft.
 */
import { coerceRequestQuantity } from "@/lib/service-request-work";
import { publicCatalogUnitAmount } from "@/lib/pricing-mode";

export type RequestDraftSourceItem = {
  quantity?: number | null;
  customDescription?: string | null;
  serviceCatalogItem?: {
    name: string;
    pricingMode: string;
    price: { toString(): string } | number | null;
  } | null;
};

export type DraftEstimateLine = {
  description: string;
  quantity: number;
  unitPrice: number | null;
  pricingMode: string;
  priced: boolean;
};

export function draftEstimateLinesFromRequestItems(
  items: RequestDraftSourceItem[],
): DraftEstimateLine[] {
  return items.map((item) => {
    const catalog = item.serviceCatalogItem;
    const quantity = coerceRequestQuantity(item.quantity, 1);
    if (!catalog) {
      return {
        description: item.customDescription?.trim() || "Custom work",
        quantity,
        unitPrice: null,
        pricingMode: "CUSTOM_QUOTE",
        priced: false,
      };
    }
    const unitPrice = publicCatalogUnitAmount(catalog.pricingMode, catalog.price);
    return {
      description: catalog.name,
      quantity,
      unitPrice,
      pricingMode: catalog.pricingMode,
      priced: unitPrice != null,
    };
  });
}

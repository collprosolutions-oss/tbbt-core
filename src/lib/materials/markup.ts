/**
 * Material markup / actual-cost separation.
 *
 * Existing takeoff markup is owner-entered and explicit. This module
 * never invents a default markup, never rewrites a SENT/APPROVED
 * estimate snapshot, and never mutates a customer invoice because a
 * supplier or catalog price changed.
 */
import { markedUpCustomerUnitPrice } from "@/lib/material-takeoff/types";
import { roundMoney } from "@/lib/estimate-calculators/types";

export const MARKUP_IS_OWNER_ENTERED_ONLY =
  "Material markup is applied only when the owner enters a markup. TBBT does not invent a default markup.";

export function ownerEnteredMarkupPercent(value: unknown): number | null {
  if (value == null || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return numeric;
}

export function customerPriceFromOwnerMarkup(
  unitCost: number,
  markupPercent: number | null,
): number | null {
  if (markupPercent == null) return null;
  return markedUpCustomerUnitPrice(unitCost, markupPercent);
}

export function separateMaterialMoneyLayers(input: {
  estimatedUnitCost?: number | null;
  estimatedQuantity?: number | null;
  markupPercent?: number | null;
  customerUnitPrice?: number | null;
  purchasedUnitCost?: number | null;
  purchasedQuantity?: number | null;
}) {
  const estimatedUnitCost =
    input.estimatedUnitCost != null && Number.isFinite(input.estimatedUnitCost)
      ? input.estimatedUnitCost
      : null;
  const estimatedQuantity =
    input.estimatedQuantity != null && Number.isFinite(input.estimatedQuantity)
      ? input.estimatedQuantity
      : null;
  const purchasedUnitCost =
    input.purchasedUnitCost != null && Number.isFinite(input.purchasedUnitCost)
      ? input.purchasedUnitCost
      : null;
  const purchasedQuantity =
    input.purchasedQuantity != null && Number.isFinite(input.purchasedQuantity)
      ? input.purchasedQuantity
      : null;
  const markupPercent = ownerEnteredMarkupPercent(input.markupPercent);
  const customerUnitPrice =
    input.customerUnitPrice != null && Number.isFinite(input.customerUnitPrice)
      ? input.customerUnitPrice
      : customerPriceFromOwnerMarkup(estimatedUnitCost ?? 0, markupPercent);

  return {
    estimatedUnitCost,
    estimatedQuantity,
    estimatedCost:
      estimatedUnitCost != null && estimatedQuantity != null
        ? roundMoney(estimatedUnitCost * estimatedQuantity)
        : null,
    markupPercent,
    customerUnitPrice,
    purchasedUnitCost,
    purchasedQuantity,
    purchasedCost:
      purchasedUnitCost != null && purchasedQuantity != null
        ? roundMoney(purchasedUnitCost * purchasedQuantity)
        : null,
    invoiceMustStayFrozen: true,
    snapshotMustStayFrozen: true,
  };
}

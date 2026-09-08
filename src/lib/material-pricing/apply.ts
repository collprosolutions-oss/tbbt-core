/**
 * Apply a current supplier cost onto a DRAFT takeoff item.
 *
 * Feeds internal unit cost. Existing markup math still calculates the
 * customer selling price. Does not save business defaults. Callers must
 * refuse SENT / APPROVED / job / invoice records.
 */
import { roundMoney } from "@/lib/estimate-calculators/types";
import { markedUpCustomerUnitPrice, type TakeoffSnapshot } from "@/lib/material-takeoff/types";

export function applyCurrentSupplierPriceToDraftItem(
  snapshot: TakeoffSnapshot,
  itemId: string,
  supplierUnitCost: number,
): TakeoffSnapshot {
  const cost = roundMoney(supplierUnitCost);
  if (!(cost > 0)) return snapshot;
  let found = false;
  const items = snapshot.items.map((item) => {
    if (item.id !== itemId) return item;
    found = true;
    const next = { ...item, unitCost: cost };
    const markup = snapshot.markupPercent;
    if (markup > 0) {
      const price = markedUpCustomerUnitPrice(cost, markup);
      if (price != null) {
        next.customerUnitPrice = price;
      }
    }
    return next;
  });
  if (!found) return snapshot;
  return { ...snapshot, items };
}

/** Page load and recalc must never call this. Owner action only. */
export const APPLY_SUPPLIER_PRICE_REQUIRES_OWNER_ACTION = true;

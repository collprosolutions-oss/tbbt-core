/**
 * Owner-only material takeoff snapshots.
 *
 * Trade-aware starter formulas (concrete slab, sheet covering, framed
 * wall) share this shape so later trades can register without rewriting
 * storage or conversion. Snapshots are encoded in LineItem.description
 * after MATERIAL_TAKEOFF_MARKER — not a Prisma column.
 */
import { roundMoney } from "@/lib/estimate-calculators/types";

export const TAKEOFF_TYPE_IDS = [
  "concrete-slab",
  "sheet-covering",
  "framed-wall",
  "generic-custom",
] as const;

export type TakeoffTypeId = (typeof TAKEOFF_TYPE_IDS)[number];

export function isTakeoffTypeId(value: unknown): value is TakeoffTypeId {
  return (
    typeof value === "string" &&
    (TAKEOFF_TYPE_IDS as readonly string[]).includes(value)
  );
}

export const TAKEOFF_TYPE_LABELS: Record<TakeoffTypeId, string> = {
  "concrete-slab": "Concrete slab",
  "sheet-covering": "Sheet / wall covering",
  "framed-wall": "Simple framed wall",
  "generic-custom": "Custom labor & materials",
};

export type TakeoffMeasurementSourceKind = "intake" | "calculator" | "manual";

export type TakeoffMeasurementSource = {
  kind: TakeoffMeasurementSourceKind;
  label: string;
  unverified: boolean;
};

export type TakeoffItemPersistAs = "project" | "business-default";

export type TakeoffItem = {
  id: string;
  kind: string;
  label: string;
  unit: string;
  optional: boolean;
  selected: boolean;
  calculatedQuantity: number;
  quantityOverride: number | null;
  unitCost: number | null;
  customerUnitPrice: number | null;
  explanation: string;
  convertedLineItemId: string | null;
  /**
   * Owner-added materials only. Standard generated items always save
   * reusable prices with the calculator. "project" is the default so a
   * one-off add does not silently become a business default.
   */
  persistAs?: TakeoffItemPersistAs;
};

export type TakeoffSnapshot = {
  version: 1;
  takeoffType: TakeoffTypeId;
  inputs: Record<string, unknown>;
  wastePercent: number;
  /** Owner helper only. Applied when the owner clicks Apply markup; never auto-run on recalc. */
  markupPercent: number;
  /** Owner labor-helper rate. Concrete slab: $ per 60-lb bag. 0 means use the type default. */
  laborRate: number;
  /**
   * Extra labor outside the production-rate assumption (unusual excavation,
   * demolition, difficult access, specialty finish, etc.). Not auto-stacked
   * from normal slab tasks already covered by the production rate.
   */
  laborAdjustment: number;
  measurementSource: TakeoffMeasurementSource | null;
  explanation: string;
  skippedMeasurements: string[];
  removedItemIds: string[];
  items: TakeoffItem[];
};

export type TakeoffSourceRef = {
  parentLineItemId: string;
  itemId: string;
};

export type TakeoffComputeResult = {
  snapshot: TakeoffSnapshot;
  rejected: string | null;
};

export function workingQuantity(item: TakeoffItem) {
  if (item.quantityOverride != null && Number.isFinite(item.quantityOverride)) {
    return item.quantityOverride;
  }
  return item.calculatedQuantity;
}

export function extendedMaterialCost(item: TakeoffItem) {
  const qty = workingQuantity(item);
  const unitCost = item.unitCost;
  if (unitCost == null || !Number.isFinite(unitCost)) return 0;
  return roundMoney(qty * unitCost);
}

export function hasValidInternalUnitCost(item: TakeoffItem) {
  const cost = item.unitCost;
  return cost != null && Number.isFinite(cost) && cost > 0;
}

export function markedUpCustomerUnitPrice(
  unitCost: number,
  markupPercent: number,
): number | null {
  if (!Number.isFinite(unitCost) || !(unitCost > 0)) return null;
  if (!Number.isFinite(markupPercent) || markupPercent < 0) return null;
  const price = roundMoney(unitCost * (1 + markupPercent / 100));
  if (!(price > 0)) return null;
  return price;
}

export function hasValidCustomerUnitPrice(item: TakeoffItem) {
  const price = item.customerUnitPrice;
  return price != null && Number.isFinite(price) && price > 0;
}

export function extendedCustomerPrice(item: TakeoffItem) {
  const qty = workingQuantity(item);
  if (!hasValidCustomerUnitPrice(item) || item.customerUnitPrice == null) return 0;
  return roundMoney(qty * item.customerUnitPrice);
}

export function takeoffInternalMaterialTotal(snapshot: TakeoffSnapshot) {
  return roundMoney(
    snapshot.items.reduce((sum, item) => sum + extendedMaterialCost(item), 0),
  );
}

export function takeoffCustomerSellingTotal(snapshot: TakeoffSnapshot) {
  return roundMoney(
    snapshot.items.reduce((sum, item) => sum + extendedCustomerPrice(item), 0),
  );
}

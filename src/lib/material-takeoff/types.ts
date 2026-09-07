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
};

export type TakeoffMeasurementSourceKind = "intake" | "calculator" | "manual";

export type TakeoffMeasurementSource = {
  kind: TakeoffMeasurementSourceKind;
  label: string;
  unverified: boolean;
};

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
};

export type TakeoffSnapshot = {
  version: 1;
  takeoffType: TakeoffTypeId;
  inputs: Record<string, unknown>;
  wastePercent: number;
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

/**
 * Client-safe materials / suppliers types.
 *
 * Owner-managed catalog and procurement records are separate from:
 *   - BusinessEstimatingDefault (reusable calculator starting costs)
 *   - project takeoff snapshots (DRAFT overrides)
 *   - SENT / APPROVED / job / invoice encodings (frozen)
 *   - Expense rows (the only counted actual cost for Financial #102)
 *
 * This file must stay free of Prisma.
 */

export const MATERIAL_PRICE_SOURCES = [
  "OWNER_ENTRY",
  "EXPENSE",
  "PURCHASE",
  "PROVIDER",
] as const;
export type MaterialPriceSource = (typeof MATERIAL_PRICE_SOURCES)[number];

export const PURCHASE_ITEM_STATUSES = [
  "NEEDED",
  "PLANNED",
  "ORDERED",
  "PURCHASED",
  "RECEIVED",
  "CANCELLED",
] as const;
export type PurchaseItemStatus = (typeof PURCHASE_ITEM_STATUSES)[number];

export const PURCHASE_ORDER_STATUSES = [
  "DRAFT",
  "READY",
  "ORDERED_EXTERNALLY",
  "PARTIALLY_RECEIVED",
  "RECEIVED",
  "CANCELLED",
] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

export const SUPPLIER_ADAPTER_STATES = ["DISCONNECTED", "CONNECTED"] as const;
export type SupplierAdapterState = (typeof SUPPLIER_ADAPTER_STATES)[number];

export const PURCHASE_ITEM_STATUS_LABELS: Record<PurchaseItemStatus, string> = {
  NEEDED: "Needed",
  PLANNED: "Planned",
  ORDERED: "Ordered",
  PURCHASED: "Purchased",
  RECEIVED: "Received",
  CANCELLED: "Cancelled",
};

export const PURCHASE_ORDER_STATUS_LABELS: Record<PurchaseOrderStatus, string> = {
  DRAFT: "Draft",
  READY: "Ready",
  ORDERED_EXTERNALLY: "Ordered externally",
  PARTIALLY_RECEIVED: "Partially received",
  RECEIVED: "Received",
  CANCELLED: "Cancelled",
};

export const PURCHASE_ORDER_TRANSITIONS: Record<
  PurchaseOrderStatus,
  readonly PurchaseOrderStatus[]
> = {
  DRAFT: ["DRAFT", "READY", "ORDERED_EXTERNALLY", "CANCELLED"],
  READY: ["READY", "DRAFT", "ORDERED_EXTERNALLY", "CANCELLED"],
  ORDERED_EXTERNALLY: ["ORDERED_EXTERNALLY", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED"],
  PARTIALLY_RECEIVED: ["PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED"],
  RECEIVED: ["RECEIVED"],
  CANCELLED: ["CANCELLED"],
};

export function canTransitionPurchaseOrder(
  from: PurchaseOrderStatus,
  to: PurchaseOrderStatus,
) {
  return PURCHASE_ORDER_TRANSITIONS[from].includes(to);
}

/** Statuses that accept an OWNER-recorded delivery against an existing PO. */
export const PURCHASE_ORDER_RECEIPT_STATUSES = [
  "ORDERED_EXTERNALLY",
  "PARTIALLY_RECEIVED",
] as const;
export type PurchaseOrderReceiptStatus = (typeof PURCHASE_ORDER_RECEIPT_STATUSES)[number];

export function canRecordPurchaseOrderReceipt(status: string) {
  return (PURCHASE_ORDER_RECEIPT_STATUSES as readonly string[]).includes(status);
}

export type PurchaseOrderReceiptQuantities = {
  quantityOrdered: number;
  quantityReceived: number;
  quantityRemaining: number;
  fullyReceived: boolean;
};

/**
 * Ordered-versus-received math for one PO line. `quantityReceived` is the
 * OWNER-recorded PO receipt total — not purchase-list quantityPurchased
 * and not worker quantityPickedUp from the native pickup PR.
 */
export function purchaseOrderReceiptQuantities(input: {
  quantityOrdered: string | number;
  quantityReceived?: string | number | null;
}): PurchaseOrderReceiptQuantities {
  const quantityOrdered = Number(input.quantityOrdered);
  const quantityReceived = Number(input.quantityReceived ?? 0);
  const ordered = Number.isFinite(quantityOrdered) ? quantityOrdered : 0;
  const received = Number.isFinite(quantityReceived) ? quantityReceived : 0;
  const quantityRemaining = Math.max(0, ordered - received);
  return {
    quantityOrdered: ordered,
    quantityReceived: received,
    quantityRemaining,
    fullyReceived: ordered > 0 && received >= ordered,
  };
}

export function purchaseOrderStatusFromReceipts(
  lines: ReadonlyArray<PurchaseOrderReceiptQuantities>,
): PurchaseOrderStatus {
  if (lines.length > 0 && lines.every((line) => line.fullyReceived)) {
    return "RECEIVED";
  }
  if (lines.some((line) => line.quantityReceived > 0)) {
    return "PARTIALLY_RECEIVED";
  }
  return "ORDERED_EXTERNALLY";
}

export function isMaterialPriceSource(value: unknown): value is MaterialPriceSource {
  return (
    typeof value === "string" &&
    (MATERIAL_PRICE_SOURCES as readonly string[]).includes(value)
  );
}

export function isPurchaseItemStatus(value: unknown): value is PurchaseItemStatus {
  return (
    typeof value === "string" &&
    (PURCHASE_ITEM_STATUSES as readonly string[]).includes(value)
  );
}

export function isPurchaseOrderStatus(value: unknown): value is PurchaseOrderStatus {
  return (
    typeof value === "string" &&
    (PURCHASE_ORDER_STATUSES as readonly string[]).includes(value)
  );
}

export function normalizeMaterialName(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export type FieldJobPickupView = {
  id: string;
  name: string;
  quantityNeeded: string;
  unit: string;
  supplierName: string | null;
  pickupRequired: boolean;
  pickupLocationDescription: string | null;
  pickupDurationMinutes: number | null;
  pickupReady: boolean;
  status: PurchaseItemStatus;
};

export type JobMaterialPickupRequirement = {
  jobId: string;
  purchaseListItemId: string;
  name: string;
  quantityNeeded: number;
  unit: string;
  supplierName: string | null;
  locationDescription: string | null;
  durationMinutes: number | null;
  ready: boolean;
  status: PurchaseItemStatus;
};

export type MaterialActualCostLink = {
  purchaseListItemId: string;
  expenseId: string;
  jobId: string | null;
  amount: number;
  countedAsExpense: true;
  doNotDoubleCount: true;
};

export type MaterialVarianceRow = {
  purchaseListItemId: string;
  name: string;
  estimatedQuantity: number | null;
  estimatedCost: number | null;
  purchasedQuantity: number | null;
  purchasedCost: number | null;
  quantityDelta: number | null;
  costDelta: number | null;
  customerUnitPrice: number | null;
  markupPercent: number | null;
};

export const SUPPLIER_INTEGRATION_LICENSING_NOTICE =
  "Any production supplier/provider integration requires a signed API agreement or other licensing review. TBBT does not scrape retailers, redistributes no third-party catalog, and must not commercially reuse supplier product data without permission.";

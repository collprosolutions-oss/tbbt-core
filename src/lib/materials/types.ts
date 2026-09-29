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
  ORDERED_EXTERNALLY: ["ORDERED_EXTERNALLY", "CANCELLED"],
  PARTIALLY_RECEIVED: ["PARTIALLY_RECEIVED", "CANCELLED"],
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

export const PURCHASE_ORDER_RECEIPT_QUANTITY_PATTERN = /^\d+(\.\d{1,4})?$/;

export type ParsedReceiptQuantity =
  | { status: "skip" }
  | { status: "ok"; normalized: string }
  | { status: "invalid" };

/**
 * Blank or 0 means this line was not on the delivery. Anything that is
 * not a plain decimal with at most four fractional digits is rejected.
 */
export function parseReceiptDeliveryQuantity(raw: unknown): ParsedReceiptQuantity {
  if (raw == null) return { status: "skip" };
  const text = String(raw).trim();
  if (text === "") return { status: "skip" };
  if (!PURCHASE_ORDER_RECEIPT_QUANTITY_PATTERN.test(text)) return { status: "invalid" };
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return { status: "invalid" };
  if (value === 0) return { status: "skip" };
  return { status: "ok", normalized: text };
}

export function purchaseOrderReceiptFingerprint(
  purchaseOrderId: string,
  items: ReadonlyArray<{ purchaseOrderItemId: string; quantity: string }>,
) {
  const lines = [...items]
    .map((item) => ({
      id: item.purchaseOrderItemId.trim(),
      quantity: item.quantity,
    }))
    .filter((item) => item.id)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((item) => `${item.id}:${item.quantity}`)
    .join("|");
  return `${purchaseOrderId.trim()}|${lines}`;
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

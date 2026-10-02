/**
 * OWNER-only offline supplier handoff for one recorded purchase order.
 *
 * This is a printable CSV of tenant-owned PO, supplier, line, and
 * historical-price records. It is not a retailer order, supplier API
 * call, scraped price lookup, stock receipt, or customer message.
 */
export const PURCHASE_ORDER_EXPORT_CONTRACT = "tbbt.purchase-order-supplier-handoff.v1" as const;
export const PURCHASE_ORDER_EXPORT_VERSION = 1;
export const PURCHASE_ORDER_EXPORT_KIND = "OFFLINE_SUPPLIER_HANDOFF" as const;
export const PURCHASE_ORDER_EXPORT_PRICE_READ_LIMIT = 40;

export const PURCHASE_ORDER_EXPORT_NOTICE =
  "Offline supplier handoff. TBBT does not place a retailer order, call a supplier API, scrape prices, record a stock receipt, or send a customer message.";

export const PURCHASE_ORDER_EXPORT_HEADERS = [
  "Purchase Order ID",
  "Status",
  "Status Label",
  "Supplier Name",
  "Supplier Contact Name",
  "Supplier Phone",
  "Supplier Email",
  "Supplier Account Reference",
  "Supplier Location",
  "Line Name",
  "SKU",
  "Quantity",
  "Unit",
  "Recorded Unit Cost",
  "Extended Cost",
  "Latest Historical Price",
  "Latest Historical Observed At",
  "Latest Historical Source",
  "Historical Prices",
  "Document Kind",
  "Document Notice",
] as const;

export type PurchaseOrderExportLimits = {
  placesRetailerOrder: false;
  callsSupplierApi: false;
  scrapesPrices: false;
  recordsStockReceipt: false;
  sendsCustomerMessage: false;
  liveSynchronization: false;
  priceHistoryLimit: number;
  priceHistoryTruncated: boolean;
};

export type PurchaseOrderExportAuthorization = {
  role: "OWNER";
  businessId: string;
};

export type PurchaseOrderExportSupplier = {
  id: string;
  name: string;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  accountReference: string | null;
  locationDescription: string | null;
};

export type PurchaseOrderExportHistoricalPrice = {
  id: string;
  price: string;
  observedAt: string;
  source: string;
  supplierName: string | null;
};

export type PurchaseOrderExportLine = {
  id: string;
  name: string;
  sku: string | null;
  unit: string;
  quantity: string;
  recordedUnitCost: string | null;
  extendedCost: string | null;
  historicalPrices: PurchaseOrderExportHistoricalPrice[];
};

export type PurchaseOrderExportDocument = {
  contract: typeof PURCHASE_ORDER_EXPORT_CONTRACT;
  version: typeof PURCHASE_ORDER_EXPORT_VERSION;
  kind: typeof PURCHASE_ORDER_EXPORT_KIND;
  notice: typeof PURCHASE_ORDER_EXPORT_NOTICE;
  limits: PurchaseOrderExportLimits;
  authorization: PurchaseOrderExportAuthorization;
  purchaseOrder: {
    id: string;
    status: string;
    statusLabel: string;
    notes: string | null;
    createdAt: string;
    orderedAt: string | null;
  };
  supplier: PurchaseOrderExportSupplier | null;
  lines: PurchaseOrderExportLine[];
};

export function defaultPurchaseOrderExportLimits(
  priceHistoryTruncated = false,
): PurchaseOrderExportLimits {
  return {
    placesRetailerOrder: false,
    callsSupplierApi: false,
    scrapesPrices: false,
    recordsStockReceipt: false,
    sendsCustomerMessage: false,
    liveSynchronization: false,
    priceHistoryLimit: PURCHASE_ORDER_EXPORT_PRICE_READ_LIMIT,
    priceHistoryTruncated,
  };
}

export function purchaseOrderSupplierHandoffDownloadPath(purchaseOrderId: string): string {
  return `/materials/purchase-orders/${encodeURIComponent(purchaseOrderId)}/supplier-handoff/download`;
}

export function purchaseOrderSupplierHandoffFilename(
  document: Pick<PurchaseOrderExportDocument, "purchaseOrder">,
): string {
  const short = document.purchaseOrder.id.replace(/[^a-zA-Z0-9]/g, "").slice(-8).toLowerCase();
  return `po-${short || "order"}-supplier-handoff.csv`;
}

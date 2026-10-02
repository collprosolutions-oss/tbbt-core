import type { PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { extendedCost } from "@/lib/materials/money";
import {
  PURCHASE_ORDER_STATUS_LABELS,
  isPurchaseOrderStatus,
} from "@/lib/materials/types";
import { toCsv } from "@/lib/zip-store";
import {
  assertCanExportPurchaseOrderSupplierHandoff,
  invalidPurchaseOrderExportError,
  notFoundPurchaseOrderExportError,
} from "@/lib/purchase-order-export/access";
import {
  PURCHASE_ORDER_EXPORT_CONTRACT,
  PURCHASE_ORDER_EXPORT_HEADERS,
  PURCHASE_ORDER_EXPORT_KIND,
  PURCHASE_ORDER_EXPORT_NOTICE,
  PURCHASE_ORDER_EXPORT_PRICE_READ_LIMIT,
  PURCHASE_ORDER_EXPORT_VERSION,
  defaultPurchaseOrderExportLimits,
  type PurchaseOrderExportDocument,
  type PurchaseOrderExportHistoricalPrice,
  type PurchaseOrderExportLine,
} from "@/lib/purchase-order-export/contract";

function decimalText(value: { toString(): string } | null | undefined): string | null {
  return value == null ? null : value.toString();
}

function statusLabel(status: string): string {
  return isPurchaseOrderStatus(status) ? PURCHASE_ORDER_STATUS_LABELS[status] : status;
}

function formatHistoricalPriceList(prices: PurchaseOrderExportHistoricalPrice[]): string {
  return prices
    .map((row) => {
      const supplier = row.supplierName ? ` ${row.supplierName}` : "";
      return `${row.price} (${row.source} ${row.observedAt}${supplier})`;
    })
    .join("; ");
}

export function boundExportRead<T>(rows: T[], limit: number): { items: T[]; truncated: boolean } {
  if (rows.length > limit) {
    return { items: rows.slice(0, limit), truncated: true };
  }
  return { items: rows, truncated: false };
}

export function purchaseOrderSupplierHandoffCsv(document: PurchaseOrderExportDocument): string {
  return toCsv(
    PURCHASE_ORDER_EXPORT_HEADERS,
    document.lines.map((line) => {
      const latest = line.historicalPrices[0] ?? null;
      return {
        "Purchase Order ID": document.purchaseOrder.id,
        Status: document.purchaseOrder.status,
        "Status Label": document.purchaseOrder.statusLabel,
        "Supplier Name": document.supplier?.name ?? "",
        "Supplier Contact Name": document.supplier?.contactName ?? "",
        "Supplier Phone": document.supplier?.contactPhone ?? "",
        "Supplier Email": document.supplier?.contactEmail ?? "",
        "Supplier Account Reference": document.supplier?.accountReference ?? "",
        "Supplier Location": document.supplier?.locationDescription ?? "",
        "Line Name": line.name,
        SKU: line.sku ?? "",
        Quantity: line.quantity,
        Unit: line.unit,
        "Recorded Unit Cost": line.recordedUnitCost ?? "",
        "Extended Cost": line.extendedCost ?? "",
        "Latest Historical Price": latest?.price ?? "",
        "Latest Historical Observed At": latest?.observedAt ?? "",
        "Latest Historical Source": latest?.source ?? "",
        "Historical Prices": formatHistoricalPriceList(line.historicalPrices),
        "Document Kind": document.kind,
        "Document Notice": document.notice,
      };
    }),
  );
}

export async function buildPurchaseOrderSupplierHandoff(
  db: PrismaClient,
  access: BusinessAccess,
  input: { purchaseOrderId: string },
): Promise<PurchaseOrderExportDocument> {
  assertCanExportPurchaseOrderSupplierHandoff(access);
  const purchaseOrderId = input.purchaseOrderId.trim();
  if (!purchaseOrderId) {
    throw invalidPurchaseOrderExportError("Choose a purchase order to export.");
  }

  const businessId = access.businessId;
  const order = await db.materialPurchaseOrder.findFirst({
    where: { id: purchaseOrderId, businessId },
    include: {
      supplier: {
        select: {
          id: true,
          businessId: true,
          name: true,
          contactName: true,
          contactPhone: true,
          contactEmail: true,
          accountReference: true,
          locationDescription: true,
        },
      },
      items: {
        where: { businessId },
        include: {
          purchaseListItem: {
            select: {
              id: true,
              businessId: true,
              name: true,
              unit: true,
              materialId: true,
              material: {
                select: { id: true, businessId: true, sku: true },
              },
            },
          },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!order) {
    throw notFoundPurchaseOrderExportError();
  }
  access.assertOwned(order);
  if (order.supplier) {
    access.assertOwned(order.supplier);
  }

  const materialIds: string[] = [];
  const listItemIds: string[] = [];
  for (const item of order.items) {
    access.assertOwned(item);
    access.assertOwned(item.purchaseListItem);
    if (item.purchaseListItem.material) {
      access.assertOwned(item.purchaseListItem.material);
    }
    if (item.purchaseListItem.materialId) {
      materialIds.push(item.purchaseListItem.materialId);
    }
    listItemIds.push(item.purchaseListItem.id);
  }

  const historyWhere =
    materialIds.length > 0 && listItemIds.length > 0
      ? {
          businessId,
          OR: [
            { materialId: { in: materialIds } },
            { purchaseListItemId: { in: listItemIds } },
          ],
        }
      : materialIds.length > 0
        ? { businessId, materialId: { in: materialIds } }
        : listItemIds.length > 0
          ? { businessId, purchaseListItemId: { in: listItemIds } }
          : null;

  const historyRows = historyWhere
    ? await db.materialPriceHistory.findMany({
        where: historyWhere,
        include: {
          supplier: { select: { id: true, businessId: true, name: true } },
        },
        orderBy: [{ observedAt: "desc" }, { createdAt: "desc" }],
        take: PURCHASE_ORDER_EXPORT_PRICE_READ_LIMIT + 1,
      })
    : [];
  for (const row of historyRows) {
    access.assertOwned(row);
    if (row.supplier) {
      access.assertOwned(row.supplier);
    }
  }
  const boundedHistory = boundExportRead(historyRows, PURCHASE_ORDER_EXPORT_PRICE_READ_LIMIT);

  const lines: PurchaseOrderExportLine[] = order.items.map((item) => {
    const listItem = item.purchaseListItem;
    const matched = boundedHistory.items.filter(
      (row) =>
        (listItem.materialId != null && row.materialId === listItem.materialId) ||
        row.purchaseListItemId === listItem.id,
    );
    const seen = new Set<string>();
    const historicalPrices: PurchaseOrderExportHistoricalPrice[] = [];
    for (const row of matched) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      historicalPrices.push({
        id: row.id,
        price: row.price.toString(),
        observedAt: row.observedAt.toISOString(),
        source: row.source,
        supplierName: row.supplier?.name ?? null,
      });
    }
    return {
      id: item.id,
      name: listItem.name,
      sku: listItem.material?.sku ?? null,
      unit: listItem.unit,
      quantity: item.quantity.toString(),
      recordedUnitCost: decimalText(item.unitCost),
      extendedCost: decimalText(extendedCost(item.quantity, item.unitCost)),
      historicalPrices,
    };
  });

  return {
    contract: PURCHASE_ORDER_EXPORT_CONTRACT,
    version: PURCHASE_ORDER_EXPORT_VERSION,
    kind: PURCHASE_ORDER_EXPORT_KIND,
    notice: PURCHASE_ORDER_EXPORT_NOTICE,
    limits: defaultPurchaseOrderExportLimits(boundedHistory.truncated),
    authorization: {
      role: "OWNER",
      businessId,
    },
    purchaseOrder: {
      id: order.id,
      status: order.status,
      statusLabel: statusLabel(order.status),
      notes: order.notes,
      createdAt: order.createdAt.toISOString(),
      orderedAt: order.orderedAt?.toISOString() ?? null,
    },
    supplier: order.supplier
      ? {
          id: order.supplier.id,
          name: order.supplier.name,
          contactName: order.supplier.contactName,
          contactPhone: order.supplier.contactPhone,
          contactEmail: order.supplier.contactEmail,
          accountReference: order.supplier.accountReference,
          locationDescription: order.supplier.locationDescription,
        }
      : null,
    lines,
  };
}

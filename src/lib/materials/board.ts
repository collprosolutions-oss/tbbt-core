import type { PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { formatDate } from "@/lib/format";
import { asMoneyNumber } from "@/lib/materials/money";
import { financialMaterialCost } from "@/lib/materials/expense-link";
import { listMaterialCatalog, listSuppliers } from "@/lib/materials";
import { listMaterialPriceHistory } from "@/lib/materials/price-history";
import { ensurePurchaseList, loadPurchaseListBoard } from "@/lib/materials/purchase";
import { materialEstimateVsActual } from "@/lib/materials/variance";
import type { MaterialsCatalogRow, MaterialsSupplierRow } from "@/components/materials/materials-workspace";
import type {
  MaterialVarianceView,
  PurchaseListItemView,
  PurchaseOrderView,
} from "@/components/materials/purchase-list-card";

export async function loadMaterialsWorkspaceData(db: PrismaClient, access: BusinessAccess) {
  const [suppliers, catalog] = await Promise.all([
    listSuppliers(db, access),
    listMaterialCatalog(db, access),
  ]);
  const catalogRows: MaterialsCatalogRow[] = [];
  for (const item of catalog) {
    const history = await listMaterialPriceHistory(db, access, item.id);
    catalogRows.push({
      id: item.id,
      name: item.name,
      sku: item.sku,
      unit: item.unit,
      packSize: item.packSize?.toString() ?? null,
      preferredSupplierId: item.preferredSupplierId,
      preferredSupplierName: item.preferredSupplier?.name ?? null,
      lastKnownCost: item.lastKnownCost?.toString() ?? null,
      notes: item.notes,
      category: item.category,
      takeoffIdentity: item.takeoffIdentity,
      active: item.active,
      history: history.map((row) => ({
        id: row.id,
        price: row.price.toString(),
        observedAt: formatDate(row.observedAt),
        source: row.source,
        supplierName: row.supplier?.name ?? null,
      })),
    });
  }
  const supplierRows: MaterialsSupplierRow[] = suppliers.map((supplier) => ({
    id: supplier.id,
    name: supplier.name,
    contactName: supplier.contactName,
    contactEmail: supplier.contactEmail,
    contactPhone: supplier.contactPhone,
    website: supplier.website,
    accountReference: supplier.accountReference,
    preferred: supplier.preferred,
    notes: supplier.notes,
    active: supplier.active,
    categories: supplier.categories,
    locationDescription: supplier.locationDescription,
  }));
  return { suppliers: supplierRows, catalog: catalogRows };
}

export async function loadPurchaseWorkspace(
  db: PrismaClient,
  access: BusinessAccess,
  input: { jobId?: string | null; estimateId?: string | null; createIfMissing?: boolean },
) {
  if (input.createIfMissing) {
    await ensurePurchaseList(db, access, input);
  }
  const [board, variance, suppliers] = await Promise.all([
    loadPurchaseListBoard(db, access, input),
    materialEstimateVsActual(db, access, input),
    listSuppliers(db, access, true),
  ]);
  const items: PurchaseListItemView[] = (board?.items ?? []).map((item) => {
    const financial = financialMaterialCost(item);
    return {
      id: item.id,
      name: item.name,
      quantityNeeded: item.quantityNeeded.toString(),
      unit: item.unit,
      plannedUnitCost: item.plannedUnitCost?.toString() ?? null,
      plannedCost: item.plannedCost?.toString() ?? null,
      quantityPurchased: item.quantityPurchased?.toString() ?? null,
      actualUnitCost: item.actualUnitCost?.toString() ?? null,
      actualCost: item.actualCost?.toString() ?? null,
      financialCost: financial.amount != null ? String(financial.amount) : null,
      expenseId: item.expenseId,
      markupPercent: item.markupPercent?.toString() ?? null,
      customerUnitPrice: item.customerUnitPrice?.toString() ?? null,
      pickupRequired: item.pickupRequired,
      pickupLocationDescription: item.pickupLocationDescription,
      pickupDurationMinutes: item.pickupDurationMinutes,
      pickupReady: item.pickupReady,
      status: item.status,
      supplierId: item.supplierId,
      supplierName: item.supplier?.name ?? null,
      materialId: item.materialId,
    };
  });
  const orders: PurchaseOrderView[] = (board?.purchaseOrders ?? []).map((order) => ({
    id: order.id,
    status: order.status,
    supplierName: order.supplier?.name ?? null,
  }));
  const varianceRows: MaterialVarianceView[] = variance.map((row) => ({
    name: row.name,
    estimatedQuantity: row.estimatedQuantity,
    estimatedCost: row.estimatedCost,
    purchasedQuantity: row.purchasedQuantity,
    purchasedCost: row.purchasedCost,
    costDelta: row.costDelta,
  }));
  return {
    purchaseListId: board?.id ?? null,
    items,
    orders,
    variance: varianceRows,
    suppliers: suppliers.map((supplier) => ({ id: supplier.id, name: supplier.name })),
    asMoneyNumber,
  };
}

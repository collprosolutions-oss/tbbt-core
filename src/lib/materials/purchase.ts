import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  requireMaterialsEstimateAccess,
  requireMaterialsJobAccess,
  requirePurchaseListWriteAccess,
} from "@/lib/materials/access";
import { MaterialsError } from "@/lib/materials/errors";
import {
  asMoneyNumber,
  decimalMoney,
  decimalQuantity,
  extendedCost,
} from "@/lib/materials/money";
import { appendMaterialPriceHistory } from "@/lib/materials/price-history";
import {
  isPurchaseItemStatus,
  isPurchaseOrderStatus,
  type PurchaseItemStatus,
  type PurchaseOrderStatus,
} from "@/lib/materials/types";

type Db = PrismaClient | Prisma.TransactionClient;

export async function ensurePurchaseList(
  db: Db,
  access: BusinessAccess,
  input: { jobId?: string | null; estimateId?: string | null },
) {
  if (input.jobId) {
    await requireMaterialsJobAccess(db as PrismaClient, access);
    const job = access.assertOwned(
      await db.job.findFirst({
        where: { id: input.jobId, businessId: access.businessId },
        select: { id: true, businessId: true, estimateId: true, approvedEstimateVersionId: true },
      }),
    );
    const existing = await db.materialPurchaseList.findFirst({
      where: { businessId: access.businessId, jobId: job.id },
    });
    if (existing) return existing;
    if (job.estimateId) {
      const fromEstimate = await db.materialPurchaseList.findFirst({
        where: { businessId: access.businessId, estimateId: job.estimateId, jobId: null },
      });
      if (fromEstimate) {
        return db.materialPurchaseList.update({
          where: { id: fromEstimate.id },
          data: {
            jobId: job.id,
            estimateVersionId: fromEstimate.estimateVersionId ?? job.approvedEstimateVersionId,
          },
        });
      }
    }
    return db.materialPurchaseList.create({
      data: {
        businessId: access.businessId,
        jobId: job.id,
        estimateId: job.estimateId,
        estimateVersionId: job.approvedEstimateVersionId,
      },
    });
  }

  if (!input.estimateId) {
    throw new MaterialsError("Choose a job or estimate for the purchase list.");
  }
  await requireMaterialsEstimateAccess(db as PrismaClient, access);
  const estimate = access.assertOwned(
    await db.estimate.findFirst({
      where: { id: input.estimateId, businessId: access.businessId },
      select: { id: true, businessId: true, approvedVersionId: true },
    }),
  );
  const existing = await db.materialPurchaseList.findFirst({
    where: { businessId: access.businessId, estimateId: estimate.id },
  });
  if (existing) return existing;
  return db.materialPurchaseList.create({
    data: {
      businessId: access.businessId,
      estimateId: estimate.id,
      estimateVersionId: estimate.approvedVersionId,
    },
  });
}

export async function attachPurchaseListToCreatedJob(
  db: Db,
  access: BusinessAccess,
  input: { jobId: string; estimateId: string; estimateVersionId?: string | null },
) {
  await requireMaterialsJobAccess(db as PrismaClient, access);
  const list = await db.materialPurchaseList.findFirst({
    where: { businessId: access.businessId, estimateId: input.estimateId },
  });
  if (!list || list.jobId) return list;
  return db.materialPurchaseList.update({
    where: { id: list.id },
    data: {
      jobId: input.jobId,
      estimateVersionId: list.estimateVersionId ?? input.estimateVersionId ?? null,
    },
  });
}

export async function loadPurchaseListBoard(
  db: Db,
  access: BusinessAccess,
  input: { jobId?: string | null; estimateId?: string | null },
) {
  if (input.jobId) await requireMaterialsJobAccess(db as PrismaClient, access);
  else await requireMaterialsEstimateAccess(db as PrismaClient, access);
  const list = await db.materialPurchaseList.findFirst({
    where: {
      businessId: access.businessId,
      ...(input.jobId ? { jobId: input.jobId } : {}),
      ...(input.estimateId && !input.jobId ? { estimateId: input.estimateId } : {}),
    },
    include: {
      items: {
        include: {
          supplier: { select: { id: true, name: true, preferred: true, locationDescription: true } },
          material: { select: { id: true, name: true, lastKnownCost: true, unit: true } },
          expense: { select: { id: true, amount: true, voidedAt: true } },
        },
        orderBy: { createdAt: "asc" },
      },
      purchaseOrders: {
        include: {
          supplier: { select: { id: true, name: true } },
          items: true,
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  return list;
}

export type PurchaseListItemInput = {
  purchaseListId: string;
  materialId?: string | null;
  supplierId?: string | null;
  lineItemId?: string | null;
  takeoffItemId?: string | null;
  name: string;
  quantityNeeded: string | number;
  unit: string;
  plannedUnitCost?: string | number | null;
  quantityPurchased?: string | number | null;
  actualUnitCost?: string | number | null;
  markupPercent?: string | number | null;
  customerUnitPrice?: string | number | null;
  estimatedQuantity?: string | number | null;
  estimatedCost?: string | number | null;
  pickupRequired?: boolean;
  pickupLocationDescription?: string | null;
  pickupDurationMinutes?: string | number | null;
  pickupReady?: boolean;
  status?: string;
  notes?: string | null;
};

async function resolveOwnedRefs(
  db: Db,
  access: BusinessAccess,
  input: {
    materialId?: string | null;
    supplierId?: string | null;
    lineItemId?: string | null;
  },
) {
  if (input.materialId) {
    access.assertOwned(
      await db.materialCatalogItem.findFirst({
        where: { id: input.materialId, businessId: access.businessId },
        select: { id: true, businessId: true },
      }),
    );
  }
  if (input.supplierId) {
    access.assertOwned(
      await db.supplier.findFirst({
        where: { id: input.supplierId, businessId: access.businessId },
        select: { id: true, businessId: true },
      }),
    );
  }
  if (input.lineItemId) {
    access.assertOwned(
      await db.lineItem.findFirst({
        where: { id: input.lineItemId, businessId: access.businessId },
        select: { id: true, businessId: true },
      }),
    );
  }
}

function resolveItemFields(input: PurchaseListItemInput) {
  const name = input.name.trim();
  if (!name) throw new MaterialsError("Enter a purchase-list material name.");
  const quantityNeeded = decimalQuantity(input.quantityNeeded);
  if (!quantityNeeded) throw new MaterialsError("Enter a quantity greater than zero.");
  const plannedUnitCost = decimalMoney(input.plannedUnitCost ?? null);
  const quantityPurchased = decimalQuantity(input.quantityPurchased ?? null);
  const actualUnitCost = decimalMoney(input.actualUnitCost ?? null);
  const markup =
    input.markupPercent == null || input.markupPercent === ""
      ? null
      : decimalMoney(input.markupPercent) ??
        (Number(input.markupPercent) === 0 ? new Prisma.Decimal(0) : null);
  const status = input.status ?? "NEEDED";
  if (!isPurchaseItemStatus(status)) {
    throw new MaterialsError("Choose a valid purchase-list status.");
  }
  const pickupDuration =
    input.pickupDurationMinutes == null || input.pickupDurationMinutes === ""
      ? null
      : Number(input.pickupDurationMinutes);
  if (pickupDuration != null && (!Number.isFinite(pickupDuration) || pickupDuration < 0)) {
    throw new MaterialsError("Pickup duration must be a non-negative number of minutes.");
  }
  return {
    name,
    quantityNeeded,
    unit: input.unit.trim() || "ea",
    plannedUnitCost,
    plannedCost: extendedCost(quantityNeeded, plannedUnitCost),
    quantityPurchased,
    actualUnitCost,
    actualCost: extendedCost(quantityPurchased, actualUnitCost),
    markupPercent: markup,
    customerUnitPrice: decimalMoney(input.customerUnitPrice ?? null),
    estimatedQuantity: decimalQuantity(input.estimatedQuantity ?? input.quantityNeeded),
    estimatedCost:
      decimalMoney(input.estimatedCost ?? null) ??
      extendedCost(
        decimalQuantity(input.estimatedQuantity ?? input.quantityNeeded),
        plannedUnitCost,
      ),
    pickupRequired: Boolean(input.pickupRequired),
    pickupLocationDescription: input.pickupLocationDescription?.trim() || null,
    pickupDurationMinutes: pickupDuration,
    pickupReady: Boolean(input.pickupReady),
    status: status as PurchaseItemStatus,
    notes: input.notes?.trim() || null,
    materialId: input.materialId || null,
    supplierId: input.supplierId || null,
    lineItemId: input.lineItemId || null,
    takeoffItemId: input.takeoffItemId || null,
  };
}

export async function addPurchaseListItem(
  db: Db,
  access: BusinessAccess,
  input: PurchaseListItemInput,
) {
  const list = access.assertOwned(
    await db.materialPurchaseList.findFirst({
      where: { id: input.purchaseListId, businessId: access.businessId },
    }),
  );
  await requirePurchaseListWriteAccess(db as PrismaClient, access, list);
  await resolveOwnedRefs(db, access, input);
  const fields = resolveItemFields(input);
  return db.materialPurchaseListItem.create({
    data: {
      businessId: access.businessId,
      purchaseListId: list.id,
      ...fields,
    },
  });
}

export async function updatePurchaseListItem(
  db: Db,
  access: BusinessAccess,
  input: PurchaseListItemInput & { itemId: string },
) {
  const existing = access.assertOwned(
    await db.materialPurchaseListItem.findFirst({
      where: { id: input.itemId, businessId: access.businessId },
      include: { purchaseList: true },
    }),
  );
  await requirePurchaseListWriteAccess(db as PrismaClient, access, existing.purchaseList);
  await resolveOwnedRefs(db, access, input);
  const fields = resolveItemFields({ ...input, purchaseListId: existing.purchaseListId });
  return db.materialPurchaseListItem.update({
    where: { id: existing.id },
    data: fields,
  });
}

export async function recordPurchaseListItemPurchased(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    itemId: string;
    quantityPurchased: string | number;
    actualUnitCost: string | number;
    supplierId?: string | null;
    status?: PurchaseItemStatus;
  },
) {
  const existing = access.assertOwned(
    await db.materialPurchaseListItem.findFirst({
      where: { id: input.itemId, businessId: access.businessId },
      include: { purchaseList: true, material: true },
    }),
  );
  await requirePurchaseListWriteAccess(db, access, existing.purchaseList);
  if (input.supplierId) {
    access.assertOwned(
      await db.supplier.findFirst({
        where: { id: input.supplierId, businessId: access.businessId },
        select: { id: true, businessId: true },
      }),
    );
  }
  const quantityPurchased = decimalQuantity(input.quantityPurchased);
  const actualUnitCost = decimalMoney(input.actualUnitCost);
  if (!quantityPurchased || !actualUnitCost) {
    throw new MaterialsError("Enter the purchased quantity and actual unit cost.");
  }
  const status = input.status ?? "PURCHASED";
  if (!isPurchaseItemStatus(status)) {
    throw new MaterialsError("Choose a valid purchase-list status.");
  }
  const updated = await db.materialPurchaseListItem.update({
    where: { id: existing.id },
    data: {
      quantityPurchased,
      actualUnitCost,
      actualCost: extendedCost(quantityPurchased, actualUnitCost),
      supplierId: input.supplierId || existing.supplierId,
      status,
    },
  });
  if (existing.materialId && actualUnitCost) {
    await db.materialCatalogItem.update({
      where: { id: existing.materialId },
      data: { lastKnownCost: actualUnitCost, lastKnownCostAt: new Date() },
    });
    await appendMaterialPriceHistory(db, access, {
      materialId: existing.materialId,
      supplierId: updated.supplierId,
      unit: existing.unit,
      price: actualUnitCost,
      source: "PURCHASE",
      purchaseListItemId: existing.id,
    });
  }
  return updated;
}

export async function createPurchaseOrder(
  db: Db,
  access: BusinessAccess,
  input: {
    purchaseListId: string;
    supplierId?: string | null;
    itemIds?: string[];
    notes?: string | null;
  },
) {
  const list = access.assertOwned(
    await db.materialPurchaseList.findFirst({
      where: { id: input.purchaseListId, businessId: access.businessId },
    }),
  );
  await requirePurchaseListWriteAccess(db as PrismaClient, access, list);
  if (input.supplierId) {
    access.assertOwned(
      await db.supplier.findFirst({
        where: { id: input.supplierId, businessId: access.businessId },
        select: { id: true, businessId: true },
      }),
    );
  }
  const items = await db.materialPurchaseListItem.findMany({
    where: {
      businessId: access.businessId,
      purchaseListId: list.id,
      ...(input.itemIds?.length ? { id: { in: input.itemIds } } : {}),
      status: { not: "CANCELLED" },
    },
  });
  if (items.length === 0) {
    throw new MaterialsError("Add purchase-list items before creating a purchase order.");
  }
  return db.materialPurchaseOrder.create({
    data: {
      businessId: access.businessId,
      purchaseListId: list.id,
      supplierId: input.supplierId || null,
      jobId: list.jobId,
      status: "DRAFT",
      notes: input.notes?.trim() || null,
      items: {
        create: items.map((item) => ({
          businessId: access.businessId,
          purchaseListItemId: item.id,
          quantity: item.quantityNeeded,
          unitCost: item.plannedUnitCost,
        })),
      },
    },
    include: { items: true },
  });
}

export async function updatePurchaseOrderStatus(
  db: Db,
  access: BusinessAccess,
  input: { purchaseOrderId: string; status: string },
) {
  if (!isPurchaseOrderStatus(input.status)) {
    throw new MaterialsError("Choose a valid purchase-order status.");
  }
  const existing = access.assertOwned(
    await db.materialPurchaseOrder.findFirst({
      where: { id: input.purchaseOrderId, businessId: access.businessId },
      include: { purchaseList: true, items: true },
    }),
  );
  await requirePurchaseListWriteAccess(db as PrismaClient, access, existing.purchaseList);
  const status = input.status as PurchaseOrderStatus;
  if (status === "ORDERED_EXTERNALLY" && existing.status === "DRAFT") {
    // Owner recorded that they placed the order outside TBBT. No fake confirmation.
  }
  const itemStatus: PurchaseItemStatus | null =
    status === "ORDERED_EXTERNALLY"
      ? "ORDERED"
      : status === "RECEIVED"
        ? "RECEIVED"
        : status === "PARTIALLY_RECEIVED"
          ? "ORDERED"
          : status === "CANCELLED"
            ? "CANCELLED"
            : null;
  const updated = await db.materialPurchaseOrder.update({
    where: { id: existing.id },
    data: {
      status,
      orderedAt:
        status === "ORDERED_EXTERNALLY" ? existing.orderedAt ?? new Date() : existing.orderedAt,
      receivedAt: status === "RECEIVED" ? existing.receivedAt ?? new Date() : existing.receivedAt,
    },
  });
  if (itemStatus) {
    await db.materialPurchaseListItem.updateMany({
      where: {
        businessId: access.businessId,
        id: { in: existing.items.map((item) => item.purchaseListItemId) },
      },
      data: { status: itemStatus },
    });
  }
  return updated;
}

export function purchaseItemActualCostNumber(item: {
  actualCost: Prisma.Decimal | null;
  expense: { amount: Prisma.Decimal; voidedAt: Date | null } | null;
}) {
  if (item.expense && !item.expense.voidedAt) {
    return asMoneyNumber(item.expense.amount);
  }
  return asMoneyNumber(item.actualCost);
}

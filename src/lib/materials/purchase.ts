import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  finishMaterialAttempt,
  normalizeMaterialAttemptKey,
  withMaterialAttempt,
} from "@/lib/materials/attempts";
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
  canTransitionPurchaseOrder,
  isPurchaseItemStatus,
  isPurchaseOrderStatus,
  type PurchaseItemStatus,
  type PurchaseOrderStatus,
} from "@/lib/materials/types";
import { isPrismaUniqueViolation } from "@/lib/materials/unique";

type Db = PrismaClient | Prisma.TransactionClient;

async function loadOwnedPurchaseList(db: Db, access: BusinessAccess, where: {
  jobId?: string;
  estimateId?: string;
}) {
  return db.materialPurchaseList.findFirst({
    where: { businessId: access.businessId, ...where },
  });
}

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
    const existing = await loadOwnedPurchaseList(db, access, { jobId: job.id });
    if (existing) return existing;
    if (job.estimateId) {
      const fromEstimate = await loadOwnedPurchaseList(db, access, { estimateId: job.estimateId });
      if (fromEstimate) {
        if (fromEstimate.jobId && fromEstimate.jobId !== job.id) {
          throw new MaterialsError("That estimate already has a purchase list on a different job.");
        }
        if (fromEstimate.jobId === job.id) return fromEstimate;
        try {
          return await db.materialPurchaseList.update({
            where: { id: fromEstimate.id },
            data: {
              jobId: job.id,
              estimateVersionId: fromEstimate.estimateVersionId ?? job.approvedEstimateVersionId,
            },
          });
        } catch (error) {
          if (!isPrismaUniqueViolation(error)) throw error;
          const winner = await loadOwnedPurchaseList(db, access, { jobId: job.id });
          if (winner) return winner;
          throw error;
        }
      }
    }
    try {
      return await db.materialPurchaseList.create({
        data: {
          businessId: access.businessId,
          jobId: job.id,
          estimateId: job.estimateId,
          estimateVersionId: job.approvedEstimateVersionId,
        },
      });
    } catch (error) {
      if (!isPrismaUniqueViolation(error)) throw error;
      const winner =
        (await loadOwnedPurchaseList(db, access, { jobId: job.id })) ??
        (job.estimateId
          ? await loadOwnedPurchaseList(db, access, { estimateId: job.estimateId })
          : null);
      if (winner) return winner;
      throw error;
    }
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
  const existing = await loadOwnedPurchaseList(db, access, { estimateId: estimate.id });
  if (existing) return existing;
  try {
    return await db.materialPurchaseList.create({
      data: {
        businessId: access.businessId,
        estimateId: estimate.id,
        estimateVersionId: estimate.approvedVersionId,
      },
    });
  } catch (error) {
    if (!isPrismaUniqueViolation(error)) throw error;
    const winner = await loadOwnedPurchaseList(db, access, { estimateId: estimate.id });
    if (winner) return winner;
    throw error;
  }
}

export async function attachPurchaseListToCreatedJob(
  db: Db,
  access: BusinessAccess,
  input: { jobId: string; estimateId: string; estimateVersionId?: string | null },
) {
  await requireMaterialsJobAccess(db as PrismaClient, access);
  const job = access.assertOwned(
    await db.job.findFirst({
      where: { id: input.jobId, businessId: access.businessId },
      select: { id: true, businessId: true, estimateId: true },
    }),
  );
  const estimate = access.assertOwned(
    await db.estimate.findFirst({
      where: { id: input.estimateId, businessId: access.businessId },
      select: { id: true, businessId: true },
    }),
  );
  if (job.estimateId !== estimate.id) {
    throw new MaterialsError("That job does not belong to the supplied estimate.");
  }
  if (input.estimateVersionId) {
    access.assertOwned(
      await db.estimateVersion.findFirst({
        where: {
          id: input.estimateVersionId,
          businessId: access.businessId,
          estimateId: estimate.id,
        },
        select: { id: true, businessId: true, estimateId: true },
      }),
    );
  }
  const list = await db.materialPurchaseList.findFirst({
    where: { businessId: access.businessId, estimateId: estimate.id },
  });
  if (!list) return list;
  if (list.businessId !== access.businessId || list.estimateId !== estimate.id) {
    throw new MaterialsError("That purchase list does not belong to the supplied estimate.");
  }
  if (list.jobId && list.jobId !== job.id) {
    throw new MaterialsError("That purchase list is already attached to a different job.");
  }
  if (list.jobId === job.id) return list;
  try {
    return await db.materialPurchaseList.update({
      where: { id: list.id },
      data: {
        jobId: job.id,
        estimateVersionId: list.estimateVersionId ?? input.estimateVersionId ?? null,
      },
    });
  } catch (error) {
    if (!isPrismaUniqueViolation(error)) throw error;
    throw new MaterialsError("That job already has a different purchase list.");
  }
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
  sourceKey?: string | null;
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

function resolveCreateItemFields(input: PurchaseListItemInput) {
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
    sourceKey: input.sourceKey?.trim() || null,
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
  const fields = resolveCreateItemFields(input);
  if (fields.sourceKey) {
    const existing = await db.materialPurchaseListItem.findFirst({
      where: {
        businessId: access.businessId,
        purchaseListId: list.id,
        sourceKey: fields.sourceKey,
      },
    });
    if (existing) return existing;
  }
  try {
    return await db.materialPurchaseListItem.create({
      data: {
        businessId: access.businessId,
        purchaseListId: list.id,
        ...fields,
      },
    });
  } catch (error) {
    if (!isPrismaUniqueViolation(error) || !fields.sourceKey) throw error;
    const winner = await db.materialPurchaseListItem.findFirst({
      where: {
        businessId: access.businessId,
        purchaseListId: list.id,
        sourceKey: fields.sourceKey,
      },
    });
    if (winner) return winner;
    throw error;
  }
}

export type UpdatePurchaseListItemInput = {
  itemId: string;
  purchaseListId?: string;
  materialId?: string | null;
  supplierId?: string | null;
  lineItemId?: string | null;
  name?: string;
  quantityNeeded?: string | number;
  unit?: string;
  plannedUnitCost?: string | number | null;
  markupPercent?: string | number | null;
  customerUnitPrice?: string | number | null;
  pickupRequired?: boolean;
  pickupLocationDescription?: string | null;
  pickupDurationMinutes?: string | number | null;
  pickupReady?: boolean;
  status?: string;
  notes?: string | null;
};

export async function updatePurchaseListItem(
  db: Db,
  access: BusinessAccess,
  input: UpdatePurchaseListItemInput,
) {
  const existing = access.assertOwned(
    await db.materialPurchaseListItem.findFirst({
      where: { id: input.itemId, businessId: access.businessId },
      include: { purchaseList: true },
    }),
  );
  await requirePurchaseListWriteAccess(db as PrismaClient, access, existing.purchaseList);
  await resolveOwnedRefs(db, access, input);
  const data: Prisma.MaterialPurchaseListItemUpdateInput = {};
  if (input.name != null) {
    const name = input.name.trim();
    if (!name) throw new MaterialsError("Enter a purchase-list material name.");
    data.name = name;
  }
  const nextQuantity =
    input.quantityNeeded != null && input.quantityNeeded !== ""
      ? decimalQuantity(input.quantityNeeded)
      : existing.quantityNeeded;
  if (input.quantityNeeded != null && input.quantityNeeded !== "") {
    if (!nextQuantity) {
      throw new MaterialsError("Enter a quantity greater than zero.");
    }
    data.quantityNeeded = nextQuantity;
  }
  if (input.unit != null) {
    data.unit = input.unit.trim() || existing.unit;
  }
  const nextPlanned =
    input.plannedUnitCost !== undefined
      ? decimalMoney(input.plannedUnitCost ?? null)
      : existing.plannedUnitCost;
  if (input.plannedUnitCost !== undefined) {
    data.plannedUnitCost = nextPlanned === null ? { set: null } : nextPlanned;
  }
  if (input.quantityNeeded != null || input.plannedUnitCost !== undefined) {
    const plannedCost = extendedCost(nextQuantity, nextPlanned);
    data.plannedCost = plannedCost === null ? { set: null } : plannedCost;
  }
  if (input.markupPercent !== undefined) {
    const markup =
      input.markupPercent == null || input.markupPercent === ""
        ? null
        : decimalMoney(input.markupPercent) ??
          (Number(input.markupPercent) === 0 ? new Prisma.Decimal(0) : null);
    data.markupPercent = markup === null ? { set: null } : markup;
  }
  if (input.customerUnitPrice !== undefined) {
    const customerUnitPrice = decimalMoney(input.customerUnitPrice ?? null);
    data.customerUnitPrice = customerUnitPrice === null ? { set: null } : customerUnitPrice;
  }
  if (input.pickupRequired !== undefined) data.pickupRequired = Boolean(input.pickupRequired);
  if (input.pickupLocationDescription !== undefined) {
    data.pickupLocationDescription = input.pickupLocationDescription?.trim() || null;
  }
  if (input.pickupDurationMinutes !== undefined) {
    const pickupDuration =
      input.pickupDurationMinutes == null || input.pickupDurationMinutes === ""
        ? null
        : Number(input.pickupDurationMinutes);
    if (pickupDuration != null && (!Number.isFinite(pickupDuration) || pickupDuration < 0)) {
      throw new MaterialsError("Pickup duration must be a non-negative number of minutes.");
    }
    data.pickupDurationMinutes = pickupDuration;
  }
  if (input.pickupReady !== undefined) data.pickupReady = Boolean(input.pickupReady);
  if (input.status != null && input.status !== "") {
    if (!isPurchaseItemStatus(input.status)) {
      throw new MaterialsError("Choose a valid purchase-list status.");
    }
    data.status = input.status;
  }
  if (input.notes !== undefined) data.notes = input.notes?.trim() || null;
  if (input.materialId !== undefined) data.material = input.materialId
    ? { connect: { id: input.materialId } }
    : { disconnect: true };
  if (input.supplierId !== undefined) data.supplier = input.supplierId
    ? { connect: { id: input.supplierId } }
    : { disconnect: true };
  if (input.lineItemId !== undefined) data.lineItem = input.lineItemId
    ? { connect: { id: input.lineItemId } }
    : { disconnect: true };
  return db.materialPurchaseListItem.update({
    where: { id: existing.id },
    data,
  });
}

export async function applyPurchaseActuals(
  db: Db,
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
  await requirePurchaseListWriteAccess(db as PrismaClient, access, existing.purchaseList);
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
  }
  return { existing, updated };
}

export async function recordPurchaseListItemPurchased(
  db: PrismaClient | Prisma.TransactionClient,
  access: BusinessAccess,
  input: {
    itemId: string;
    quantityPurchased: string | number;
    actualUnitCost: string | number;
    supplierId?: string | null;
    status?: PurchaseItemStatus;
    recordHistory?: boolean;
  },
) {
  const { existing, updated } = await applyPurchaseActuals(db, access, input);
  if (input.recordHistory !== false && existing.materialId && updated.actualUnitCost) {
    await appendMaterialPriceHistory(db, access, {
      materialId: existing.materialId,
      supplierId: updated.supplierId,
      unit: existing.unit,
      price: updated.actualUnitCost,
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
    attemptKey?: string | null;
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

  const run = async (tx: Db) => {
    const items = await tx.materialPurchaseListItem.findMany({
      where: {
        businessId: access.businessId,
        purchaseListId: list.id,
        ...(input.itemIds?.length ? { id: { in: input.itemIds } } : {}),
        status: { not: "CANCELLED" },
      },
    });
    if (input.itemIds?.length) {
      const found = new Set(items.map((item) => item.id));
      if (input.itemIds.some((id) => !found.has(id))) {
        throw new MaterialsError(
          "Every purchase-order item must belong to this purchase list and business.",
        );
      }
    }
    const selected = input.supplierId
      ? items.filter((item) => item.supplierId === input.supplierId)
      : items;
    if (input.supplierId && input.itemIds?.length) {
      const mismatched = items.filter((item) => item.supplierId !== input.supplierId);
      if (mismatched.length > 0) {
        throw new MaterialsError(
          "A purchase order for that supplier can only include items assigned to the same supplier.",
        );
      }
    }
    if (selected.length === 0) {
      throw new MaterialsError(
        input.supplierId
          ? "No purchase-list items are assigned to that supplier."
          : "Add purchase-list items before creating a purchase order.",
      );
    }
    for (const item of selected) {
      if (item.businessId !== access.businessId || item.purchaseListId !== list.id) {
        throw new MaterialsError(
          "Every purchase-order item must belong to this purchase list and business.",
        );
      }
      if (input.supplierId && item.supplierId !== input.supplierId) {
        throw new MaterialsError(
          "A purchase order for that supplier can only include items assigned to the same supplier.",
        );
      }
    }
    return tx.materialPurchaseOrder.create({
      data: {
        businessId: access.businessId,
        purchaseListId: list.id,
        supplierId: input.supplierId || null,
        jobId: list.jobId,
        status: "DRAFT",
        notes: input.notes?.trim() || null,
        items: {
          create: selected.map((item) => ({
            businessId: access.businessId,
            purchaseListItemId: item.id,
            quantity: item.quantityNeeded,
            unitCost: item.plannedUnitCost,
          })),
        },
      },
      include: { items: true },
    });
  };

  if (!input.attemptKey) {
    return run(db);
  }
  const attemptKey = normalizeMaterialAttemptKey(input.attemptKey);
  const outcome = await withMaterialAttempt(db as PrismaClient, access, {
    attemptKey,
    kind: "CREATE_DRAFT_PO",
  }, async (tx) => {
    const created = await run(tx);
    await finishMaterialAttempt(tx, access, {
      attemptKey,
      purchaseListId: list.id,
      purchaseOrderId: created.id,
    });
    return created;
  });
  if (outcome.status === "replay") {
    if (!outcome.attempt.purchaseOrderId) {
      throw new MaterialsError("That purchase order is already being created. Retry.");
    }
    const replayed = await db.materialPurchaseOrder.findFirst({
      where: { id: outcome.attempt.purchaseOrderId, businessId: access.businessId },
      include: { items: true },
    });
    if (replayed) return replayed;
    throw new MaterialsError("That purchase order is already being created. Retry.");
  }
  return outcome.result;
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
  const current = isPurchaseOrderStatus(existing.status) ? existing.status : "DRAFT";
  const status = input.status as PurchaseOrderStatus;
  if (!canTransitionPurchaseOrder(current, status)) {
    throw new MaterialsError(
      `That purchase order cannot move from ${current} to ${status}.`,
    );
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
        status === "ORDERED_EXTERNALLY" ||
        status === "PARTIALLY_RECEIVED" ||
        status === "RECEIVED"
          ? existing.orderedAt ?? new Date()
          : existing.orderedAt,
      receivedAt: status === "RECEIVED" ? existing.receivedAt ?? new Date() : existing.receivedAt,
    },
  });
  if (itemStatus) {
    await db.materialPurchaseListItem.updateMany({
      where: {
        businessId: access.businessId,
        purchaseListId: existing.purchaseListId,
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

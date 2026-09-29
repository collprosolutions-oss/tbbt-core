/**
 * OWNER-recorded receipts against an existing MaterialPurchaseOrder.
 *
 * This is operational receiving only:
 *   - increments MaterialPurchaseOrderItem.quantityReceived
 *   - shows ordered-versus-received remaining
 *   - handles partial deliveries and duplicate/concurrent retries
 *
 * It never creates a Payment, Expense, Invoice, or supplier order.
 * It does not write quantityPurchased, actualCost, price history, or
 * worker quantityPickedUp on MaterialPurchaseListItem.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  requireOwnerPurchaseReceipt,
  requirePurchaseListWriteAccess,
} from "@/lib/materials/access";
import {
  finishMaterialAttempt,
  normalizeMaterialAttemptKey,
  withMaterialAttempt,
} from "@/lib/materials/attempts";
import { MaterialsError } from "@/lib/materials/errors";
import { decimalQuantity } from "@/lib/materials/money";
import {
  canRecordPurchaseOrderReceipt,
  purchaseOrderReceiptQuantities,
  purchaseOrderStatusFromReceipts,
  type PurchaseItemStatus,
  type PurchaseOrderStatus,
} from "@/lib/materials/types";

type Db = PrismaClient | Prisma.TransactionClient;

type LockedPurchaseOrderRow = {
  id: string;
  businessId: string;
  purchaseListId: string;
  status: string;
  orderedAt: Date | null;
  receivedAt: Date | null;
};

const RECEIPT_PO_INCLUDE = {
  items: {
    include: {
      purchaseListItem: { select: { id: true, name: true, unit: true, status: true } },
    },
    orderBy: { createdAt: "asc" as const },
  },
  supplier: { select: { id: true, name: true } },
} satisfies Prisma.MaterialPurchaseOrderInclude;

export type PurchaseOrderReceiptInput = {
  purchaseOrderId: string;
  attemptKey: string;
  items: Array<{
    purchaseOrderItemId: string;
    quantityReceived: string | number;
  }>;
};

export async function lockTenantOwnedPurchaseOrder(
  db: Db,
  businessId: string,
  purchaseOrderId: string,
): Promise<LockedPurchaseOrderRow | null> {
  const rows = await db.$queryRaw<LockedPurchaseOrderRow[]>`
    SELECT id, "businessId", "purchaseListId", status, "orderedAt", "receivedAt"
    FROM "MaterialPurchaseOrder"
    WHERE id = ${purchaseOrderId}
      AND "businessId" = ${businessId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function loadOwnedReceiptOrder(db: Db, access: BusinessAccess, purchaseOrderId: string) {
  return access.assertOwned(
    await db.materialPurchaseOrder.findFirst({
      where: { id: purchaseOrderId, businessId: access.businessId },
      include: RECEIPT_PO_INCLUDE,
    }),
  );
}

function parseReceiptIncrements(input: PurchaseOrderReceiptInput["items"]) {
  const increments = new Map<string, Prisma.Decimal>();
  for (const row of input) {
    const id = row.purchaseOrderItemId?.trim();
    if (!id) {
      throw new MaterialsError("Every received quantity must belong to a purchase-order item.");
    }
    const quantity = decimalQuantity(row.quantityReceived);
    if (!quantity) {
      throw new MaterialsError("Enter a received quantity greater than zero.");
    }
    const previous = increments.get(id);
    increments.set(id, previous ? previous.plus(quantity) : quantity);
  }
  if (increments.size === 0) {
    throw new MaterialsError("Enter at least one received quantity.");
  }
  return increments;
}

export async function recordPurchaseOrderReceipt(
  db: PrismaClient,
  access: BusinessAccess,
  input: PurchaseOrderReceiptInput,
) {
  requireOwnerPurchaseReceipt(access);
  const attemptKey = normalizeMaterialAttemptKey(input.attemptKey);
  const increments = parseReceiptIncrements(input.items);

  const replay = async (attempt: { purchaseOrderId: string | null }) => {
    if (!attempt.purchaseOrderId) {
      throw new MaterialsError("That receipt is already being recorded. Retry.");
    }
    return loadOwnedReceiptOrder(db, access, attempt.purchaseOrderId);
  };

  const outcome = await withMaterialAttempt(
    db,
    access,
    { attemptKey, kind: "RECORD_PO_RECEIPT" },
    async (tx) => {
      const locked = await lockTenantOwnedPurchaseOrder(tx, access.businessId, input.purchaseOrderId);
      if (!locked || locked.businessId !== access.businessId) {
        throw new MaterialsError("That purchase order was not found in this business.");
      }
      await tx.$queryRaw`
        SELECT id
        FROM "MaterialPurchaseOrderItem"
        WHERE "purchaseOrderId" = ${locked.id}
          AND "businessId" = ${access.businessId}
        FOR UPDATE
      `;
      const existing = await tx.materialPurchaseOrder.findFirst({
        where: { id: locked.id, businessId: access.businessId },
        include: {
          purchaseList: true,
          items: true,
        },
      });
      if (!existing) {
        throw new MaterialsError("That purchase order was not found in this business.");
      }
      access.assertOwned(existing);
      await requirePurchaseListWriteAccess(tx, access, existing.purchaseList);
      if (!canRecordPurchaseOrderReceipt(existing.status)) {
        throw new MaterialsError(
          existing.status === "DRAFT" || existing.status === "READY"
            ? "Mark this purchase order as ordered externally before recording a receipt."
            : existing.status === "RECEIVED"
              ? "This purchase order is already fully received."
              : "This purchase order cannot accept a receipt.",
        );
      }

      const itemsById = new Map(existing.items.map((item) => [item.id, item]));
      const now = new Date();
      const nextReceived = new Map<string, Prisma.Decimal>();

      for (const [itemId, increment] of increments) {
        const item = itemsById.get(itemId);
        if (!item || item.businessId !== access.businessId || item.purchaseOrderId !== existing.id) {
          throw new MaterialsError(
            "Every received quantity must belong to this purchase order and business.",
          );
        }
        const already = item.quantityReceived ?? new Prisma.Decimal(0);
        const remaining = item.quantity.minus(already);
        if (increment.gt(remaining)) {
          throw new MaterialsError(
            "Received quantity cannot exceed the remaining ordered quantity.",
          );
        }
        nextReceived.set(itemId, already.plus(increment));
      }

      for (const [itemId, quantityReceived] of nextReceived) {
        await tx.materialPurchaseOrderItem.update({
          where: { id: itemId },
          data: { quantityReceived, lastReceivedAt: now },
        });
      }

      const receiptLines = existing.items.map((item) =>
        purchaseOrderReceiptQuantities({
          quantityOrdered: item.quantity.toString(),
          quantityReceived: (nextReceived.get(item.id) ?? item.quantityReceived ?? 0).toString(),
        }),
      );
      const status = purchaseOrderStatusFromReceipts(receiptLines) as PurchaseOrderStatus;
      const updated = await tx.materialPurchaseOrder.update({
        where: { id: existing.id },
        data: {
          status,
          orderedAt: existing.orderedAt ?? now,
          receivedAt: status === "RECEIVED" ? existing.receivedAt ?? now : existing.receivedAt,
        },
        include: RECEIPT_PO_INCLUDE,
      });

      for (const item of updated.items) {
        const currentStatus = item.purchaseListItem.status;
        if (currentStatus === "CANCELLED") continue;
        const line = purchaseOrderReceiptQuantities({
          quantityOrdered: item.quantity.toString(),
          quantityReceived: item.quantityReceived.toString(),
        });
        let nextStatus: PurchaseItemStatus | null = null;
        if (line.fullyReceived) {
          nextStatus = "RECEIVED";
        } else if (
          line.quantityReceived > 0 &&
          (currentStatus === "NEEDED" || currentStatus === "PLANNED" || currentStatus === "ORDERED")
        ) {
          nextStatus = "ORDERED";
        }
        if (!nextStatus || currentStatus === nextStatus) continue;
        await tx.materialPurchaseListItem.update({
          where: { id: item.purchaseListItemId },
          data: { status: nextStatus },
        });
      }

      await finishMaterialAttempt(tx, access, {
        attemptKey,
        purchaseListId: existing.purchaseListId,
        purchaseOrderId: existing.id,
      });
      return updated;
    },
  );

  if (outcome.status === "replay") {
    return replay(outcome.attempt);
  }
  return outcome.result;
}

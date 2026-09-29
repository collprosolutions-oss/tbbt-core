/**
 * OWNER-recorded receipts against an existing MaterialPurchaseOrder.
 *
 * This is operational receiving only:
 *   - increments MaterialPurchaseOrderItem.quantityReceived (running total)
 *   - appends one MaterialPurchaseOrderReceipt per delivery
 *   - shows ordered-versus-received remaining
 *   - handles partial deliveries and duplicate/concurrent retries
 *
 * It never creates a Payment, Expense, Invoice, or supplier order.
 * It does not write quantityPurchased, actualCost, price history, or
 * worker pickup quantities on MaterialPurchaseListItem.
 * OWNER reversal of a recorded delivery is a follow-up.
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
  lockPurchaseListItemsForUpdate,
  lockTenantOwnedPurchaseOrder,
  lockTenantOwnedPurchaseOrderItems,
} from "@/lib/materials/po-lock";
import {
  purchaseOrderReceiptQuantities,
  purchaseOrderStatusFromReceipts,
} from "@/lib/materials/receipt-quantities";
import {
  canRecordPurchaseOrderReceipt,
  parseReceiptDeliveryQuantity,
  purchaseOrderReceiptFingerprint,
  type PurchaseItemStatus,
} from "@/lib/materials/types";

type Db = PrismaClient | Prisma.TransactionClient;

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

export type PurchaseOrderReceiptResult = {
  replayed: boolean;
  order: Prisma.MaterialPurchaseOrderGetPayload<{ include: typeof RECEIPT_PO_INCLUDE }>;
};

const RECEIPT_MISMATCH_ERROR =
  "That retry token was already used for a different receipt.";

function assertMatchingReceiptAttempt(
  attempt: {
    purchaseOrderId: string | null;
    payloadFingerprint: string | null;
  },
  input: { purchaseOrderId: string; payloadFingerprint: string },
) {
  if (attempt.purchaseOrderId && attempt.purchaseOrderId !== input.purchaseOrderId) {
    throw new MaterialsError(RECEIPT_MISMATCH_ERROR);
  }
  if (attempt.payloadFingerprint && attempt.payloadFingerprint !== input.payloadFingerprint) {
    throw new MaterialsError(RECEIPT_MISMATCH_ERROR);
  }
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
    const parsed = parseReceiptDeliveryQuantity(row.quantityReceived);
    if (parsed.status === "skip") continue;
    if (parsed.status === "invalid") {
      throw new MaterialsError("Enter a received quantity as a plain decimal.");
    }
    const quantity = decimalQuantity(parsed.normalized);
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
): Promise<PurchaseOrderReceiptResult> {
  requireOwnerPurchaseReceipt(access);
  const attemptKey = normalizeMaterialAttemptKey(input.attemptKey);
  const increments = parseReceiptIncrements(input.items);
  const payloadFingerprint = purchaseOrderReceiptFingerprint(
    input.purchaseOrderId,
    [...increments.entries()].map(([purchaseOrderItemId, quantity]) => ({
      purchaseOrderItemId,
      quantity: quantity.toFixed(4),
    })),
  );

  const replay = async (attempt: {
    purchaseOrderId: string | null;
    payloadFingerprint: string | null;
  }) => {
    assertMatchingReceiptAttempt(attempt, {
      purchaseOrderId: input.purchaseOrderId,
      payloadFingerprint,
    });
    if (!attempt.purchaseOrderId) {
      throw new MaterialsError("That receipt is already being recorded. Retry.");
    }
    return {
      replayed: true as const,
      order: await loadOwnedReceiptOrder(db, access, attempt.purchaseOrderId),
    };
  };

  const outcome = await withMaterialAttempt(
    db,
    access,
    { attemptKey, kind: "RECORD_PO_RECEIPT", payloadFingerprint },
    async (tx) => {
      const locked = await lockTenantOwnedPurchaseOrder(tx, access.businessId, input.purchaseOrderId);
      if (!locked || locked.businessId !== access.businessId) {
        throw new MaterialsError("That purchase order was not found in this business.");
      }
      await lockTenantOwnedPurchaseOrderItems(tx, access.businessId, locked.id);
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

      const submittedListItemIds = [
        ...new Set(
          [...increments.keys()].map((itemId) => itemsById.get(itemId)?.purchaseListItemId).filter(
            (id): id is string => Boolean(id),
          ),
        ),
      ].sort((left, right) => left.localeCompare(right));
      await lockPurchaseListItemsForUpdate(tx, access.businessId, submittedListItemIds);

      for (const [itemId, quantityReceived] of nextReceived) {
        await tx.materialPurchaseOrderItem.update({
          where: { id: itemId },
          data: { quantityReceived, lastReceivedAt: now },
        });
      }

      await tx.materialPurchaseOrderReceipt.create({
        data: {
          businessId: access.businessId,
          purchaseOrderId: existing.id,
          attemptKey,
          recordedByMembershipId: access.workspace.membership?.id ?? null,
          items: {
            create: [...increments.entries()].map(([purchaseOrderItemId, quantity]) => ({
              businessId: access.businessId,
              purchaseOrderItemId,
              quantity,
            })),
          },
        },
      });

      const receiptLines = existing.items.map((item) =>
        purchaseOrderReceiptQuantities({
          quantityOrdered: item.quantity,
          quantityReceived: nextReceived.get(item.id) ?? item.quantityReceived ?? 0,
        }),
      );
      const status = purchaseOrderStatusFromReceipts(receiptLines);
      const updated = await tx.materialPurchaseOrder.update({
        where: { id: existing.id },
        data: {
          status,
          orderedAt: existing.orderedAt ?? now,
          receivedAt: status === "RECEIVED" ? existing.receivedAt ?? now : existing.receivedAt,
        },
        include: RECEIPT_PO_INCLUDE,
      });

      const siblingLines = submittedListItemIds.length
        ? await tx.materialPurchaseOrderItem.findMany({
            where: {
              businessId: access.businessId,
              purchaseListItemId: { in: submittedListItemIds },
              purchaseOrder: { status: { not: "CANCELLED" } },
            },
            select: {
              id: true,
              purchaseListItemId: true,
              quantity: true,
              quantityReceived: true,
            },
          })
        : [];

      for (const item of updated.items) {
        if (!increments.has(item.id)) continue;
        const currentStatus = item.purchaseListItem.status;
        const related = siblingLines.filter(
          (line) => line.purchaseListItemId === item.purchaseListItemId,
        );
        const listItemFullyReceived =
          related.length > 0 &&
          related.every((line) => {
            const received = nextReceived.get(line.id) ?? line.quantityReceived;
            return received.gte(line.quantity);
          });
        const thisLine = purchaseOrderReceiptQuantities({
          quantityOrdered: item.quantity,
          quantityReceived: item.quantityReceived,
        });
        let nextStatus: PurchaseItemStatus | null = null;
        if (listItemFullyReceived) {
          nextStatus = "RECEIVED";
        } else if (
          thisLine.quantityReceived.gt(0) &&
          currentStatus !== "PURCHASED" &&
          currentStatus !== "RECEIVED"
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
        payloadFingerprint,
      });
      return updated;
    },
  );

  if (outcome.status === "replay") {
    return replay(outcome.attempt);
  }
  return { replayed: false, order: outcome.result };
}

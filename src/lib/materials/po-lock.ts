import { Prisma, type PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

export type LockedPurchaseOrderRow = {
  id: string;
  businessId: string;
  purchaseListId: string;
  status: string;
  orderedAt: Date | null;
  receivedAt: Date | null;
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

export async function lockTenantOwnedPurchaseOrderItems(
  db: Db,
  businessId: string,
  purchaseOrderId: string,
) {
  await db.$queryRaw`
    SELECT id
    FROM "MaterialPurchaseOrderItem"
    WHERE "purchaseOrderId" = ${purchaseOrderId}
      AND "businessId" = ${businessId}
    ORDER BY id
    FOR UPDATE
  `;
}

export async function lockPurchaseListItemsForUpdate(
  db: Db,
  businessId: string,
  listItemIds: readonly string[],
) {
  const ids = [...new Set(listItemIds.filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
  if (ids.length === 0) return;
  await db.$queryRaw`
    SELECT id
    FROM "MaterialPurchaseListItem"
    WHERE "businessId" = ${businessId}
      AND id IN (${Prisma.join(ids)})
    ORDER BY id
    FOR UPDATE
  `;
}

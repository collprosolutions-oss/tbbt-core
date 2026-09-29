import type { Prisma, PrismaClient } from "@prisma/client";

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

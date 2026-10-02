import { Prisma, type PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

export type LockedPurchaseListItemRow = {
  id: string;
  businessId: string;
  purchaseListId: string;
  materialId: string | null;
  supplierId: string | null;
  selectedQuoteId: string | null;
  quantityNeeded: Prisma.Decimal;
  unit: string;
  status: string;
  plannedUnitCost: Prisma.Decimal | null;
  plannedCost: Prisma.Decimal | null;
};

export async function lockTenantOwnedPurchaseListItem(
  db: Db,
  businessId: string,
  itemId: string,
): Promise<LockedPurchaseListItemRow | null> {
  const rows = await db.$queryRaw<LockedPurchaseListItemRow[]>`
    SELECT
      id,
      "businessId",
      "purchaseListId",
      "materialId",
      "supplierId",
      "selectedQuoteId",
      "quantityNeeded",
      unit,
      status,
      "plannedUnitCost",
      "plannedCost"
    FROM "MaterialPurchaseListItem"
    WHERE id = ${itemId}
      AND "businessId" = ${businessId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

export async function lockTenantOwnedSupplierQuotes(
  db: Db,
  businessId: string,
  quoteIds: readonly string[],
) {
  const ids = [...new Set(quoteIds.filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
  if (ids.length === 0) return;
  await db.$queryRaw`
    SELECT id
    FROM "MaterialSupplierQuote"
    WHERE "businessId" = ${businessId}
      AND id IN (${Prisma.join(ids)})
    ORDER BY id
    FOR UPDATE
  `;
}

/**
 * Append-only material price history. Never update or delete a row
 * when lastKnownCost changes.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  isMaterialPriceSource,
  type MaterialPriceSource,
} from "@/lib/materials/types";
import { MaterialsError } from "@/lib/materials/errors";
import { decimalMoney, parseNonNegativeDecimal } from "@/lib/materials/money";

type Db = PrismaClient | Prisma.TransactionClient;

export async function appendMaterialPriceHistory(
  db: Db,
  access: BusinessAccess,
  input: {
    materialId: string;
    supplierId?: string | null;
    unit: string;
    packSize?: Prisma.Decimal | number | string | null;
    price: Prisma.Decimal | number | string;
    observedAt?: Date;
    source: MaterialPriceSource;
    purchaseListItemId?: string | null;
    expenseId?: string | null;
    notes?: string | null;
  },
) {
  if (!isMaterialPriceSource(input.source)) {
    throw new MaterialsError("Choose a valid price-history source.");
  }
  const price = decimalMoney(input.price);
  if (!price) {
    throw new MaterialsError("Enter a material price greater than zero.");
  }
  const material = access.assertOwned(
    await db.materialCatalogItem.findFirst({
      where: { id: input.materialId, businessId: access.businessId },
      select: { id: true, businessId: true, unit: true },
    }),
  );
  if (input.supplierId) {
    access.assertOwned(
      await db.supplier.findFirst({
        where: { id: input.supplierId, businessId: access.businessId },
        select: { id: true, businessId: true },
      }),
    );
  }
  if (input.purchaseListItemId) {
    const item = access.assertOwned(
      await db.materialPurchaseListItem.findFirst({
        where: { id: input.purchaseListItemId, businessId: access.businessId },
        select: {
          id: true,
          businessId: true,
          materialId: true,
          expenseId: true,
        },
      }),
    );
    if (item.materialId && item.materialId !== material.id) {
      throw new MaterialsError(
        "That purchase-list item is not consistent with the material being recorded.",
      );
    }
    if (input.expenseId && item.expenseId && item.expenseId !== input.expenseId) {
      throw new MaterialsError(
        "That purchase-list item is not consistent with the expense being recorded.",
      );
    }
  }
  if (input.expenseId) {
    access.assertOwned(
      await db.expense.findFirst({
        where: { id: input.expenseId, businessId: access.businessId },
        select: { id: true, businessId: true },
      }),
    );
  }
  const packSize = parseNonNegativeDecimal(input.packSize ?? null);
  return db.materialPriceHistory.create({
    data: {
      businessId: access.businessId,
      materialId: material.id,
      supplierId: input.supplierId || null,
      unit: input.unit.trim() || material.unit,
      packSize,
      price,
      observedAt: input.observedAt ?? new Date(),
      source: input.source,
      purchaseListItemId: input.purchaseListItemId || null,
      expenseId: input.expenseId || null,
      notes: input.notes?.trim() || null,
    },
  });
}

export async function listMaterialPriceHistory(
  db: Db,
  access: BusinessAccess,
  materialId: string,
) {
  access.assertOwned(
    await db.materialCatalogItem.findFirst({
      where: { id: materialId, businessId: access.businessId },
      select: { id: true, businessId: true },
    }),
  );
  return db.materialPriceHistory.findMany({
    where: { businessId: access.businessId, materialId },
    include: { supplier: { select: { id: true, name: true } } },
    orderBy: { observedAt: "desc" },
  });
}

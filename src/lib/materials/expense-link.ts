/**
 * Explicit purchase-list ↔ Expense linkage for Financial #102.
 *
 * Purchased/received actual cost may create or attach one Expense.
 * Variance can still show operational actualCost, but a linked
 * non-voided Expense is the only counted financial cost.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { createExpense } from "@/lib/expense-ops";
import { requireMaterialsExpenseAccess } from "@/lib/materials/access";
import {
  finishMaterialAttempt,
  normalizeMaterialAttemptKey,
  withMaterialAttempt,
} from "@/lib/materials/attempts";
import { MaterialsError } from "@/lib/materials/errors";
import { asMoneyNumber, decimalMoney, decimalQuantity, extendedCost } from "@/lib/materials/money";
import { appendMaterialPriceHistory } from "@/lib/materials/price-history";
import { applyPurchaseActuals } from "@/lib/materials/purchase";
import type { MaterialActualCostLink } from "@/lib/materials/types";

type Db = PrismaClient | Prisma.TransactionClient;

export async function linkPurchaseItemToExpense(
  db: Db,
  access: BusinessAccess,
  input: {
    itemId: string;
    expenseId?: string | null;
    createExpense?: boolean;
    occurredOn?: string;
    quantityPurchased?: string | number | null;
    actualUnitCost?: string | number | null;
  },
) {
  await requireMaterialsExpenseAccess(db, access);
  const item = access.assertOwned(
    await db.materialPurchaseListItem.findFirst({
      where: { id: input.itemId, businessId: access.businessId },
      include: {
        purchaseList: true,
        supplier: { select: { name: true } },
        expense: { select: { id: true, amount: true, voidedAt: true, businessId: true } },
      },
    }),
  );
  if (item.expenseId && item.expense && !item.expense.voidedAt) {
    throw new MaterialsError("This purchase already has a linked expense. Linking another would double-count cost.");
  }

  const quantityPurchased =
    decimalQuantity(input.quantityPurchased ?? item.quantityPurchased) ?? item.quantityNeeded;
  const actualUnitCost =
    decimalMoney(input.actualUnitCost ?? item.actualUnitCost ?? item.plannedUnitCost);
  const actualCost = extendedCost(quantityPurchased, actualUnitCost);
  if (!actualCost) {
    throw new MaterialsError("Enter the purchased quantity and actual cost before linking an expense.");
  }

  let expenseId = input.expenseId || null;
  if (input.createExpense) {
    if (!input.occurredOn) {
      throw new MaterialsError("Enter the date this material was purchased.");
    }
    const expense = await createExpense(db, access, {
      occurredOn: input.occurredOn,
      description: item.name,
      amount: actualCost.toString(),
      category: "MATERIALS",
      vendor: item.supplier?.name ?? undefined,
      jobId: item.purchaseList.jobId ?? undefined,
    });
    expenseId = expense.id;
  } else if (expenseId) {
    const expense = access.assertOwned(
      await db.expense.findFirst({
        where: { id: expenseId, businessId: access.businessId },
      }),
    );
    if (expense.voidedAt) {
      throw new MaterialsError("A voided expense cannot be the actual material cost.");
    }
    const already = await db.materialPurchaseListItem.findFirst({
      where: { expenseId: expense.id, businessId: access.businessId, NOT: { id: item.id } },
      select: { id: true },
    });
    if (already) {
      throw new MaterialsError("That expense is already linked to another purchase-list item.");
    }
  } else {
    throw new MaterialsError("Choose an existing expense or record a new one.");
  }

  const updated = await db.materialPurchaseListItem.update({
    where: { id: item.id },
    data: {
      quantityPurchased,
      actualUnitCost,
      actualCost,
      expenseId,
      status: item.status === "NEEDED" || item.status === "PLANNED" ? "PURCHASED" : item.status,
    },
  });

  if (item.materialId && actualUnitCost) {
    await db.materialCatalogItem.update({
      where: { id: item.materialId },
      data: { lastKnownCost: actualUnitCost, lastKnownCostAt: new Date() },
    });
    await appendMaterialPriceHistory(db, access, {
      materialId: item.materialId,
      supplierId: item.supplierId,
      unit: item.unit,
      price: actualUnitCost,
      source: "EXPENSE",
      purchaseListItemId: item.id,
      expenseId,
    });
  }

  return updated;
}

export async function recordPurchaseOperation(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    attemptKey: string;
    itemId: string;
    quantityPurchased: string | number;
    actualUnitCost: string | number;
    supplierId?: string | null;
    createExpense?: boolean;
    occurredOn?: string;
  },
) {
  const attemptKey = normalizeMaterialAttemptKey(input.attemptKey);
  if (input.createExpense) {
    await requireMaterialsExpenseAccess(db, access);
  }

  const replay = async (attempt: { purchaseListItemId: string | null }) => {
    if (!attempt.purchaseListItemId) {
      throw new MaterialsError("That purchase is already being recorded. Retry.");
    }
    return access.assertOwned(
      await db.materialPurchaseListItem.findFirst({
        where: { id: attempt.purchaseListItemId, businessId: access.businessId },
        include: { expense: true },
      }),
    );
  };

  const outcome = await withMaterialAttempt(db, access, {
    attemptKey,
    kind: "RECORD_PURCHASE",
  }, async (tx) => {
    const { existing, updated } = await applyPurchaseActuals(tx, access, {
      itemId: input.itemId,
      quantityPurchased: input.quantityPurchased,
      actualUnitCost: input.actualUnitCost,
      supplierId: input.supplierId,
    });

    let expenseId = existing.expenseId;
    if (input.createExpense) {
      const linked = await linkPurchaseItemToExpense(tx, access, {
        itemId: existing.id,
        createExpense: true,
        occurredOn: input.occurredOn,
        quantityPurchased: input.quantityPurchased,
        actualUnitCost: input.actualUnitCost,
      });
      expenseId = linked.expenseId;
      await finishMaterialAttempt(tx, access, {
        attemptKey,
        purchaseListId: existing.purchaseListId,
        purchaseListItemId: existing.id,
        expenseId,
      });
      return linked;
    }

    if (existing.materialId && updated.actualUnitCost) {
      await appendMaterialPriceHistory(tx, access, {
        materialId: existing.materialId,
        supplierId: updated.supplierId,
        unit: existing.unit,
        price: updated.actualUnitCost,
        source: "PURCHASE",
        purchaseListItemId: existing.id,
      });
    }
    await finishMaterialAttempt(tx, access, {
      attemptKey,
      purchaseListId: existing.purchaseListId,
      purchaseListItemId: existing.id,
      expenseId,
    });
    return updated;
  });
  if (outcome.status === "replay") {
    return replay(outcome.attempt);
  }
  return outcome.result;
}

export async function listMaterialActualCostLinks(
  db: PrismaClient,
  access: BusinessAccess,
  input?: { jobId?: string | null },
): Promise<MaterialActualCostLink[]> {
  await requireMaterialsExpenseAccess(db, access);
  const rows = await db.materialPurchaseListItem.findMany({
    where: {
      businessId: access.businessId,
      expenseId: { not: null },
      ...(input?.jobId ? { purchaseList: { jobId: input.jobId } } : {}),
    },
    include: {
      expense: { select: { id: true, amount: true, voidedAt: true } },
      purchaseList: { select: { jobId: true } },
    },
  });
  return rows.flatMap((row) => {
    if (!row.expense || row.expense.voidedAt || !row.expenseId) return [];
    return [
      {
        purchaseListItemId: row.id,
        expenseId: row.expenseId,
        jobId: row.purchaseList.jobId,
        amount: asMoneyNumber(row.expense.amount) ?? 0,
        countedAsExpense: true as const,
        doNotDoubleCount: true as const,
      },
    ];
  });
}

export function financialMaterialCost(item: {
  actualCost: { toString(): string } | null;
  expense: { amount: { toString(): string }; voidedAt: Date | null } | null;
}) {
  if (item.expense && !item.expense.voidedAt) {
    return { amount: asMoneyNumber(item.expense.amount), source: "EXPENSE" as const };
  }
  return { amount: null, source: "UNLINKED_OPERATIONAL" as const };
}

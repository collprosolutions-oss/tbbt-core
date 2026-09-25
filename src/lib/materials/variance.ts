import type { PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { requirePurchaseListWriteAccess } from "@/lib/materials/access";
import { asMoneyNumber } from "@/lib/materials/money";
import { purchaseItemActualCostNumber } from "@/lib/materials/purchase";
import type { MaterialVarianceRow } from "@/lib/materials/types";

export async function materialEstimateVsActual(
  db: PrismaClient,
  access: BusinessAccess,
  input: { jobId?: string | null; estimateId?: string | null },
): Promise<MaterialVarianceRow[]> {
  const list = await db.materialPurchaseList.findFirst({
    where: {
      businessId: access.businessId,
      ...(input.jobId ? { jobId: input.jobId } : {}),
      ...(input.estimateId && !input.jobId ? { estimateId: input.estimateId } : {}),
    },
    include: {
      items: {
        include: { expense: { select: { amount: true, voidedAt: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!list) return [];
  await requirePurchaseListWriteAccess(db, access, list);
  return list.items.map((item) => {
    const estimatedQuantity = asMoneyNumber(item.estimatedQuantity ?? item.quantityNeeded);
    const estimatedCost = asMoneyNumber(item.estimatedCost ?? item.plannedCost);
    const purchasedQuantity = asMoneyNumber(item.quantityPurchased);
    const purchasedCost = purchaseItemActualCostNumber(item);
    return {
      purchaseListItemId: item.id,
      name: item.name,
      estimatedQuantity,
      estimatedCost,
      purchasedQuantity,
      purchasedCost,
      quantityDelta:
        estimatedQuantity != null && purchasedQuantity != null
          ? purchasedQuantity - estimatedQuantity
          : null,
      costDelta:
        estimatedCost != null && purchasedCost != null ? purchasedCost - estimatedCost : null,
      customerUnitPrice: asMoneyNumber(item.customerUnitPrice),
      markupPercent: asMoneyNumber(item.markupPercent),
    };
  });
}

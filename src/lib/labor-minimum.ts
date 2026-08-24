import { Prisma } from "@prisma/client";

const ZERO = new Prisma.Decimal(0);

export function laborMinimumAdjustment(input: {
  laborSubtotal: Prisma.Decimal;
  laborLineCount: number;
  enabled: boolean;
  amount: Prisma.Decimal | null;
  waived: boolean;
}) {
  if (
    input.waived ||
    !input.enabled ||
    input.amount == null ||
    input.amount.lte(0) ||
    input.laborLineCount === 0
  ) {
    return ZERO;
  }

  if (input.laborSubtotal.gte(input.amount)) {
    return ZERO;
  }

  return input.amount.sub(input.laborSubtotal);
}

function sumByType(
  items: Array<{ type: string; total: Prisma.Decimal }>,
  type: string,
) {
  return items
    .filter((item) => item.type === type)
    .reduce((sum, item) => sum.add(item.total), ZERO);
}

export async function persistDraftEstimateTotal(
  tx: Prisma.TransactionClient,
  estimateId: string,
  businessId: string,
) {
  const estimate = await tx.estimate.findFirst({
    where: { id: estimateId, businessId },
    select: {
      id: true,
      status: true,
      laborMinimumWaived: true,
    },
  });

  if (!estimate || estimate.status !== "DRAFT") {
    return;
  }

  const items = await tx.lineItem.findMany({
    where: { estimateId, businessId },
    select: { total: true, type: true },
  });
  const laborSubtotal = sumByType(items, "LABOR");
  const materialSubtotal = sumByType(items, "MATERIAL");
  const otherSubtotal = sumByType(items, "OTHER");
  const laborLineCount = items.filter((item) => item.type === "LABOR").length;

  const business = await tx.business.findUnique({
    where: { id: businessId },
    select: {
      laborMinimumEnabled: true,
      laborMinimumAmount: true,
    },
  });

  const adjustment = laborMinimumAdjustment({
    laborSubtotal,
    laborLineCount,
    enabled: Boolean(business?.laborMinimumEnabled),
    amount: business?.laborMinimumAmount ?? null,
    waived: estimate.laborMinimumWaived,
  });

  await tx.estimate.update({
    where: { id: estimate.id },
    data: {
      laborMinimumAdjustment: adjustment,
      total: laborSubtotal.add(adjustment).add(materialSubtotal).add(otherSubtotal),
    },
  });
}

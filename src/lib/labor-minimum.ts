import { Prisma } from "@prisma/client";

export function laborMinimumAdjustment(input: {
  laborSubtotal: Prisma.Decimal;
  lineCount: number;
  enabled: boolean;
  amount: Prisma.Decimal | null;
  waived: boolean;
}) {
  if (
    input.waived ||
    !input.enabled ||
    input.amount == null ||
    input.amount.lte(0) ||
    input.lineCount === 0
  ) {
    return new Prisma.Decimal(0);
  }

  if (input.laborSubtotal.gte(input.amount)) {
    return new Prisma.Decimal(0);
  }

  return input.amount.sub(input.laborSubtotal);
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
    select: { total: true },
  });
  const laborSubtotal = items.reduce(
    (sum, item) => sum.add(item.total),
    new Prisma.Decimal(0),
  );

  const business = await tx.business.findUnique({
    where: { id: businessId },
    select: {
      laborMinimumEnabled: true,
      laborMinimumAmount: true,
    },
  });

  const adjustment = laborMinimumAdjustment({
    laborSubtotal,
    lineCount: items.length,
    enabled: Boolean(business?.laborMinimumEnabled),
    amount: business?.laborMinimumAmount ?? null,
    waived: estimate.laborMinimumWaived,
  });

  await tx.estimate.update({
    where: { id: estimate.id },
    data: {
      laborMinimumAdjustment: adjustment,
      total: laborSubtotal.add(adjustment),
    },
  });
}

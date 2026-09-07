/**
 * Owner-controlled material deposit on draft estimates.
 *
 * Suggested deposit is the Final Customer Materials Total (the owner
 * lump sum when overridden, otherwise the MATERIAL line total — never
 * internal cost, never labor). An owner override is encoded on a line
 * description after MATERIAL_DEPOSIT_MARKER — Preview shares Production
 * and does not run migrations, so this cannot be a new Prisma column.
 *
 * Deposit is part of the estimate total, not an extra fee. Recalc and
 * material-line changes never overwrite a manual override.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { EstimateLineError } from "@/lib/estimate-line-ops";
import {
  joinLineDescriptionFromParts,
  lineMaterialTakeoffSource,
  splitLineDescription,
  type MaterialDepositOverride,
} from "@/lib/estimate-line-scope";
import { resolveCustomerMaterialsTotal } from "@/lib/customer-materials-total";
import { persistDraftEstimateTotal } from "@/lib/labor-minimum";

const ZERO = new Prisma.Decimal(0);

export const MATERIAL_DEPOSIT_CUSTOMER_LABEL =
  "Material Deposit Due Upon Approval";
export const REMAINING_BALANCE_CUSTOMER_LABEL = "Remaining Balance";
export const MATERIAL_DEPOSIT_CUSTOMER_NOTE =
  "This material deposit is part of the estimate total, not an additional fee.";

type MoneyLine = {
  id?: string;
  type: string;
  total: Prisma.Decimal | string | number;
  description: string;
};

export type ResolvedMaterialDeposit = {
  suggested: Prisma.Decimal;
  amount: Prisma.Decimal;
  remaining: Prisma.Decimal;
  manual: boolean;
  suggestedChanged: boolean;
};

function toDecimal(value: Prisma.Decimal | string | number) {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

function clampMoney(
  value: Prisma.Decimal,
  min: Prisma.Decimal,
  max: Prisma.Decimal,
) {
  if (value.lt(min)) return min;
  if (value.gt(max)) return max;
  return value;
}

export function suggestedMaterialDeposit(
  lines: Array<{
    type: string;
    total: Prisma.Decimal | string | number;
    description?: string;
  }>,
) {
  return resolveCustomerMaterialsTotal(lines).amount;
}

export function materialDepositOverrideFromLines(
  lines: Array<{ description: string }>,
): MaterialDepositOverride | null {
  for (const line of lines) {
    const override = splitLineDescription(line.description).materialDeposit;
    if (override) return override;
  }
  return null;
}

export function resolveMaterialDeposit(input: {
  lines: MoneyLine[];
  total: Prisma.Decimal | string | number;
}): ResolvedMaterialDeposit {
  const total = toDecimal(input.total);
  const suggested = clampMoney(suggestedMaterialDeposit(input.lines), ZERO, total);
  const override = materialDepositOverrideFromLines(input.lines);
  const amount = clampMoney(
    override ? new Prisma.Decimal(override.amount.toFixed(2)) : suggested,
    ZERO,
    total,
  );
  return {
    suggested,
    amount,
    remaining: total.sub(amount),
    manual: Boolean(override),
    suggestedChanged: Boolean(override) && !amount.eq(suggested),
  };
}

export function pickMaterialDepositHostLineId(
  lines: Array<{ id: string; type: string; description: string }>,
) {
  const existing = lines.find(
    (line) => splitLineDescription(line.description).materialDeposit,
  );
  if (existing) return existing.id;
  const laborParent = lines.find(
    (line) =>
      line.type === "LABOR" && !lineMaterialTakeoffSource(line.description),
  );
  if (laborParent) return laborParent.id;
  return lines[0]?.id ?? null;
}

export function descriptionsWithMaterialDeposit(
  lines: Array<{ id: string; type: string; description: string }>,
  override: MaterialDepositOverride | null,
) {
  const hostId = override ? pickMaterialDepositHostLineId(lines) : null;
  return lines.flatMap((line) => {
    const parts = splitLineDescription(line.description);
    const next = joinLineDescriptionFromParts(parts, {
      materialDeposit: override && line.id === hostId ? override : null,
    });
    if (next === line.description) return [];
    return [{ id: line.id, description: next }];
  });
}

export async function setDraftEstimateMaterialDeposit(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    estimateId: string;
    amount: string | null;
    followSuggested?: boolean;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  const estimate = access.assertOwned(
    await db.estimate.findFirst({
      where: { id: input.estimateId, ...access.scope },
      select: { id: true, businessId: true, status: true, total: true },
    }),
  );
  if (estimate.status !== "DRAFT") {
    throw new EstimateLineError("Only a draft estimate can be changed.");
  }
  const lines = await db.lineItem.findMany({
    where: { estimateId: estimate.id, businessId: access.businessId },
    orderBy: { createdAt: "asc" },
    select: { id: true, type: true, description: true, total: true },
  });
  if (lines.length === 0) {
    throw new EstimateLineError("Add line items before setting a material deposit.");
  }

  let override: MaterialDepositOverride | null = null;
  if (!input.followSuggested) {
    const parsed = parseDepositAmount(input.amount);
    const total = toDecimal(estimate.total);
    const amount = clampMoney(parsed, ZERO, total);
    override = { amount: Number(amount.toFixed(2)), manual: true };
  }

  const updates = descriptionsWithMaterialDeposit(lines, override);
  if (updates.length === 0) {
    return resolveMaterialDeposit({ lines, total: estimate.total });
  }

  await db.$transaction(async (tx) => {
    for (const row of updates) {
      await tx.lineItem.update({
        where: { id: row.id },
        data: { description: row.description },
      });
    }
    await persistDraftEstimateTotal(tx, estimate.id, access.businessId);
  });

  const nextLines = await db.lineItem.findMany({
    where: { estimateId: estimate.id, businessId: access.businessId },
    select: { type: true, total: true, description: true },
  });
  const nextEstimate = await db.estimate.findFirstOrThrow({
    where: { id: estimate.id, businessId: access.businessId },
    select: { total: true },
  });
  return resolveMaterialDeposit({ lines: nextLines, total: nextEstimate.total });
}

export async function relocateMaterialDepositAfterLineRemoval(
  tx: Prisma.TransactionClient,
  input: {
    estimateId: string;
    businessId: string;
    removedDescription: string;
    remainingLineIds: string[];
  },
) {
  const override = splitLineDescription(input.removedDescription).materialDeposit;
  if (!override || input.remainingLineIds.length === 0) return;
  const remaining = await tx.lineItem.findMany({
    where: {
      id: { in: input.remainingLineIds },
      estimateId: input.estimateId,
      businessId: input.businessId,
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, type: true, description: true },
  });
  const updates = descriptionsWithMaterialDeposit(remaining, override);
  for (const row of updates) {
    await tx.lineItem.update({
      where: { id: row.id },
      data: { description: row.description },
    });
  }
}

function parseDepositAmount(raw: string | null) {
  if (raw == null || !raw.trim()) {
    throw new EstimateLineError("Enter a material deposit amount.");
  }
  try {
    const value = new Prisma.Decimal(raw);
    if (value.isNaN() || value.lt(0)) {
      throw new EstimateLineError("Enter a material deposit of zero or more.");
    }
    return value;
  } catch (error) {
    if (error instanceof EstimateLineError) throw error;
    throw new EstimateLineError("Enter a valid material deposit amount.");
  }
}

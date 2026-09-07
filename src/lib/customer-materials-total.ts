/**
 * Owner-controlled Final Customer Materials Total on draft estimates.
 *
 * Calculated total is the sum of MATERIAL line customer prices (never
 * internal cost). An owner override is encoded on a line description after
 * CUSTOMER_MATERIALS_TOTAL_MARKER — Preview shares Production and does not
 * run migrations, so this cannot be a new Prisma column.
 *
 * Recalc, quantity, markup, and unit-cost changes never overwrite a manual
 * override. The owner must explicitly choose "Use calculated total".
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { EstimateLineError } from "@/lib/estimate-line-ops";
import {
  joinLineDescriptionFromParts,
  lineMaterialTakeoffSource,
  splitLineDescription,
  type CustomerMaterialsTotalOverride,
} from "@/lib/estimate-line-scope";
import { persistDraftEstimateTotal } from "@/lib/labor-minimum";

const ZERO = new Prisma.Decimal(0);

type MoneyLine = {
  id?: string;
  type: string;
  total: Prisma.Decimal | string | number;
  description?: string;
};

export type ResolvedCustomerMaterialsTotal = {
  calculated: Prisma.Decimal;
  amount: Prisma.Decimal;
  manual: boolean;
  differs: boolean;
};

function toDecimal(value: Prisma.Decimal | string | number) {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

export function calculatedMaterialsTotal(
  lines: Array<{ type: string; total: Prisma.Decimal | string | number }>,
) {
  return lines
    .filter((line) => line.type === "MATERIAL")
    .reduce((sum, line) => sum.add(toDecimal(line.total)), ZERO);
}

export function customerMaterialsTotalOverrideFromLines(
  lines: Array<{ description?: string }>,
): CustomerMaterialsTotalOverride | null {
  for (const line of lines) {
    const override = splitLineDescription(line.description).customerMaterialsTotal;
    if (override) return override;
  }
  return null;
}

export function resolveCustomerMaterialsTotal(
  lines: MoneyLine[],
): ResolvedCustomerMaterialsTotal {
  const calculated = calculatedMaterialsTotal(lines);
  const override = customerMaterialsTotalOverrideFromLines(lines);
  const amount = override
    ? new Prisma.Decimal(override.amount.toFixed(2))
    : calculated;
  return {
    calculated,
    amount,
    manual: Boolean(override),
    differs: Boolean(override) && !amount.eq(calculated),
  };
}

export function pickCustomerMaterialsTotalHostLineId(
  lines: Array<{ id: string; type: string; description: string }>,
) {
  const existing = lines.find(
    (line) => splitLineDescription(line.description).customerMaterialsTotal,
  );
  if (existing) return existing.id;
  const laborParent = lines.find(
    (line) =>
      line.type === "LABOR" && !lineMaterialTakeoffSource(line.description),
  );
  if (laborParent) return laborParent.id;
  return lines[0]?.id ?? null;
}

export function descriptionsWithCustomerMaterialsTotal(
  lines: Array<{ id: string; type: string; description: string }>,
  override: CustomerMaterialsTotalOverride | null,
) {
  const hostId = override ? pickCustomerMaterialsTotalHostLineId(lines) : null;
  return lines.flatMap((line) => {
    const parts = splitLineDescription(line.description);
    const next = joinLineDescriptionFromParts(parts, {
      customerMaterialsTotal: override && line.id === hostId ? override : null,
    });
    if (next === line.description) return [];
    return [{ id: line.id, description: next }];
  });
}

export async function setDraftEstimateCustomerMaterialsTotal(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    estimateId: string;
    amount: string | null;
    followCalculated?: boolean;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  const estimate = access.assertOwned(
    await db.estimate.findFirst({
      where: { id: input.estimateId, ...access.scope },
      select: { id: true, businessId: true, status: true },
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
    throw new EstimateLineError(
      "Add line items before setting a customer materials total.",
    );
  }

  let override: CustomerMaterialsTotalOverride | null = null;
  if (!input.followCalculated) {
    const amount = parseMaterialsAmount(input.amount);
    override = { amount: Number(amount.toFixed(2)), manual: true };
  }

  const updates = descriptionsWithCustomerMaterialsTotal(lines, override);
  if (updates.length === 0) {
    return resolveCustomerMaterialsTotal(lines);
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
  return resolveCustomerMaterialsTotal(nextLines);
}

export async function relocateCustomerMaterialsTotalAfterLineRemoval(
  tx: Prisma.TransactionClient,
  input: {
    estimateId: string;
    businessId: string;
    removedDescription: string;
    remainingLineIds: string[];
  },
) {
  const override = splitLineDescription(input.removedDescription).customerMaterialsTotal;
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
  const updates = descriptionsWithCustomerMaterialsTotal(remaining, override);
  for (const row of updates) {
    await tx.lineItem.update({
      where: { id: row.id },
      data: { description: row.description },
    });
  }
}

function parseMaterialsAmount(raw: string | null) {
  if (raw == null || !raw.trim()) {
    throw new EstimateLineError("Enter a customer materials total.");
  }
  try {
    const value = new Prisma.Decimal(raw);
    if (value.isNaN() || value.lt(0)) {
      throw new EstimateLineError(
        "Enter a customer materials total of zero or more.",
      );
    }
    return value;
  } catch (error) {
    if (error instanceof EstimateLineError) throw error;
    throw new EstimateLineError("Enter a valid customer materials total.");
  }
}

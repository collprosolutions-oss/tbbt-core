/**
 * Owner mutations for optional labor burden and recurring-pattern review.
 * Never trusts a browser-supplied businessId. Does not create payables.
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { requireOperatingProductCapability } from "@/lib/product-entitlements";
import { parseOptionalRate } from "@/lib/financial-intelligence/labor-burden";

type Db = PrismaClient | Prisma.TransactionClient;

export class FinancialIntelligenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinancialIntelligenceError";
  }
}

export function financialIntelligenceErrorMessage(error: unknown, fallback: string) {
  if (error instanceof FinancialIntelligenceError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  if (error instanceof Error && /entitlement|subscription|capability/i.test(error.message)) {
    return error.message;
  }
  return fallback;
}

async function requireFinancialWrite(db: Db, access: BusinessAccess) {
  requireBusinessCapability(access, CAPABILITIES.VIEW_REPORTS);
  await requireOperatingProductCapability(db, access, PRODUCT_CAPABILITIES.REPORTING_INSIGHTS);
}

export async function saveLaborBurdenSetting(
  db: Db,
  access: BusinessAccess,
  input: { burdenRate?: string; targetGrossMarginRate?: string; notes?: string },
) {
  await requireFinancialWrite(db, access);
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  const burdenRate = parseOptionalRate(input.burdenRate);
  const targetGrossMarginRate = parseOptionalRate(input.targetGrossMarginRate);
  if (input.burdenRate?.trim() && burdenRate == null) {
    throw new FinancialIntelligenceError("Enter a valid burden rate or leave it blank.");
  }
  if (input.targetGrossMarginRate?.trim() && targetGrossMarginRate == null) {
    throw new FinancialIntelligenceError("Enter a valid target margin or leave it blank.");
  }
  const notes = input.notes?.trim() ? input.notes.trim().slice(0, 500) : null;
  return db.businessLaborBurdenSetting.upsert({
    where: { businessId: access.businessId },
    create: {
      businessId: access.businessId,
      burdenRate,
      targetGrossMarginRate,
      notes,
    },
    update: {
      burdenRate,
      targetGrossMarginRate,
      notes,
    },
  });
}

export async function reviewRecurringExpensePattern(
  db: Db,
  access: BusinessAccess,
  input: {
    patternKey: string;
    description: string;
    vendor?: string | null;
    category: string;
    suggestedAmount: number;
    occurrenceCount: number;
    firstOccurredOn: Date;
    lastOccurredOn: Date;
    ownerStatus: "CONFIRMED" | "DISMISSED";
  },
) {
  await requireFinancialWrite(db, access);
  if (!input.patternKey.trim()) {
    throw new FinancialIntelligenceError("That recurring pattern could not be reviewed.");
  }
  const now = new Date();
  return db.recurringExpensePattern.upsert({
    where: {
      businessId_patternKey: {
        businessId: access.businessId,
        patternKey: input.patternKey,
      },
    },
    create: {
      businessId: access.businessId,
      patternKey: input.patternKey,
      description: input.description.slice(0, 200),
      vendor: input.vendor ?? null,
      category: input.category,
      suggestedAmount: new Prisma.Decimal(input.suggestedAmount),
      occurrenceCount: input.occurrenceCount,
      firstOccurredOn: input.firstOccurredOn,
      lastOccurredOn: input.lastOccurredOn,
      ownerStatus: input.ownerStatus,
      confirmedAt: input.ownerStatus === "CONFIRMED" ? now : null,
      confirmedByMembershipId: input.ownerStatus === "CONFIRMED" ? access.workspace.membership.id : null,
      dismissedAt: input.ownerStatus === "DISMISSED" ? now : null,
      dismissedByMembershipId: input.ownerStatus === "DISMISSED" ? access.workspace.membership.id : null,
    },
    update: {
      description: input.description.slice(0, 200),
      vendor: input.vendor ?? null,
      category: input.category,
      suggestedAmount: new Prisma.Decimal(input.suggestedAmount),
      occurrenceCount: input.occurrenceCount,
      firstOccurredOn: input.firstOccurredOn,
      lastOccurredOn: input.lastOccurredOn,
      ownerStatus: input.ownerStatus,
      confirmedAt: input.ownerStatus === "CONFIRMED" ? now : null,
      confirmedByMembershipId: input.ownerStatus === "CONFIRMED" ? access.workspace.membership.id : null,
      dismissedAt: input.ownerStatus === "DISMISSED" ? now : null,
      dismissedByMembershipId: input.ownerStatus === "DISMISSED" ? access.workspace.membership.id : null,
    },
  });
}

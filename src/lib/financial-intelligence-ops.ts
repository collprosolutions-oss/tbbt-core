/**
 * Owner mutations for optional labor burden and recurring-pattern review.
 * Never trusts a browser-supplied businessId. Does not create payables.
 * Recurring review recomputes facts from this tenant's Expense rows.
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability, requireBusinessRole } from "@/lib/authorization";
import { detectRecurringExpensePatterns } from "@/lib/financial-intelligence/recurring-expenses";
import {
  BURDEN_PERCENT_MAX,
  parsePercentInput,
  TARGET_MARGIN_PERCENT_MAX,
} from "@/lib/financial-intelligence/labor-burden";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { requireOperatingProductCapability } from "@/lib/product-entitlements";
import { writeSettingsAuditLog } from "@/lib/settings-ops";
import { asNumber } from "@/lib/reports";

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

  const previous = await db.businessLaborBurdenSetting.findUnique({
    where: { businessId: access.businessId },
  });
  const previousBurden = previous ? asNumber(previous.burdenRate) : null;
  const previousTarget = previous ? asNumber(previous.targetGrossMarginRate) : null;
  const isOwner = access.workspace.role === "OWNER";

  const burdenRate = parsePercentInput(input.burdenRate, { maxPercent: BURDEN_PERCENT_MAX });
  if (input.burdenRate?.trim() && burdenRate == null) {
    throw new FinancialIntelligenceError("Enter a burden percent from 0 to 200, or leave it blank.");
  }

  let targetGrossMarginRate = previousTarget;
  if (isOwner) {
    targetGrossMarginRate = parsePercentInput(input.targetGrossMarginRate, {
      maxPercent: TARGET_MARGIN_PERCENT_MAX,
    });
    if (input.targetGrossMarginRate?.trim() && targetGrossMarginRate == null) {
      throw new FinancialIntelligenceError("Enter a target margin percent from 0 to 100, or leave it blank.");
    }
  }

  const notes = input.notes?.trim() ? input.notes.trim().slice(0, 500) : null;
  const saved = await db.businessLaborBurdenSetting.upsert({
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

  if ((previousBurden ?? null) !== (burdenRate ?? null)) {
    await writeSettingsAuditLog(db, {
      businessId: access.businessId,
      changedByMembershipId: access.workspace.membership.id,
      settingArea: "financial-intelligence",
      settingKey: "laborBurden.burdenRate",
      previousValue: previousBurden,
      newValue: burdenRate,
    });
  }
  if (isOwner && (previousTarget ?? null) !== (targetGrossMarginRate ?? null)) {
    await writeSettingsAuditLog(db, {
      businessId: access.businessId,
      changedByMembershipId: access.workspace.membership.id,
      settingArea: "financial-intelligence",
      settingKey: "laborBurden.targetGrossMarginRate",
      previousValue: previousTarget,
      newValue: targetGrossMarginRate,
    });
  }

  return saved;
}

export async function reviewRecurringExpensePattern(
  db: Db,
  access: BusinessAccess,
  input: {
    patternKey: string;
    ownerStatus: "CONFIRMED" | "DISMISSED";
  },
) {
  await requireFinancialWrite(db, access);
  requireBusinessRole(access, "OWNER");
  const patternKey = input.patternKey.trim();
  if (!patternKey) {
    throw new FinancialIntelligenceError("That recurring pattern could not be reviewed.");
  }

  const expenses = await db.expense.findMany({
    where: { businessId: access.businessId },
    select: {
      id: true,
      description: true,
      amount: true,
      category: true,
      vendor: true,
      recurring: true,
      occurredOn: true,
    },
  });
  const persisted = await db.recurringExpensePattern.findMany({
    where: { businessId: access.businessId },
  });
  const suggestions = detectRecurringExpensePatterns(
    expenses.map((row) => ({
      ...row,
      amount: asNumber(row.amount),
    })),
    persisted.map((row) => ({
      id: row.id,
      patternKey: row.patternKey,
      description: row.description,
      vendor: row.vendor,
      category: row.category,
      suggestedAmount: asNumber(row.suggestedAmount),
      occurrenceCount: row.occurrenceCount,
      firstOccurredOn: row.firstOccurredOn,
      lastOccurredOn: row.lastOccurredOn,
      ownerStatus: row.ownerStatus,
    })),
  );
  const resolved = suggestions.find((row) => row.patternKey === patternKey);
  if (!resolved) {
    throw new FinancialIntelligenceError("That recurring pattern is unknown or stale.");
  }

  const now = new Date();
  return db.recurringExpensePattern.upsert({
    where: {
      businessId_patternKey: {
        businessId: access.businessId,
        patternKey,
      },
    },
    create: {
      businessId: access.businessId,
      patternKey,
      description: resolved.description.slice(0, 200),
      vendor: resolved.vendor,
      category: resolved.category,
      suggestedAmount: new Prisma.Decimal(resolved.suggestedAmount),
      occurrenceCount: resolved.occurrenceCount,
      firstOccurredOn: resolved.firstOccurredOn,
      lastOccurredOn: resolved.lastOccurredOn,
      ownerStatus: input.ownerStatus,
      confirmedAt: input.ownerStatus === "CONFIRMED" ? now : null,
      confirmedByMembershipId: input.ownerStatus === "CONFIRMED" ? access.workspace.membership.id : null,
      dismissedAt: input.ownerStatus === "DISMISSED" ? now : null,
      dismissedByMembershipId: input.ownerStatus === "DISMISSED" ? access.workspace.membership.id : null,
    },
    update: {
      description: resolved.description.slice(0, 200),
      vendor: resolved.vendor,
      category: resolved.category,
      suggestedAmount: new Prisma.Decimal(resolved.suggestedAmount),
      occurrenceCount: resolved.occurrenceCount,
      firstOccurredOn: resolved.firstOccurredOn,
      lastOccurredOn: resolved.lastOccurredOn,
      ownerStatus: input.ownerStatus,
      confirmedAt: input.ownerStatus === "CONFIRMED" ? now : null,
      confirmedByMembershipId: input.ownerStatus === "CONFIRMED" ? access.workspace.membership.id : null,
      dismissedAt: input.ownerStatus === "DISMISSED" ? now : null,
      dismissedByMembershipId: input.ownerStatus === "DISMISSED" ? access.workspace.membership.id : null,
    },
  });
}

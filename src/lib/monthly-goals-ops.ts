/**
 * OWNER writes for monthly business-goal targets.
 * businessId always comes from BusinessAccess. This module writes only
 * MonthlyBusinessGoal rows — never invoices, payments, expenses, jobs,
 * catalog prices, or recorded facts. Does not send messages.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { ForbiddenError } from "@/lib/authorization";
import {
  GOAL_UNAVAILABLE_MESSAGE,
  INVALID_MONTH_MESSAGE,
  NO_AUTOMATIC_MESSAGE_MESSAGE,
  NO_AUTOMATIC_PRICE_CHANGE_MESSAGE,
  SAVE_DOES_NOT_WRITE_BOOKS_MESSAGE,
  assertCanWriteMonthlyGoals,
  parseMonthlyGoalKey,
  parseMonthlyGoalTargets,
  toSavedMonthlyBusinessGoal,
  type SavedMonthlyBusinessGoal,
} from "@/lib/monthly-goals";

export class MonthlyBusinessGoalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MonthlyBusinessGoalError";
  }
}

export class MonthlyBusinessGoalUnavailableError extends MonthlyBusinessGoalError {
  constructor(message = GOAL_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = "MonthlyBusinessGoalUnavailableError";
  }
}

export function missingMonthlyGoalSchema(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: string }).code)
      : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === "P2021" ||
    code === "P2022" ||
    /MonthlyBusinessGoal|monthlyBusinessGoal|does not exist/i.test(message)
  );
}

export function monthlyBusinessGoalErrorMessage(error: unknown, fallback: string) {
  if (
    error instanceof MonthlyBusinessGoalError ||
    error instanceof MonthlyBusinessGoalUnavailableError ||
    error instanceof ForbiddenError
  ) {
    return error.message;
  }
  if (missingMonthlyGoalSchema(error)) {
    return GOAL_UNAVAILABLE_MESSAGE;
  }
  return fallback;
}

export type SaveMonthlyBusinessGoalInput = {
  month?: string | null;
  jobsCompleted?: string | null;
  invoicesPaid?: string | null;
  revenueReceived?: string | null;
};

export async function saveMonthlyBusinessGoal(
  prisma: PrismaClient,
  access: BusinessAccess,
  input: SaveMonthlyBusinessGoalInput,
): Promise<{ saved: SavedMonthlyBusinessGoal; message: string }> {
  assertCanWriteMonthlyGoals(access);
  const period = parseMonthlyGoalKey(input.month);
  if (!period) {
    throw new MonthlyBusinessGoalError(INVALID_MONTH_MESSAGE);
  }
  const parsed = parseMonthlyGoalTargets(input);
  if (parsed.errors.length > 0) {
    throw new MonthlyBusinessGoalError(parsed.errors[0]!);
  }

  const data = {
    jobsCompletedTarget: parsed.targets.jobsCompleted,
    invoicesPaidTarget: parsed.targets.invoicesPaid,
    revenueReceivedTarget:
      parsed.targets.revenueReceived == null
        ? null
        : new Prisma.Decimal(parsed.targets.revenueReceived),
    updatedByMembershipId: access.workspace.membership.id,
  };

  try {
    const existing = await prisma.monthlyBusinessGoal.findFirst({
      where: { businessId: access.businessId, year: period.year, month: period.month },
      select: { id: true, businessId: true },
    });
    if (existing && existing.businessId !== access.businessId) {
      throw new ForbiddenError();
    }

    const row = existing
      ? await prisma.monthlyBusinessGoal.update({
          where: { id: existing.id },
          data,
        })
      : await prisma.monthlyBusinessGoal.create({
          data: {
            ...data,
            businessId: access.businessId,
            year: period.year,
            month: period.month,
            createdByMembershipId: access.workspace.membership.id,
          },
        });

    if (row.businessId !== access.businessId) {
      throw new ForbiddenError();
    }

    return {
      saved: toSavedMonthlyBusinessGoal(row),
      message: `${SAVE_DOES_NOT_WRITE_BOOKS_MESSAGE} ${NO_AUTOMATIC_PRICE_CHANGE_MESSAGE} ${NO_AUTOMATIC_MESSAGE_MESSAGE}`,
    };
  } catch (error) {
    if (missingMonthlyGoalSchema(error)) {
      throw new MonthlyBusinessGoalUnavailableError();
    }
    throw error;
  }
}

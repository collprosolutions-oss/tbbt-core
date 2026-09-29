/**
 * Bounded, tenant-scoped loader for monthly business goals.
 * businessId must come from requireManagementPageAccess().
 * Read-only: no invoice, payment, job, price, or goal writes.
 */
import type { PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import { asNumber } from "@/lib/reports";
import {
  GOAL_UNAVAILABLE_MESSAGE,
  MONTHLY_GOALS_READ_BOUND,
  assertCanReadMonthlyGoals,
  buildMonthlyGoalProgress,
  isolateMonthlyGoalFacts,
  isolateSameBusinessRows,
  resolveMonthlyGoalPeriod,
  targetsFromSavedGoal,
  toSavedMonthlyBusinessGoal,
  type MonthlyGoalFactSource,
  type MonthlyGoalPeriod,
  type MonthlyGoalProgress,
  type MonthlyGoalTargets,
  type SavedMonthlyBusinessGoal,
} from "@/lib/monthly-goals";

export type MonthlyGoalsWorkspaceData = {
  period: MonthlyGoalPeriod;
  targets: MonthlyGoalTargets;
  saved: SavedMonthlyBusinessGoal | null;
  progress: {
    jobsCompleted: MonthlyGoalProgress;
    invoicesPaid: MonthlyGoalProgress;
    revenueReceived: MonthlyGoalProgress;
  };
  canWrite: boolean;
  goalsAvailable: boolean;
  unavailableMessage: string | null;
  unclockedCompletedJobs: number;
};

function missingMonthlyGoalSchema(error: unknown) {
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

function hitBound(count: number) {
  return count > MONTHLY_GOALS_READ_BOUND;
}

function takeBound() {
  return MONTHLY_GOALS_READ_BOUND + 1;
}

export async function loadMonthlyGoalFactSource(
  prisma: PrismaClient,
  access: BusinessAccess,
  period: MonthlyGoalPeriod,
): Promise<MonthlyGoalFactSource> {
  assertCanReadMonthlyGoals(access);
  const businessId = access.businessId;
  const scope = { businessId } as const;
  const range = { gte: period.start, lt: period.end };

  const [jobCompletions, completedJobs, paidInvoices, payments] = await Promise.all([
    prisma.businessEvent.findMany({
      where: { ...scope, type: "JOB_COMPLETED", subjectType: "JOB", occurredAt: range },
      select: { businessId: true, subjectId: true, occurredAt: true },
      take: takeBound(),
      orderBy: { occurredAt: "asc" },
    }),
    prisma.job.findMany({
      where: { ...scope, status: "COMPLETED" },
      select: { id: true, businessId: true },
      take: takeBound(),
      orderBy: { id: "asc" },
    }),
    prisma.invoice.findMany({
      where: { ...scope, status: "PAID", paidAt: range },
      select: { id: true, businessId: true, status: true, total: true, paidAt: true },
      take: takeBound(),
      orderBy: { paidAt: "asc" },
    }),
    prisma.payment.findMany({
      where: { ...scope, receivedAt: range },
      select: { id: true, businessId: true, amount: true, invoiceId: true, receivedAt: true },
      take: takeBound(),
      orderBy: { receivedAt: "asc" },
    }),
  ]);

  const completedJobIds = completedJobs.slice(0, MONTHLY_GOALS_READ_BOUND).map((job) => job.id);
  const paidInvoiceIds = paidInvoices.slice(0, MONTHLY_GOALS_READ_BOUND).map((invoice) => invoice.id);

  const [completionEventsForCompletedJobs, paymentsOnPaidInvoices] = await Promise.all([
    completedJobIds.length
      ? prisma.businessEvent.findMany({
          where: {
            ...scope,
            type: "JOB_COMPLETED",
            subjectType: "JOB",
            subjectId: { in: completedJobIds },
          },
          select: { businessId: true, subjectId: true },
          take: takeBound(),
        })
      : Promise.resolve([]),
    paidInvoiceIds.length
      ? prisma.payment.findMany({
          where: { ...scope, invoiceId: { in: paidInvoiceIds } },
          select: { businessId: true, invoiceId: true },
          take: takeBound(),
        })
      : Promise.resolve([]),
  ]);

  return isolateMonthlyGoalFacts({
    businessId,
    timeZone: period.timeZone,
    jobCompletions: jobCompletions.map((event) => ({
      businessId: event.businessId,
      jobId: event.subjectId,
      occurredAt: event.occurredAt,
    })),
    completedJobs,
    completionEventsForCompletedJobs: completionEventsForCompletedJobs.map((event) => ({
      businessId: event.businessId,
      jobId: event.subjectId,
    })),
    paidInvoices: paidInvoices.map((invoice) => ({
      ...invoice,
      total: asNumber(invoice.total),
    })),
    payments: payments.map((payment) => ({
      ...payment,
      amount: asNumber(payment.amount),
    })),
    paymentsOnPaidInvoices: paymentsOnPaidInvoices.flatMap((row) =>
      row.invoiceId ? [{ businessId: row.businessId, invoiceId: row.invoiceId }] : [],
    ),
    jobCompletionsTruncated: hitBound(jobCompletions.length),
    completedJobsTruncated: hitBound(completedJobs.length),
    paidInvoicesTruncated: hitBound(paidInvoices.length),
    paymentsTruncated: hitBound(payments.length),
    paymentsOnPaidInvoicesTruncated: hitBound(paymentsOnPaidInvoices.length),
  });
}

export async function loadSavedMonthlyBusinessGoal(
  prisma: PrismaClient,
  access: BusinessAccess,
  period: Pick<MonthlyGoalPeriod, "year" | "month">,
): Promise<{ saved: SavedMonthlyBusinessGoal | null; available: boolean }> {
  assertCanReadMonthlyGoals(access);
  try {
    const row = await prisma.monthlyBusinessGoal.findFirst({
      where: { businessId: access.businessId, year: period.year, month: period.month },
    });
    if (!row) return { saved: null, available: true };
    if (row.businessId !== access.businessId) return { saved: null, available: true };
    return { saved: toSavedMonthlyBusinessGoal(row), available: true };
  } catch (error) {
    if (missingMonthlyGoalSchema(error)) {
      return { saved: null, available: false };
    }
    throw error;
  }
}

export async function loadMonthlyGoalsWorkspace(
  prisma: PrismaClient,
  access: BusinessAccess,
  query: { month?: string | null },
  now: Date = new Date(),
): Promise<MonthlyGoalsWorkspaceData> {
  assertCanReadMonthlyGoals(access);
  const period = resolveMonthlyGoalPeriod(now, access.workspace.business, query.month);
  const [source, savedResult] = await Promise.all([
    loadMonthlyGoalFactSource(prisma, access, period),
    loadSavedMonthlyBusinessGoal(prisma, access, period),
  ]);
  const isolatedSaved = savedResult.saved
    ? isolateSameBusinessRows([savedResult.saved], access.businessId)[0] ?? null
    : null;
  const targets = targetsFromSavedGoal(isolatedSaved);
  const progress = buildMonthlyGoalProgress(source, period, targets);
  const clocked = new Set(source.completionEventsForCompletedJobs.map((event) => event.jobId));
  const unclockedCompletedJobs = source.completedJobs.filter((job) => !clocked.has(job.id)).length;

  return {
    period,
    targets,
    saved: isolatedSaved,
    progress,
    canWrite: access.workspace.role === "OWNER",
    goalsAvailable: savedResult.available,
    unavailableMessage: savedResult.available ? null : GOAL_UNAVAILABLE_MESSAGE,
    unclockedCompletedJobs,
  };
}

export function resolveWorkspaceTimeZone(access: BusinessAccess) {
  return resolveBusinessTimeZone(access.workspace.business);
}

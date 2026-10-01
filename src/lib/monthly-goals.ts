/**
 * Monthly business goals over recorded TBBT facts.
 *
 * OWNER sets a few civil-month targets. ADMIN may view. MEMBER is denied.
 * Actuals come from JOB_COMPLETED events, PAID invoices with paidAt, and
 * collected cash (Payment.receivedAt plus legacy PAID invoices with no
 * Payment rows). Targets are not forecasts and not a bank balance.
 *
 * Month bounds always use Business.timezone. Job.status COMPLETED without
 * a JOB_COMPLETED event is not a completion clock. SENT invoices are not
 * paid and not cash in. Reads stay bounded.
 */
import { Prisma } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  ForbiddenError,
  canAccessManagementConsole,
  requireBusinessCapability,
  requireBusinessRole,
  CAPABILITIES,
} from "@/lib/authorization";
import {
  addZonedCalendarMonths,
  formatISODateInTimeZone,
  resolveBusinessTimeZone,
  zonedCivilToUtc,
  zonedDateParts,
} from "@/lib/business-timezone";
import { collectedPaymentsInRange } from "@/lib/financial-intelligence/cash-flow";
import type { FinancialSource } from "@/lib/financial-intelligence/source";
import { asNumber } from "@/lib/reports";
import { roundMoney } from "@/lib/time-cards";

const ZERO = new Prisma.Decimal(0);

export function toMonthlyGoalMoney(value: { toString(): string } | number | string) {
  return new Prisma.Decimal(typeof value === "number" ? value.toString() : value.toString());
}

export function missingMonthlyGoalSchema(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: string }).code)
      : "";
  return code === "P2021" || code === "P2022";
}

export const MONTHLY_GOALS_PATH = "/goals";
export const MONTHLY_GOALS_READ_BOUND = 200;
export const MONTHLY_GOAL_COUNT_MAX = 100_000;
export const MONTHLY_GOAL_REVENUE_MAX = 10_000_000;

export const MONTHLY_GOAL_METRICS = [
  "jobs-completed",
  "invoices-paid",
  "revenue-received",
] as const;
export type MonthlyGoalMetric = (typeof MONTHLY_GOAL_METRICS)[number];

export const MONTHLY_GOAL_METRIC_LABELS: Record<MonthlyGoalMetric, string> = {
  "jobs-completed": "Jobs completed",
  "invoices-paid": "Invoices paid",
  "revenue-received": "Collected payments (recorded)",
};

export const TARGET_KIND = "target" as const;
export const RECORDED_FACT_KIND = "recorded-fact" as const;

export const TARGET_NOT_FORECAST_MESSAGE =
  "These numbers are owner-set monthly targets, not forecasts and not projected results.";

export const TARGET_NOT_BANK_BALANCE_MESSAGE =
  "Targets and recorded progress are not a bank balance. Banking is Not Connected. TBBT does not invent cash on hand.";

export const JOBS_COMPLETED_FACT_MESSAGE =
  "Jobs completed this month are recorded completion events whose time falls in the Business.timezone civil month. A completed job without a recorded completion date is not a completion clock and is not counted here.";

export const INVOICES_PAID_FACT_MESSAGE =
  "Invoices paid this month are Invoice rows with status PAID and paidAt in the Business.timezone civil month. SENT, DRAFT, and VOID invoices are not paid.";

export const REVENUE_RECEIVED_FACT_MESSAGE =
  "Collected payments (recorded) are TBBT-recorded collected cash for the Business.timezone month: Payment rows by receivedAt, including material deposits, plus legacy PAID invoices that have no Payment rows and were not closed by recorded credits, using paidAt. That is not bank balance and not unpaid invoice value.";

export const UNCLOCKED_COMPLETED_JOBS_MESSAGE =
  "Some completed jobs have no recorded completion date, so their completion month is unavailable and they are not counted toward this month.";

export const READ_BOUND_MESSAGE =
  "A recorded-fact read hit the monthly-goals bound, so this actual is a bounded sample and may be incomplete.";

export const GOAL_UNAVAILABLE_MESSAGE =
  "Monthly goals are unavailable on this environment until the monthly-goals migration is applied.";

export const NO_AUTOMATIC_PRICE_CHANGE_MESSAGE =
  "Setting a monthly goal does not change catalog prices, estimates, invoices, or jobs.";

export const NO_AUTOMATIC_MESSAGE_MESSAGE =
  "Setting a monthly goal does not send SMS or email.";

export const SAVE_DOES_NOT_WRITE_BOOKS_MESSAGE =
  "Saving monthly targets does not write invoices, payments, expenses, jobs, or prices.";

export const INVALID_MONTH_MESSAGE = "Choose a valid month.";
export const INVALID_COUNT_TARGET_MESSAGE =
  "Enter a whole number target of 1 or more, or leave the field blank to clear that target.";
export const INVALID_REVENUE_TARGET_MESSAGE =
  "Enter a dollar target greater than 0, or leave the field blank to clear that target.";

export type MonthlyGoalPeriod = {
  year: number;
  month: number;
  key: string;
  start: Date;
  end: Date;
  timeZone: string;
  label: string;
  previousKey: string;
  nextKey: string;
};

export type MonthlyGoalTargets = {
  jobsCompleted: number | null;
  invoicesPaid: number | null;
  revenueReceived: number | null;
};

export type MonthlyGoalProgressStatus =
  | "no-target"
  | "met"
  | "short"
  | "actual-incomplete"
  | "unavailable";

export type MonthlyGoalProgress = {
  metric: MonthlyGoalMetric;
  kind: typeof TARGET_KIND;
  actualKind: typeof RECORDED_FACT_KIND;
  actual: number;
  goal: number | null;
  remaining: number | null;
  percent: number | null;
  met: boolean | null;
  status: MonthlyGoalProgressStatus;
  actualIncomplete: boolean;
  notes: string[];
};

export type MonthlyGoalFactSource = {
  businessId: string;
  timeZone: string;
  jobCompletions: Array<{ businessId: string; jobId: string; occurredAt: Date }>;
  completedJobs: Array<{ businessId: string; id: string }>;
  completionEventsForCompletedJobs: Array<{ businessId: string; jobId: string }>;
  paidInvoices: Array<{
    businessId: string;
    id: string;
    status: string;
    total: number;
    paidAt: Date | null;
    paymentMethod?: string | null;
    paymentReference?: string | null;
  }>;
  payments: Array<{
    businessId: string;
    id: string;
    amount: number;
    invoiceId: string | null;
    receivedAt: Date;
  }>;
  invoiceCredits?: Array<{ id?: string; businessId: string; invoiceId: string; amount: number }>;
  paymentsOnPaidInvoices: Array<{ businessId: string; invoiceId: string }>;
  jobCompletionsTruncated: boolean;
  completedJobsTruncated: boolean;
  paidInvoicesTruncated: boolean;
  paymentsTruncated: boolean;
  paymentsOnPaidInvoicesTruncated: boolean;
};

export type SavedMonthlyBusinessGoal = {
  id: string;
  businessId: string;
  year: number;
  month: number;
  jobsCompletedTarget: number | null;
  invoicesPaidTarget: number | null;
  revenueReceivedTarget: number | null;
};

export function monthlyGoalHref(monthKey: string) {
  return `${MONTHLY_GOALS_PATH}?month=${encodeURIComponent(monthKey)}`;
}

export function formatMonthlyGoalKey(year: number, month: number) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function parseMonthlyGoalKey(raw: string | null | undefined): { year: number; month: number } | null {
  if (!raw || !/^\d{4}-\d{2}$/.test(raw)) return null;
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(5, 7));
  if (!Number.isInteger(year) || year < 1970 || year > 2100) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  return { year, month };
}

export function resolveMonthlyGoalPeriod(
  now: Date,
  business: { timezone?: string | null } | null | undefined,
  monthRaw?: string | null,
): MonthlyGoalPeriod {
  const timeZone = resolveBusinessTimeZone(business);
  const requested = parseMonthlyGoalKey(monthRaw);
  const parts = requested ?? zonedDateParts(now, timeZone);
  return monthlyGoalPeriod(parts.year, parts.month, timeZone);
}

export function monthlyGoalPeriod(year: number, month: number, timeZone: string): MonthlyGoalPeriod {
  const start = zonedCivilToUtc(year, month, 1, 0, 0, 0, timeZone);
  const end = addZonedCalendarMonths(start, 1, timeZone);
  const previous = addZonedCalendarMonths(start, -1, timeZone);
  const previousParts = zonedDateParts(previous, timeZone);
  const nextParts = zonedDateParts(end, timeZone);
  const key = formatMonthlyGoalKey(year, month);
  const atLastMonth = year === 2100 && month === 12;
  return {
    year,
    month,
    key,
    start,
    end,
    timeZone,
    label: start.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone }),
    previousKey: formatMonthlyGoalKey(previousParts.year, previousParts.month),
    nextKey: atLastMonth ? key : formatMonthlyGoalKey(nextParts.year, nextParts.month),
  };
}

export function inMonthlyGoalPeriod(date: Date | null | undefined, period: Pick<MonthlyGoalPeriod, "start" | "end">) {
  if (!date) return false;
  return date >= period.start && date < period.end;
}

export function parseCountTarget(raw: string | null | undefined): { value: number | null; error: string | null } {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return { value: null, error: null };
  if (!/^\d+$/.test(trimmed)) return { value: null, error: INVALID_COUNT_TARGET_MESSAGE };
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1 || value > MONTHLY_GOAL_COUNT_MAX) {
    return { value: null, error: INVALID_COUNT_TARGET_MESSAGE };
  }
  return { value, error: null };
}

export function parseMoneyTarget(
  raw: string | null | undefined,
): { value: Prisma.Decimal | null; error: string | null } {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return { value: null, error: null };
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return { value: null, error: INVALID_REVENUE_TARGET_MESSAGE };
  }
  const value = new Prisma.Decimal(trimmed);
  if (value.lte(0) || value.gt(MONTHLY_GOAL_REVENUE_MAX)) {
    return { value: null, error: INVALID_REVENUE_TARGET_MESSAGE };
  }
  return { value, error: null };
}

export function parseMonthlyGoalTargets(input: {
  jobsCompleted?: string | null;
  invoicesPaid?: string | null;
  revenueReceived?: string | null;
}): { targets: MonthlyGoalTargets; errors: string[] } {
  const jobs = parseCountTarget(input.jobsCompleted);
  const invoices = parseCountTarget(input.invoicesPaid);
  const revenue = parseMoneyTarget(input.revenueReceived);
  const errors = [jobs.error, invoices.error, revenue.error].filter((error): error is string => Boolean(error));
  return {
    targets: {
      jobsCompleted: jobs.value,
      invoicesPaid: invoices.value,
      revenueReceived: revenue.value == null ? null : Number(revenue.value.toFixed(2)),
    },
    errors,
  };
}

export function compareActualToGoal(input: {
  metric: MonthlyGoalMetric;
  actual: number;
  goal: number | null;
  actualIncomplete: boolean;
  extraNotes?: string[];
}): MonthlyGoalProgress {
  const notes = [...(input.extraNotes ?? [])];
  if (input.actualIncomplete) notes.push(READ_BOUND_MESSAGE);
  const goal = input.goal != null && Number.isFinite(input.goal) && input.goal > 0 ? input.goal : null;

  if (goal == null) {
    return {
      metric: input.metric,
      kind: TARGET_KIND,
      actualKind: RECORDED_FACT_KIND,
      actual: input.actual,
      goal: null,
      remaining: null,
      percent: null,
      met: null,
      status: input.actualIncomplete ? "actual-incomplete" : "no-target",
      actualIncomplete: input.actualIncomplete,
      notes,
    };
  }

  if (input.actualIncomplete && (input.metric === "revenue-received" || input.actual < goal)) {
    return {
      metric: input.metric,
      kind: TARGET_KIND,
      actualKind: RECORDED_FACT_KIND,
      actual: input.actual,
      goal,
      remaining: null,
      percent: null,
      met: null,
      status: "actual-incomplete",
      actualIncomplete: true,
      notes,
    };
  }

  return {
    metric: input.metric,
    kind: TARGET_KIND,
    actualKind: RECORDED_FACT_KIND,
    actual: input.actual,
    goal,
    remaining: roundMoney(Math.max(0, goal - input.actual)),
    percent: roundMoney((input.actual / goal) * 100),
    met: input.actual >= goal,
    status: input.actual >= goal ? "met" : "short",
    actualIncomplete: input.actualIncomplete,
    notes,
  };
}

export function isolateSameBusinessRows<T extends { businessId: string }>(
  rows: readonly T[],
  businessId: string,
): T[] {
  return rows.filter((row) => row.businessId === businessId);
}

export function isolateMonthlyGoalFacts(source: MonthlyGoalFactSource): MonthlyGoalFactSource {
  const businessId = source.businessId;
  return {
    ...source,
    jobCompletions: isolateSameBusinessRows(source.jobCompletions, businessId),
    completedJobs: isolateSameBusinessRows(source.completedJobs, businessId),
    completionEventsForCompletedJobs: isolateSameBusinessRows(source.completionEventsForCompletedJobs, businessId),
    paidInvoices: isolateSameBusinessRows(source.paidInvoices, businessId),
    payments: isolateSameBusinessRows(source.payments, businessId),
    invoiceCredits: isolateSameBusinessRows(source.invoiceCredits ?? [], businessId),
    paymentsOnPaidInvoices: isolateSameBusinessRows(source.paymentsOnPaidInvoices, businessId),
  };
}

export function countJobsCompletedInPeriod(source: MonthlyGoalFactSource, period: MonthlyGoalPeriod) {
  const isolated = isolateMonthlyGoalFacts(source);
  const jobIds = new Set<string>();
  for (const event of isolated.jobCompletions) {
    if (inMonthlyGoalPeriod(event.occurredAt, period)) jobIds.add(event.jobId);
  }
  const clockedJobIds = new Set(isolated.completionEventsForCompletedJobs.map((event) => event.jobId));
  const unclockedCompletedJobs = isolated.completedJobs.filter((job) => !clockedJobIds.has(job.id)).length;
  return {
    actual: jobIds.size,
    unclockedCompletedJobs,
    unclockedDisclosureIncomplete: isolated.completedJobsTruncated,
    incomplete: isolated.jobCompletionsTruncated,
  };
}

export function countInvoicesPaidInPeriod(source: MonthlyGoalFactSource, period: MonthlyGoalPeriod) {
  const isolated = isolateMonthlyGoalFacts(source);
  const paid = isolated.paidInvoices.filter(
    (invoice) => invoice.status === "PAID" && invoice.paidAt != null && inMonthlyGoalPeriod(invoice.paidAt, period),
  );
  return {
    actual: paid.length,
    incomplete: isolated.paidInvoicesTruncated,
  };
}

export function collectedRevenueInPeriod(source: MonthlyGoalFactSource, period: MonthlyGoalPeriod) {
  const isolated = isolateMonthlyGoalFacts(source);
  const presencePayments = isolated.paymentsOnPaidInvoices.map((row, index) => ({
    id: `presence:${row.invoiceId}:${index}`,
    businessId: row.businessId,
    customerId: null,
    jobId: null,
    invoiceId: row.invoiceId,
    purpose: "INVOICE_BALANCE",
    amount: 0,
    method: "CASH",
    receivedAt: new Date(0),
  }));
  const collected = collectedPaymentsInRange(
    {
      payments: [
        ...isolated.payments.map((payment) => ({
          id: payment.id,
          businessId: payment.businessId,
          customerId: null,
          jobId: null,
          invoiceId: payment.invoiceId,
          purpose: "INVOICE_BALANCE",
          amount: Number(toMonthlyGoalMoney(payment.amount).toFixed(2)),
          method: "CASH",
          receivedAt: payment.receivedAt,
        })),
        ...presencePayments,
      ],
      invoices: isolated.paidInvoices.map((invoice) => ({
        ...invoice,
        total: Number(toMonthlyGoalMoney(invoice.total).toFixed(2)),
      })),
      invoiceCredits: (isolated.invoiceCredits ?? []).map((credit) => ({
        id: credit.id,
        invoiceId: credit.invoiceId,
        amount: Number(toMonthlyGoalMoney(credit.amount).toFixed(2)),
      })),
    } as FinancialSource,
    period,
  );
  const actual = collected.collected.reduce(
    (sum, row) => sum.add(toMonthlyGoalMoney(row.amount)),
    ZERO,
  );
  return {
    actual: Number(actual.toFixed(2)),
    paymentCount: collected.payments.length,
    legacyInvoiceCount: collected.legacyPaid.length,
    incomplete:
      isolated.paymentsTruncated ||
      isolated.paidInvoicesTruncated ||
      isolated.paymentsOnPaidInvoicesTruncated,
  };
}

export function buildMonthlyGoalProgress(
  source: MonthlyGoalFactSource,
  period: MonthlyGoalPeriod,
  targets: MonthlyGoalTargets,
): {
  jobsCompleted: MonthlyGoalProgress;
  invoicesPaid: MonthlyGoalProgress;
  revenueReceived: MonthlyGoalProgress;
} {
  const jobs = countJobsCompletedInPeriod(source, period);
  const invoices = countInvoicesPaidInPeriod(source, period);
  const revenue = collectedRevenueInPeriod(source, period);
  const jobNotes = [JOBS_COMPLETED_FACT_MESSAGE];
  if (jobs.unclockedCompletedJobs > 0) jobNotes.push(UNCLOCKED_COMPLETED_JOBS_MESSAGE);

  return {
    jobsCompleted: compareActualToGoal({
      metric: "jobs-completed",
      actual: jobs.actual,
      goal: targets.jobsCompleted,
      actualIncomplete: jobs.incomplete,
      extraNotes: jobNotes,
    }),
    invoicesPaid: compareActualToGoal({
      metric: "invoices-paid",
      actual: invoices.actual,
      goal: targets.invoicesPaid,
      actualIncomplete: invoices.incomplete,
      extraNotes: [INVOICES_PAID_FACT_MESSAGE],
    }),
    revenueReceived: compareActualToGoal({
      metric: "revenue-received",
      actual: revenue.actual,
      goal: targets.revenueReceived,
      actualIncomplete: revenue.incomplete,
      extraNotes: [REVENUE_RECEIVED_FACT_MESSAGE],
    }),
  };
}

export function targetsFromSavedGoal(row: SavedMonthlyBusinessGoal | null): MonthlyGoalTargets {
  if (!row) {
    return { jobsCompleted: null, invoicesPaid: null, revenueReceived: null };
  }
  return {
    jobsCompleted: row.jobsCompletedTarget,
    invoicesPaid: row.invoicesPaidTarget,
    revenueReceived: row.revenueReceivedTarget,
  };
}

export function toSavedMonthlyBusinessGoal(row: {
  id: string;
  businessId: string;
  year: number;
  month: number;
  jobsCompletedTarget: number | null;
  invoicesPaidTarget: number | null;
  revenueReceivedTarget: { toString(): string } | number | null;
}): SavedMonthlyBusinessGoal {
  return {
    id: row.id,
    businessId: row.businessId,
    year: row.year,
    month: row.month,
    jobsCompletedTarget: row.jobsCompletedTarget,
    invoicesPaidTarget: row.invoicesPaidTarget,
    revenueReceivedTarget:
      row.revenueReceivedTarget == null ? null : asNumber(row.revenueReceivedTarget),
  };
}

export function assertCanReadMonthlyGoals(access: BusinessAccess): void {
  if (!canAccessManagementConsole(access.workspace.role)) {
    throw new ForbiddenError();
  }
  requireBusinessCapability(access, CAPABILITIES.VIEW_REPORTS);
}

export function assertCanWriteMonthlyGoals(access: BusinessAccess): void {
  assertCanReadMonthlyGoals(access);
  requireBusinessRole(access, "OWNER");
}

export function periodDateLabel(date: Date, timeZone: string) {
  return formatISODateInTimeZone(date, timeZone);
}

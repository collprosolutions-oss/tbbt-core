/**
 * Reports domain -- read-only business reporting over currently merged
 * TBBT records (invoices, jobs, customers, estimates, service requests,
 * catalog items, approved Time Cards, and payroll runs).
 *
 * This module does NOT invent expense totals, net profit, tax filings,
 * or service attribution when the real relationships are insufficient.
 * Expense / vendor reporting stays explicitly unavailable until the
 * Expenses records (PR #18, unmerged at the time this shipped) are
 * connected in a follow-up.
 *
 * No next/headers dependency -- authorization/isolation check scripts
 * import these helpers directly.
 */

import { addDays, addMonths, formatISODate, startOfDay, startOfMonth, startOfWeek } from "@/lib/schedule";
import { isPaidActivity, roundHours, roundMoney } from "@/lib/time-cards";
import { paymentMethodLabel } from "@/lib/invoice-payment";

export const REPORT_AREAS = [
  "overview",
  "profit-loss",
  "revenue",
  "expenses",
  "job-profitability",
  "payroll-labor",
  "customers",
  "services",
  "taxes",
  "vendor-spending",
] as const;
export type ReportArea = (typeof REPORT_AREAS)[number];

export const REPORT_AREA_LABELS: Record<ReportArea, string> = {
  overview: "Overview",
  "profit-loss": "Profit & Loss",
  revenue: "Revenue",
  expenses: "Expenses",
  "job-profitability": "Job Profitability",
  "payroll-labor": "Payroll & Labor",
  customers: "Customers",
  services: "Services",
  taxes: "Taxes / Records",
  "vendor-spending": "Vendor Spending",
};

export const EXPENSE_UNAVAILABLE_AREAS = ["expenses", "vendor-spending"] as const;
export type ExpenseUnavailableArea = (typeof EXPENSE_UNAVAILABLE_AREAS)[number];

export const EXPENSE_UNAVAILABLE_MESSAGE = "Expense data not yet connected to Reports.";

export const PROFIT_LOSS_INCOMPLETE_MESSAGE =
  "Profit & Loss is incomplete. Expense records are not yet connected, so TBBT cannot calculate net profit.";

export const TAX_DISCLAIMER =
  "TBBT is not calculating or filing taxes in this module. The records below are what TBBT actually holds so you can export them for your own bookkeeping.";

export const JOB_MARGIN_LABEL = "Margin before recorded expenses";

export const DATE_PRESETS = [
  "30d",
  "90d",
  "month",
  "last-month",
  "year",
  "last-year",
  "custom",
  "all",
] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  month: "This month",
  "last-month": "Last month",
  year: "This year",
  "last-year": "Last year",
  custom: "Custom range",
  all: "All time",
};

export type ReportDateRange = {
  start: Date | null;
  end: Date | null;
  preset: DatePreset;
  comparable: boolean;
  prior: { start: Date; end: Date } | null;
  label: string;
};

export function isReportArea(value: string | undefined): value is ReportArea {
  return (REPORT_AREAS as readonly string[]).includes(value ?? "");
}

export function parseReportArea(raw: string | undefined): ReportArea {
  return isReportArea(raw) ? raw : "overview";
}

export function isDatePreset(value: string | undefined): value is DatePreset {
  return (DATE_PRESETS as readonly string[]).includes(value ?? "");
}

export function parseDatePreset(raw: string | undefined): DatePreset {
  return isDatePreset(raw) ? raw : "month";
}

export function isExpenseUnavailableArea(area: ReportArea): area is ExpenseUnavailableArea {
  return (EXPENSE_UNAVAILABLE_AREAS as readonly string[]).includes(area);
}

/**
 * Strict yyyy-mm-dd parse. Invalid or missing values return null --
 * never Date's normalizing constructor (2026-02-30 must not become March 2).
 */
export function parseReportDate(raw: string | undefined): Date | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [year, month, day] = raw.split("-").map(Number);
  const candidate = new Date(year, month - 1, day);
  if (
    candidate.getFullYear() !== year ||
    candidate.getMonth() !== month - 1 ||
    candidate.getDate() !== day
  ) {
    return null;
  }
  return startOfDay(candidate);
}

export function inRange(date: Date | null | undefined, range: { start: Date | null; end: Date | null }): boolean {
  if (!date) return false;
  if (range.start && date < range.start) return false;
  if (range.end && date >= range.end) return false;
  return true;
}

export function rangesOverlap(
  a: { start: Date; end: Date },
  b: { start: Date | null; end: Date | null },
): boolean {
  const bStart = b.start ?? new Date(0);
  const bEnd = b.end ?? new Date(8640000000000000);
  return a.start < bEnd && bStart < a.end;
}

/**
 * Half-open [start, end). "All time" has null bounds and is not
 * comparable -- there is no clean prior equivalent period.
 */
export function resolveReportRange(
  preset: DatePreset,
  fromRaw: string | undefined,
  toRaw: string | undefined,
  now: Date = new Date(),
): ReportDateRange {
  const today = startOfDay(now);

  if (preset === "all") {
    return {
      start: null,
      end: null,
      preset,
      comparable: false,
      prior: null,
      label: DATE_PRESET_LABELS.all,
    };
  }

  if (preset === "custom") {
    const from = parseReportDate(fromRaw);
    const toInclusive = parseReportDate(toRaw);
    if (!from || !toInclusive || toInclusive < from) {
      return resolveReportRange("month", undefined, undefined, now);
    }
    const end = addDays(toInclusive, 1);
    const durationMs = end.getTime() - from.getTime();
    return {
      start: from,
      end,
      preset,
      comparable: true,
      prior: { start: new Date(from.getTime() - durationMs), end: from },
      label: `${formatISODate(from)} – ${formatISODate(toInclusive)}`,
    };
  }

  let start: Date;
  let end: Date;
  if (preset === "30d") {
    end = addDays(today, 1);
    start = addDays(end, -30);
  } else if (preset === "90d") {
    end = addDays(today, 1);
    start = addDays(end, -90);
  } else if (preset === "month") {
    start = startOfMonth(today);
    end = addMonths(start, 1);
  } else if (preset === "last-month") {
    end = startOfMonth(today);
    start = addMonths(end, -1);
  } else if (preset === "year") {
    start = new Date(today.getFullYear(), 0, 1);
    end = new Date(today.getFullYear() + 1, 0, 1);
  } else {
    start = new Date(today.getFullYear() - 1, 0, 1);
    end = new Date(today.getFullYear(), 0, 1);
  }

  const durationMs = end.getTime() - start.getTime();
  const lastInclusive = addDays(end, -1);
  return {
    start,
    end,
    preset,
    comparable: true,
    prior: { start: new Date(start.getTime() - durationMs), end: start },
    label: `${formatISODate(start)} – ${formatISODate(lastInclusive)}`,
  };
}

/**
 * Prior-period change. Returns null when the comparison cannot be
 * calculated cleanly -- including a zero prior value, which would
 * otherwise invent +Infinity%.
 */
export function percentChange(current: number, prior: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(prior)) return null;
  if (prior === 0) return null;
  return roundMoney(((current - prior) / prior) * 100);
}

export function asNumber(value: { toString(): string } | number | null | undefined): number {
  if (value == null) return 0;
  const amount = typeof value === "number" ? value : Number(value.toString());
  return Number.isFinite(amount) ? amount : 0;
}

export function asNumberOrNull(
  value: { toString(): string } | number | null | undefined,
): number | null {
  if (value == null) return null;
  const amount = typeof value === "number" ? value : Number(value.toString());
  return Number.isFinite(amount) ? amount : null;
}

export type ReportInvoice = {
  id: string;
  businessId: string;
  status: string;
  total: number;
  paidAt: Date | null;
  createdAt: Date;
  customerId: string | null;
  jobId: string | null;
  paymentMethod: string | null;
  paymentReference: string | null;
};

export type ReportCustomer = {
  id: string;
  name: string;
  createdAt: Date;
};

export type ReportJob = {
  id: string;
  status: string;
  createdAt: Date;
  customerId: string | null;
  estimateId: string | null;
};

export type ReportEstimate = {
  id: string;
  status: string;
  total: number;
  createdAt: Date;
  customerId: string | null;
  serviceRequestId: string | null;
};

export type ReportServiceRequest = {
  id: string;
  serviceCatalogItemId: string | null;
  createdAt: Date;
  status: string;
};

export type ReportCatalogItem = {
  id: string;
  name: string;
};

export type ReportEstimateLineItem = {
  estimateId: string;
  serviceCatalogItemId: string | null;
  total: number;
};

export type ReportTimeEntry = {
  id: string;
  membershipId: string;
  jobId: string | null;
  activityType: string;
  startedAt: Date;
  approvedHours: number | null;
  approvedLaborCost: number | null;
};

export type ReportPayrollRun = {
  id: string;
  status: string;
  payPeriodStart: Date;
  payPeriodEnd: Date;
  authorizedApprovedHours: number | null;
  authorizedGrossLaborAmount: number | null;
  authorizedWorkerCount: number | null;
  authorizedAt: Date | null;
  processedAt: Date | null;
};

export type ReportMembership = {
  id: string;
  role: string;
  active: boolean;
  userName: string;
};

export type ReportSource = {
  businessId: string;
  invoices: ReportInvoice[];
  customers: ReportCustomer[];
  jobs: ReportJob[];
  estimates: ReportEstimate[];
  serviceRequests: ReportServiceRequest[];
  catalogItems: ReportCatalogItem[];
  estimateLineItems: ReportEstimateLineItem[];
  approvedTimeEntries: ReportTimeEntry[];
  payrollRuns: ReportPayrollRun[];
  memberships: ReportMembership[];
};

export function paidInvoicesInRange(invoices: readonly ReportInvoice[], range: { start: Date | null; end: Date | null }) {
  return invoices.filter(
    (invoice) => invoice.status === "PAID" && invoice.paidAt != null && inRange(invoice.paidAt, range),
  );
}

export function issuedInvoicesInRange(
  invoices: readonly ReportInvoice[],
  range: { start: Date | null; end: Date | null },
) {
  return invoices.filter(
    (invoice) =>
      (invoice.status === "SENT" || invoice.status === "PAID") && inRange(invoice.createdAt, range),
  );
}

export function outstandingInvoices(invoices: readonly ReportInvoice[]) {
  return invoices.filter((invoice) => invoice.status === "SENT");
}

export function sumTotals(invoices: readonly { total: number }[]): number {
  return roundMoney(invoices.reduce((sum, invoice) => sum + invoice.total, 0));
}

export function averageInvoiceValue(invoices: readonly { total: number }[]): number | null {
  if (invoices.length === 0) return null;
  return roundMoney(sumTotals(invoices) / invoices.length);
}

export type LaborRollup = {
  approvedHours: number;
  laborCost: number | null;
  laborCostIncomplete: boolean;
  entryCount: number;
};

export function rollupApprovedLabor(entries: readonly ReportTimeEntry[]): LaborRollup {
  let approvedHours = 0;
  let laborCost = 0;
  let laborCostIncomplete = false;
  let sawCost = false;
  for (const entry of entries) {
    approvedHours += entry.approvedHours ?? 0;
    if (!isPaidActivity(entry.activityType)) continue;
    if (entry.approvedLaborCost == null) {
      laborCostIncomplete = true;
    } else {
      laborCost += entry.approvedLaborCost;
      sawCost = true;
    }
  }
  return {
    approvedHours: roundHours(approvedHours),
    laborCost: sawCost ? roundMoney(laborCost) : laborCostIncomplete ? null : 0,
    laborCostIncomplete,
    entryCount: entries.length,
  };
}

/**
 * Attribute a job to one catalog service only when the relationship is
 * unambiguous: the linked request's selected catalog item, or exactly
 * one distinct catalog id on the estimate's line items. Never split an
 * invoice total across multiple services.
 */
export function catalogIdForEstimate(
  estimateId: string | null | undefined,
  source: Pick<ReportSource, "estimates" | "serviceRequests" | "estimateLineItems">,
): string | null {
  if (!estimateId) return null;
  const estimate = source.estimates.find((row) => row.id === estimateId);
  if (estimate?.serviceRequestId) {
    const request = source.serviceRequests.find((row) => row.id === estimate.serviceRequestId);
    if (request?.serviceCatalogItemId) return request.serviceCatalogItemId;
  }
  const ids = [
    ...new Set(
      source.estimateLineItems
        .filter((item) => item.estimateId === estimateId && item.serviceCatalogItemId)
        .map((item) => item.serviceCatalogItemId as string),
    ),
  ];
  return ids.length === 1 ? ids[0]! : null;
}

export function catalogIdForJob(
  job: Pick<ReportJob, "estimateId">,
  source: Pick<ReportSource, "estimates" | "serviceRequests" | "estimateLineItems">,
): string | null {
  return catalogIdForEstimate(job.estimateId, source);
}

export type ChangeStat = {
  current: number;
  prior: number | null;
  changePercent: number | null;
};

function changeStat(current: number, prior: number | null, comparable: boolean): ChangeStat {
  if (!comparable || prior == null) {
    return { current, prior: null, changePercent: null };
  }
  return { current, prior, changePercent: percentChange(current, prior) };
}

export type AttentionItem = {
  key: string;
  label: string;
  detail: string;
  href: string;
};

export type NamedAmount = {
  id: string;
  name: string;
  amount: number;
  count: number;
  href: string;
};

export type TimePoint = {
  key: string;
  label: string;
  amount: number;
};

export type JobProfitRow = {
  jobId: string;
  customerName: string;
  status: string;
  paidRevenue: number;
  outstanding: number;
  approvedHours: number;
  laborCost: number | null;
  laborCostIncomplete: boolean;
  marginBeforeExpenses: number | null;
  href: string;
};

export type WorkerLaborRow = {
  membershipId: string;
  workerName: string;
  approvedHours: number;
  laborCost: number | null;
  laborCostIncomplete: boolean;
  jobCount: number;
};

export type ServiceRow = {
  catalogItemId: string | null;
  name: string;
  requested: number;
  estimated: number;
  completed: number;
  revenue: number | null;
  revenueAttributed: boolean;
};

export type TaxRecordRow = {
  kind: "invoice" | "payroll";
  id: string;
  dateLabel: string;
  description: string;
  amount: number | null;
  extra: string;
  href: string;
};

export type BuiltReport = {
  range: ReportDateRange;
  paidRevenue: ChangeStat;
  outstanding: { current: number; count: number };
  issuedInvoiceCount: ChangeStat;
  averageIssuedInvoice: number | null;
  completedJobsOpened: ChangeStat;
  labor: LaborRollup;
  priorLabor: LaborRollup | null;
  laborCostChange: number | null;
  customerCount: number;
  newCustomers: ChangeStat;
  repeatCustomers: number;
  profitLoss: {
    revenue: number;
    laborCost: number | null;
    laborCostIncomplete: boolean;
    expensesAvailable: false;
    expenses: null;
    netProfit: null;
    incomplete: true;
    message: string;
  };
  revenueByDay: TimePoint[];
  revenueByCustomer: NamedAmount[];
  revenueByJob: NamedAmount[];
  revenueByService: NamedAmount[];
  invoices: Array<
    ReportInvoice & {
      customerName: string;
      jobLabel: string | null;
    }
  >;
  jobProfitability: JobProfitRow[];
  workerLabor: WorkerLaborRow[];
  payrollRuns: Array<
    ReportPayrollRun & {
      hours: number | null;
      gross: number | null;
      periodLabel: string;
    }
  >;
  customers: Array<{
    id: string;
    name: string;
    createdAt: Date;
    isNew: boolean;
    paidRevenue: number;
    completedJobs: number;
    isRepeat: boolean;
    href: string;
  }>;
  services: ServiceRow[];
  taxRecords: TaxRecordRow[];
  attention: AttentionItem[];
  expenseUnavailableMessage: string;
  taxDisclaimer: string;
  jobMarginLabel: string;
};

function catalogName(id: string | null, source: ReportSource): string {
  if (!id) return "Unattributed";
  return source.catalogItems.find((item) => item.id === id)?.name ?? "Unattributed";
}

function customerName(id: string | null, source: ReportSource): string {
  if (!id) return "Customer";
  return source.customers.find((row) => row.id === id)?.name ?? "Customer";
}

function bucketGrain(range: ReportDateRange): "day" | "week" | "month" {
  if (!range.start || !range.end) return "month";
  const days = (range.end.getTime() - range.start.getTime()) / 86_400_000;
  if (days <= 45) return "day";
  if (days <= 180) return "week";
  return "month";
}

function bucketStart(date: Date, grain: "day" | "week" | "month"): Date {
  if (grain === "day") return startOfDay(date);
  if (grain === "week") return startOfWeek(date);
  return startOfMonth(date);
}

function bucketLabel(date: Date, grain: "day" | "week" | "month"): string {
  if (grain === "day") {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  if (grain === "week") {
    return `Week of ${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  }
  return date.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

export function revenueTimeSeries(invoices: readonly ReportInvoice[], range: ReportDateRange): TimePoint[] {
  const paid = paidInvoicesInRange(invoices, range);
  const grain = bucketGrain(range);
  const buckets = new Map<number, TimePoint>();
  for (const invoice of paid) {
    const start = bucketStart(invoice.paidAt as Date, grain);
    const key = start.getTime();
    const existing = buckets.get(key);
    if (existing) {
      existing.amount = roundMoney(existing.amount + invoice.total);
    } else {
      buckets.set(key, {
        key: formatISODate(start),
        label: bucketLabel(start, grain),
        amount: roundMoney(invoice.total),
      });
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, point]) => point);
}

export function buildReport(source: ReportSource, range: ReportDateRange): BuiltReport {
  const priorRange = range.prior;
  const comparable = range.comparable && priorRange != null;

  const paid = paidInvoicesInRange(source.invoices, range);
  const priorPaid = priorRange ? paidInvoicesInRange(source.invoices, priorRange) : [];
  const issued = issuedInvoicesInRange(source.invoices, range);
  const priorIssued = priorRange ? issuedInvoicesInRange(source.invoices, priorRange) : [];
  const outstanding = outstandingInvoices(source.invoices);

  const laborEntries = source.approvedTimeEntries.filter((entry) => inRange(entry.startedAt, range));
  const priorLaborEntries = priorRange
    ? source.approvedTimeEntries.filter((entry) => inRange(entry.startedAt, priorRange))
    : [];
  const labor = rollupApprovedLabor(laborEntries);
  const priorLabor = priorRange ? rollupApprovedLabor(priorLaborEntries) : null;

  const completedOpened = source.jobs.filter(
    (job) => job.status === "COMPLETED" && inRange(job.createdAt, range),
  );
  const priorCompletedOpened = priorRange
    ? source.jobs.filter((job) => job.status === "COMPLETED" && inRange(job.createdAt, priorRange))
    : [];

  const newCustomers = source.customers.filter((customer) => inRange(customer.createdAt, range));
  const priorNewCustomers = priorRange
    ? source.customers.filter((customer) => inRange(customer.createdAt, priorRange))
    : [];

  const completedByCustomer = new Map<string, number>();
  for (const job of source.jobs) {
    if (job.status !== "COMPLETED" || !job.customerId) continue;
    completedByCustomer.set(job.customerId, (completedByCustomer.get(job.customerId) ?? 0) + 1);
  }
  const paidByCustomerAll = new Map<string, number>();
  for (const invoice of source.invoices) {
    if (invoice.status !== "PAID" || !invoice.customerId) continue;
    paidByCustomerAll.set(invoice.customerId, (paidByCustomerAll.get(invoice.customerId) ?? 0) + 1);
  }
  const repeatCustomers = source.customers.filter((customer) => {
    const jobs = completedByCustomer.get(customer.id) ?? 0;
    const invoices = paidByCustomerAll.get(customer.id) ?? 0;
    return jobs > 1 || invoices > 1;
  }).length;

  const paidRevenue = sumTotals(paid);
  const laborCostChange =
    comparable && priorLabor && labor.laborCost != null && priorLabor.laborCost != null
      ? percentChange(labor.laborCost, priorLabor.laborCost)
      : null;

  const jobById = new Map(source.jobs.map((job) => [job.id, job]));
  const invoicesEnriched = [...source.invoices]
    .filter((invoice) => {
      if (invoice.status === "PAID") return invoice.paidAt != null && inRange(invoice.paidAt, range);
      return inRange(invoice.createdAt, range);
    })
    .sort((a, b) => {
      const aDate = a.paidAt ?? a.createdAt;
      const bDate = b.paidAt ?? b.createdAt;
      return bDate.getTime() - aDate.getTime();
    })
    .map((invoice) => ({
      ...invoice,
      customerName: customerName(invoice.customerId, source),
      jobLabel: invoice.jobId ? `Job ${invoice.jobId.slice(-6)}` : null,
    }));

  const revenueByCustomerMap = new Map<string, NamedAmount>();
  for (const invoice of paid) {
    const id = invoice.customerId ?? "unknown";
    const existing = revenueByCustomerMap.get(id);
    if (existing) {
      existing.amount = roundMoney(existing.amount + invoice.total);
      existing.count += 1;
    } else {
      revenueByCustomerMap.set(id, {
        id,
        name: customerName(invoice.customerId, source),
        amount: roundMoney(invoice.total),
        count: 1,
        href: invoice.customerId ? `/customers/${invoice.customerId}` : "/customers",
      });
    }
  }

  const revenueByJobMap = new Map<string, NamedAmount>();
  for (const invoice of paid) {
    if (!invoice.jobId) continue;
    const existing = revenueByJobMap.get(invoice.jobId);
    if (existing) {
      existing.amount = roundMoney(existing.amount + invoice.total);
      existing.count += 1;
    } else {
      revenueByJobMap.set(invoice.jobId, {
        id: invoice.jobId,
        name: customerName(invoice.customerId, source),
        amount: roundMoney(invoice.total),
        count: 1,
        href: `/jobs/${invoice.jobId}`,
      });
    }
  }

  const revenueByServiceMap = new Map<string, NamedAmount>();
  for (const invoice of paid) {
    const job = invoice.jobId ? jobById.get(invoice.jobId) : undefined;
    const catalogId = job ? catalogIdForJob(job, source) : null;
    if (!catalogId) continue;
    const existing = revenueByServiceMap.get(catalogId);
    if (existing) {
      existing.amount = roundMoney(existing.amount + invoice.total);
      existing.count += 1;
    } else {
      revenueByServiceMap.set(catalogId, {
        id: catalogId,
        name: catalogName(catalogId, source),
        amount: roundMoney(invoice.total),
        count: 1,
        href: "/services",
      });
    }
  }

  const jobIds = new Set<string>();
  for (const job of source.jobs) jobIds.add(job.id);
  for (const invoice of source.invoices) {
    if (invoice.jobId) jobIds.add(invoice.jobId);
  }
  for (const entry of laborEntries) {
    if (entry.jobId) jobIds.add(entry.jobId);
  }

  const jobProfitability: JobProfitRow[] = [...jobIds]
    .map((jobId) => {
      const job = jobById.get(jobId);
      const jobInvoices = source.invoices.filter((invoice) => invoice.jobId === jobId);
      const paidRevenueForJob = sumTotals(jobInvoices.filter((invoice) => invoice.status === "PAID"));
      const outstandingForJob = sumTotals(jobInvoices.filter((invoice) => invoice.status === "SENT"));
      const jobLabor = rollupApprovedLabor(laborEntries.filter((entry) => entry.jobId === jobId));
      const hasPeriodSignal =
        jobInvoices.some(
          (invoice) =>
            (invoice.status === "PAID" && invoice.paidAt != null && inRange(invoice.paidAt, range)) ||
            inRange(invoice.createdAt, range),
        ) ||
        laborEntries.some((entry) => entry.jobId === jobId) ||
        Boolean(job && job.status === "COMPLETED" && inRange(job.createdAt, range));
      if (!hasPeriodSignal) return null;
      const margin =
        jobLabor.laborCost != null && !jobLabor.laborCostIncomplete
          ? roundMoney(paidRevenueForJob - jobLabor.laborCost)
          : null;
      return {
        jobId,
        customerName: customerName(job?.customerId ?? jobInvoices[0]?.customerId ?? null, source),
        status: job?.status ?? "UNKNOWN",
        paidRevenue: paidRevenueForJob,
        outstanding: outstandingForJob,
        approvedHours: jobLabor.approvedHours,
        laborCost: jobLabor.laborCost,
        laborCostIncomplete: jobLabor.laborCostIncomplete,
        marginBeforeExpenses: margin,
        href: `/jobs/${jobId}`,
      } satisfies JobProfitRow;
    })
    .filter((row): row is JobProfitRow => row != null)
    .sort((a, b) => b.paidRevenue - a.paidRevenue);

  const workerMap = new Map<string, WorkerLaborRow>();
  for (const entry of laborEntries) {
    const membership = source.memberships.find((row) => row.id === entry.membershipId);
    const existing = workerMap.get(entry.membershipId);
    const addCost = entry.approvedLaborCost;
    if (existing) {
      existing.approvedHours = roundHours(existing.approvedHours + (entry.approvedHours ?? 0));
      if (addCost == null && isPaidActivity(entry.activityType)) {
        existing.laborCostIncomplete = true;
      } else if (addCost != null) {
        existing.laborCost = roundMoney((existing.laborCost ?? 0) + addCost);
      }
      if (entry.jobId) existing.jobCount += 1;
    } else {
      const incomplete = isPaidActivity(entry.activityType) && addCost == null;
      workerMap.set(entry.membershipId, {
        membershipId: entry.membershipId,
        workerName: membership?.userName ?? "Worker",
        approvedHours: roundHours(entry.approvedHours ?? 0),
        laborCost: addCost,
        laborCostIncomplete: incomplete,
        jobCount: entry.jobId ? 1 : 0,
      });
    }
  }

  const recordedPayroll = source.payrollRuns.filter(
    (run) =>
      (run.status === "AUTHORIZED" || run.status === "PROCESSED") &&
      rangesOverlap({ start: run.payPeriodStart, end: run.payPeriodEnd }, range),
  );

  const customers = source.customers
    .map((customer) => {
      const paidRevenueForCustomer = sumTotals(
        paid.filter((invoice) => invoice.customerId === customer.id),
      );
      const completedJobs = source.jobs.filter(
        (job) => job.customerId === customer.id && job.status === "COMPLETED",
      ).length;
      const paidInvoiceCount = source.invoices.filter(
        (invoice) => invoice.customerId === customer.id && invoice.status === "PAID",
      ).length;
      const isNew = inRange(customer.createdAt, range);
      const hasPeriodSignal = isNew || paidRevenueForCustomer > 0 || completedJobs > 0;
      if (!hasPeriodSignal && range.start) return null;
      return {
        id: customer.id,
        name: customer.name,
        createdAt: customer.createdAt,
        isNew,
        paidRevenue: paidRevenueForCustomer,
        completedJobs,
        isRepeat: completedJobs > 1 || paidInvoiceCount > 1,
        href: `/customers/${customer.id}`,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row != null)
    .sort((a, b) => b.paidRevenue - a.paidRevenue || a.name.localeCompare(b.name));

  const serviceIds = new Set<string | null>();
  for (const item of source.catalogItems) serviceIds.add(item.id);
  for (const request of source.serviceRequests) serviceIds.add(request.serviceCatalogItemId);
  serviceIds.add(null);

  const services: ServiceRow[] = [...serviceIds]
    .map((catalogItemId) => {
      const requested = source.serviceRequests.filter((request) => {
        const id = request.serviceCatalogItemId;
        return (id ?? null) === catalogItemId && inRange(request.createdAt, range);
      }).length;
      const estimated = source.estimates.filter((estimate) => {
        if (estimate.status !== "APPROVED" && estimate.status !== "SENT") return false;
        if (!inRange(estimate.createdAt, range)) return false;
        return catalogIdForEstimate(estimate.id, source) === catalogItemId;
      }).length;
      const completed = source.jobs.filter((job) => {
        if (job.status !== "COMPLETED") return false;
        if (!inRange(job.createdAt, range)) return false;
        return catalogIdForJob(job, source) === catalogItemId;
      }).length;
      const attributedPaid = paid.filter((invoice) => {
        const job = invoice.jobId ? jobById.get(invoice.jobId) : undefined;
        if (!job) return false;
        return catalogIdForJob(job, source) === catalogItemId;
      });
      const hasAttribution = catalogItemId != null;
      const hasSignal = requested + estimated + completed + attributedPaid.length > 0;
      if (!hasSignal) return null;
      return {
        catalogItemId,
        name: catalogName(catalogItemId, source),
        requested,
        estimated,
        completed,
        revenue: hasAttribution ? sumTotals(attributedPaid) : null,
        revenueAttributed: hasAttribution,
      } satisfies ServiceRow;
    })
    .filter((row): row is ServiceRow => row != null)
    .sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0) || b.requested - a.requested);

  const taxRecords: TaxRecordRow[] = [
    ...paid.map((invoice) => ({
      kind: "invoice" as const,
      id: invoice.id,
      dateLabel: invoice.paidAt ? formatISODate(invoice.paidAt) : formatISODate(invoice.createdAt),
      description: `Paid invoice · ${customerName(invoice.customerId, source)}`,
      amount: invoice.total,
      extra: [paymentMethodLabel(invoice.paymentMethod), invoice.paymentReference]
        .filter(Boolean)
        .join(" · "),
      href: `/invoices/${invoice.id}`,
    })),
    ...recordedPayroll.map((run) => ({
      kind: "payroll" as const,
      id: run.id,
      dateLabel: formatISODate(run.authorizedAt ?? run.payPeriodStart),
      description: `Payroll ${run.status === "PROCESSED" ? "processed" : "authorized"}`,
      amount: run.authorizedGrossLaborAmount,
      extra: `${run.authorizedWorkerCount ?? 0} workers · ${run.authorizedApprovedHours ?? 0} approved hours`,
      href: `/payroll?run=${run.id}`,
    })),
  ].sort((a, b) => b.dateLabel.localeCompare(a.dateLabel));

  const attention: AttentionItem[] = [];
  for (const invoice of outstanding) {
    attention.push({
      key: `invoice:${invoice.id}`,
      label: customerName(invoice.customerId, source),
      detail: `Sent invoice outstanding · ${invoice.total.toFixed(2)}`,
      href: `/invoices/${invoice.id}`,
    });
  }
  for (const job of source.jobs) {
    if (job.status !== "COMPLETED") continue;
    const hasInvoice = source.invoices.some((invoice) => invoice.jobId === job.id);
    if (!hasInvoice) {
      attention.push({
        key: `job-unbilled:${job.id}`,
        label: customerName(job.customerId, source),
        detail: "Completed job has no invoice",
        href: `/jobs/${job.id}`,
      });
    }
  }
  for (const entry of laborEntries) {
    if (!isPaidActivity(entry.activityType)) continue;
    if (entry.approvedLaborCost != null) continue;
    const worker = source.memberships.find((row) => row.id === entry.membershipId);
    attention.push({
      key: `wage:${entry.id}`,
      label: worker?.userName ?? "Worker",
      detail: "Approved time has no wage snapshot — labor cost omitted",
      href: "/time-cards",
    });
  }

  return {
    range,
    paidRevenue: changeStat(paidRevenue, comparable ? sumTotals(priorPaid) : null, comparable),
    outstanding: { current: sumTotals(outstanding), count: outstanding.length },
    issuedInvoiceCount: changeStat(issued.length, comparable ? priorIssued.length : null, comparable),
    averageIssuedInvoice: averageInvoiceValue(issued),
    completedJobsOpened: changeStat(
      completedOpened.length,
      comparable ? priorCompletedOpened.length : null,
      comparable,
    ),
    labor,
    priorLabor,
    laborCostChange,
    customerCount: source.customers.length,
    newCustomers: changeStat(newCustomers.length, comparable ? priorNewCustomers.length : null, comparable),
    repeatCustomers,
    profitLoss: {
      revenue: paidRevenue,
      laborCost: labor.laborCost,
      laborCostIncomplete: labor.laborCostIncomplete,
      expensesAvailable: false,
      expenses: null,
      netProfit: null,
      incomplete: true,
      message: PROFIT_LOSS_INCOMPLETE_MESSAGE,
    },
    revenueByDay: revenueTimeSeries(source.invoices, range),
    revenueByCustomer: [...revenueByCustomerMap.values()].sort((a, b) => b.amount - a.amount),
    revenueByJob: [...revenueByJobMap.values()].sort((a, b) => b.amount - a.amount),
    revenueByService: [...revenueByServiceMap.values()].sort((a, b) => b.amount - a.amount),
    invoices: invoicesEnriched,
    jobProfitability,
    workerLabor: [...workerMap.values()].sort((a, b) => b.approvedHours - a.approvedHours),
    payrollRuns: recordedPayroll.map((run) => ({
      ...run,
      hours: run.authorizedApprovedHours,
      gross: run.authorizedGrossLaborAmount,
      periodLabel: `${formatISODate(run.payPeriodStart)} – ${formatISODate(addDays(run.payPeriodEnd, -1))}`,
    })),
    customers,
    services,
    taxRecords,
    attention,
    expenseUnavailableMessage: EXPENSE_UNAVAILABLE_MESSAGE,
    taxDisclaimer: TAX_DISCLAIMER,
    jobMarginLabel: JOB_MARGIN_LABEL,
  };
}

export function reportCsvRows(area: ReportArea, report: BuiltReport): { headers: string[]; rows: string[][] } {
  if (area === "expenses" || area === "vendor-spending") {
    return { headers: ["Status"], rows: [[EXPENSE_UNAVAILABLE_MESSAGE]] };
  }
  if (area === "profit-loss") {
    return {
      headers: ["Line", "Amount", "Notes"],
      rows: [
        ["Paid revenue", String(report.profitLoss.revenue), "Paid invoices"],
        [
          "Approved labor cost",
          report.profitLoss.laborCost == null ? "" : String(report.profitLoss.laborCost),
          report.profitLoss.laborCostIncomplete ? "Incomplete — missing wage snapshots" : "Approved Time Cards",
        ],
        ["Expenses", "", EXPENSE_UNAVAILABLE_MESSAGE],
        ["Net profit", "", PROFIT_LOSS_INCOMPLETE_MESSAGE],
      ],
    };
  }
  if (area === "revenue" || area === "overview") {
    return {
      headers: ["Invoice", "Status", "Customer", "Total", "Paid at", "Created"],
      rows: report.invoices.map((invoice) => [
        invoice.id,
        invoice.status,
        invoice.customerName,
        String(invoice.total),
        invoice.paidAt ? formatISODate(invoice.paidAt) : "",
        formatISODate(invoice.createdAt),
      ]),
    };
  }
  if (area === "job-profitability") {
    return {
      headers: ["Job", "Customer", "Status", "Paid revenue", "Approved hours", "Labor cost", JOB_MARGIN_LABEL],
      rows: report.jobProfitability.map((row) => [
        row.jobId,
        row.customerName,
        row.status,
        String(row.paidRevenue),
        String(row.approvedHours),
        row.laborCost == null ? "" : String(row.laborCost),
        row.marginBeforeExpenses == null ? "" : String(row.marginBeforeExpenses),
      ]),
    };
  }
  if (area === "payroll-labor") {
    return {
      headers: ["Worker", "Approved hours", "Labor cost"],
      rows: report.workerLabor.map((row) => [
        row.workerName,
        String(row.approvedHours),
        row.laborCost == null ? "" : String(row.laborCost),
      ]),
    };
  }
  if (area === "customers") {
    return {
      headers: ["Customer", "New", "Repeat", "Paid revenue", "Completed jobs"],
      rows: report.customers.map((row) => [
        row.name,
        row.isNew ? "yes" : "no",
        row.isRepeat ? "yes" : "no",
        String(row.paidRevenue),
        String(row.completedJobs),
      ]),
    };
  }
  if (area === "services") {
    return {
      headers: ["Service", "Requested", "Estimated", "Completed", "Attributed revenue"],
      rows: report.services.map((row) => [
        row.name,
        String(row.requested),
        String(row.estimated),
        String(row.completed),
        row.revenue == null ? "unattributed" : String(row.revenue),
      ]),
    };
  }
  return {
    headers: ["Kind", "Date", "Description", "Amount", "Detail"],
    rows: report.taxRecords.map((row) => [
      row.kind,
      row.dateLabel,
      row.description,
      row.amount == null ? "" : String(row.amount),
      row.extra,
    ]),
  };
}

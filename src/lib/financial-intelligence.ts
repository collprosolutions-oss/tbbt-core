/**
 * Financial intelligence over recorded TBBT invoices, expenses, labor,
 * estimates, and jobs. Never fabricates bank balances or tax conclusions.
 */

import { catalogIdForJob, inRange, type BuiltReport, type ReportSource } from "@/lib/reports";
import { isPaidActivity, roundMoney } from "@/lib/time-cards";

export const BANK_NOT_CONNECTED_MESSAGE =
  "Banking is Not Connected. TBBT will not invent a cash balance.";

export const ACCOUNTING_NOT_CONNECTED_MESSAGE =
  "Accounting is Not Connected. These figures are TBBT-recorded only.";

export const CASH_FLOW_RECORDED_ONLY_MESSAGE =
  "Cash-flow projection uses only recorded future inflows and outflows. No bank balance is assumed.";

export type ServiceProfitRow = {
  catalogItemId: string | null;
  name: string;
  revenue: number | null;
  laborCost: number | null;
  jobExpense: number | null;
  recordedMargin: number | null;
  jobCount: number;
  attributed: boolean;
};

export type JobMarginPoint = {
  key: string;
  label: string;
  jobCount: number;
  paidRevenue: number;
  recordedMargin: number | null;
};

export type EstimateConversion = {
  sent: number;
  approved: number;
  conversionRate: number | null;
};

export type CustomerLifetimeRow = {
  customerId: string;
  name: string;
  paidRevenue: number;
  paidInvoiceCount: number;
  completedJobs: number;
  isRepeat: boolean;
  href: string;
};

export type KnownCashFlow = {
  bankConnected: false;
  projectedBalance: null;
  knownInflows: number;
  knownOutflows: number;
  netKnown: number;
  inflowCount: number;
  outflowCount: number;
  message: string;
};

export type FinancialIntelligence = {
  averageTicket: number | null;
  estimateConversion: EstimateConversion;
  serviceProfitability: ServiceProfitRow[];
  jobMarginTrend: JobMarginPoint[];
  laborCostTrend: JobMarginPoint[];
  vendorSpend: Array<{ name: string; amount: number; count: number }>;
  recurringExpenses: Array<{
    id: string;
    description: string;
    amount: number;
    vendor: string | null;
    href: string;
  }>;
  outstandingReceivables: { amount: number; count: number };
  customerLifetime: CustomerLifetimeRow[];
  cashFlow: KnownCashFlow;
  bankConnected: false;
  accountingConnected: false;
  messages: {
    bank: string;
    accounting: string;
    cashFlow: string;
  };
};

function monthKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function estimateConversionFromSource(
  estimates: readonly { status: string; createdAt: Date }[],
  range: { start: Date | null; end: Date | null },
): EstimateConversion {
  const inPeriod = estimates.filter((row) => inRange(row.createdAt, range));
  const sent = inPeriod.filter((row) => row.status === "SENT" || row.status === "APPROVED").length;
  const approved = inPeriod.filter((row) => row.status === "APPROVED").length;
  return {
    sent,
    approved,
    conversionRate: sent > 0 ? Math.round((approved / sent) * 100) : null,
  };
}

export function buildServiceProfitability(
  source: Pick<
    ReportSource,
    | "catalogItems"
    | "jobs"
    | "invoices"
    | "expenses"
    | "approvedTimeEntries"
    | "estimates"
    | "serviceRequests"
    | "estimateLineItems"
  >,
  range: { start: Date | null; end: Date | null },
): ServiceProfitRow[] {
  const rows = new Map<string, ServiceProfitRow>();
  const unknown: ServiceProfitRow = {
    catalogItemId: null,
    name: "Unattributed",
    revenue: 0,
    laborCost: 0,
    jobExpense: 0,
    recordedMargin: 0,
    jobCount: 0,
    attributed: false,
  };

  function bucket(catalogId: string | null) {
    if (!catalogId) return unknown;
    const existing = rows.get(catalogId);
    if (existing) return existing;
    const catalog = source.catalogItems.find((item) => item.id === catalogId);
    const created: ServiceProfitRow = {
      catalogItemId: catalogId,
      name: catalog?.name ?? "Service",
      revenue: 0,
      laborCost: 0,
      jobExpense: 0,
      recordedMargin: 0,
      jobCount: 0,
      attributed: true,
    };
    rows.set(catalogId, created);
    return created;
  }

  for (const job of source.jobs) {
    const catalogId = catalogIdForJob(job, source);
    const row = bucket(catalogId);
    if (job.status === "COMPLETED" && inRange(job.createdAt, range)) {
      row.jobCount += 1;
    }
    const paid = source.invoices
      .filter((invoice) => invoice.jobId === job.id && invoice.status === "PAID" && inRange(invoice.paidAt, range))
      .reduce((sum, invoice) => sum + invoice.total, 0);
    const labor = source.approvedTimeEntries
      .filter(
        (entry) =>
          entry.jobId === job.id &&
          isPaidActivity(entry.activityType) &&
          inRange(entry.startedAt, range),
      )
      .reduce((sum, entry) => sum + (entry.approvedLaborCost ?? 0), 0);
    const expenses = source.expenses
      .filter((expense) => expense.jobId === job.id && inRange(expense.occurredOn, range))
      .reduce((sum, expense) => sum + expense.amount, 0);
    if (row.revenue != null) row.revenue = roundMoney(row.revenue + paid);
    if (row.laborCost != null) row.laborCost = roundMoney(row.laborCost + labor);
    if (row.jobExpense != null) row.jobExpense = roundMoney(row.jobExpense + expenses);
  }

  const all = [...rows.values(), unknown].filter(
    (row) => (row.revenue ?? 0) > 0 || (row.laborCost ?? 0) > 0 || (row.jobExpense ?? 0) > 0 || row.jobCount > 0,
  );
  for (const row of all) {
    if (row.revenue == null || row.laborCost == null || row.jobExpense == null) {
      row.recordedMargin = null;
    } else {
      row.recordedMargin = roundMoney(row.revenue - row.laborCost - row.jobExpense);
    }
  }
  return all.sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0));
}

export function buildJobMarginTrend(report: BuiltReport): JobMarginPoint[] {
  const buckets = new Map<string, JobMarginPoint>();
  for (const job of report.jobProfitability) {
    const key = monthKey(new Date());
    // Job profitability rows do not carry a date; use paid revenue presence
    // as a recorded snapshot for the current report range only.
    const existing = buckets.get(key) ?? {
      key,
      label: report.range.label,
      jobCount: 0,
      paidRevenue: 0,
      recordedMargin: 0,
    };
    existing.jobCount += 1;
    existing.paidRevenue = roundMoney(existing.paidRevenue + job.paidRevenue);
    if (job.recordedMargin == null) existing.recordedMargin = null;
    else if (existing.recordedMargin != null) {
      existing.recordedMargin = roundMoney(existing.recordedMargin + job.recordedMargin);
    }
    buckets.set(key, existing);
  }
  return [...buckets.values()];
}

export function buildKnownCashFlow(input: {
  outstandingInvoices: readonly { total: number }[];
  futureExpenses: readonly { amount: number }[];
  authorizedPayroll: readonly { authorizedGrossLaborAmount: number | null }[];
}): KnownCashFlow {
  const knownInflows = roundMoney(input.outstandingInvoices.reduce((sum, row) => sum + row.total, 0));
  const expenseOut = input.futureExpenses.reduce((sum, row) => sum + row.amount, 0);
  const payrollOut = input.authorizedPayroll.reduce(
    (sum, row) => sum + (row.authorizedGrossLaborAmount ?? 0),
    0,
  );
  const knownOutflows = roundMoney(expenseOut + payrollOut);
  return {
    bankConnected: false,
    projectedBalance: null,
    knownInflows,
    knownOutflows,
    netKnown: roundMoney(knownInflows - knownOutflows),
    inflowCount: input.outstandingInvoices.length,
    outflowCount: input.futureExpenses.length + input.authorizedPayroll.length,
    message: CASH_FLOW_RECORDED_ONLY_MESSAGE,
  };
}

export function buildCustomerLifetime(
  customers: readonly {
    id: string;
    name: string;
    createdAt: Date;
  }[],
  invoices: readonly {
    customerId: string | null;
    status: string;
    total: number;
  }[],
  jobs: readonly {
    customerId: string | null;
    status: string;
  }[],
): CustomerLifetimeRow[] {
  return customers
    .map((customer) => {
      const paid = invoices.filter(
        (invoice) => invoice.customerId === customer.id && invoice.status === "PAID",
      );
      const completed = jobs.filter(
        (job) => job.customerId === customer.id && job.status === "COMPLETED",
      ).length;
      const paidRevenue = roundMoney(paid.reduce((sum, invoice) => sum + invoice.total, 0));
      return {
        customerId: customer.id,
        name: customer.name,
        paidRevenue,
        paidInvoiceCount: paid.length,
        completedJobs: completed,
        isRepeat: completed > 1 || paid.length > 1,
        href: `/customers/${customer.id}`,
      };
    })
    .filter((row) => row.paidRevenue > 0 || row.completedJobs > 0)
    .sort((a, b) => b.paidRevenue - a.paidRevenue);
}

export function buildFinancialIntelligence(
  source: ReportSource,
  report: BuiltReport,
  now: Date = new Date(),
): FinancialIntelligence {
  const futureExpenses = source.expenses.filter((expense) => expense.occurredOn > now);
  const authorizedPayroll = source.payrollRuns.filter((run) => run.status === "AUTHORIZED");

  return {
    averageTicket: report.averageIssuedInvoice,
    estimateConversion: estimateConversionFromSource(source.estimates, report.range),
    serviceProfitability: buildServiceProfitability(source, report.range),
    jobMarginTrend: buildJobMarginTrend(report),
    laborCostTrend: [
      {
        key: "current",
        label: report.range.label,
        jobCount: report.labor.entryCount,
        paidRevenue: report.labor.laborCost ?? 0,
        recordedMargin: report.labor.laborCost,
      },
    ],
    vendorSpend: report.vendorSpending.map((row) => ({
      name: row.name,
      amount: row.amount,
      count: row.count,
    })),
    recurringExpenses: source.expenses
      .filter((expense) => expense.recurring)
      .map((expense) => ({
        id: expense.id,
        description: expense.description,
        amount: expense.amount,
        vendor: expense.vendor,
        href: "/expenses",
      })),
    outstandingReceivables: {
      amount: report.outstanding.current,
      count: report.outstanding.count,
    },
    customerLifetime: buildCustomerLifetime(source.customers, source.invoices, source.jobs),
    cashFlow: buildKnownCashFlow({
      outstandingInvoices: source.invoices.filter((invoice) => invoice.status === "SENT"),
      futureExpenses,
      authorizedPayroll,
    }),
    bankConnected: false,
    accountingConnected: false,
    messages: {
      bank: BANK_NOT_CONNECTED_MESSAGE,
      accounting: ACCOUNTING_NOT_CONNECTED_MESSAGE,
      cashFlow: CASH_FLOW_RECORDED_ONLY_MESSAGE,
    },
  };
}

export type BsosFinancialSignal = {
  key: string;
  kind: "fact";
  label: string;
  detail: string;
  href: string;
  priority: number;
};

export function managementReportCsvRows(intel: FinancialIntelligence): {
  headers: string[];
  rows: string[][];
} {
  return {
    headers: ["Section", "Metric", "Value", "Kind", "Notes"],
    rows: [
      ["Honesty", "Banking", intel.bankConnected ? "Connected" : "Not Connected", "fact", intel.messages.bank],
      ["Honesty", "Accounting", intel.accountingConnected ? "Connected" : "Not Connected", "fact", intel.messages.accounting],
      ["Honesty", "Projected bank balance", "", "unavailable", intel.messages.cashFlow],
      ["Revenue", "Average ticket", intel.averageTicket == null ? "" : String(intel.averageTicket), "fact", "Issued invoices in the selected range"],
      [
        "Pipeline",
        "Estimate conversion",
        intel.estimateConversion.conversionRate == null ? "" : String(intel.estimateConversion.conversionRate),
        "fact",
        `${intel.estimateConversion.approved} approved of ${intel.estimateConversion.sent} sent/approved`,
      ],
      [
        "Receivables",
        "Outstanding SENT invoices",
        `${intel.outstandingReceivables.count}:${intel.outstandingReceivables.amount}`,
        "fact",
        "Recorded SENT invoices only",
      ],
      [
        "Cash flow",
        "Known future inflows",
        String(intel.cashFlow.knownInflows),
        "fact",
        "SENT invoice totals",
      ],
      [
        "Cash flow",
        "Known future outflows",
        String(intel.cashFlow.knownOutflows),
        "fact",
        "Future recorded expenses plus authorized payroll",
      ],
      ...intel.serviceProfitability.map((row) => [
        "Service profitability",
        row.name,
        row.recordedMargin == null ? "" : String(row.recordedMargin),
        row.attributed ? "fact" : "unattributed",
        `Paid ${row.revenue ?? 0} − labor ${row.laborCost ?? 0} − job expenses ${row.jobExpense ?? 0}`,
      ]),
      ...intel.recurringExpenses.map((row) => [
        "Recurring expenses",
        row.description,
        String(row.amount),
        "fact",
        row.vendor ?? "",
      ]),
      ...intel.customerLifetime.map((row) => [
        "Customer lifetime",
        row.name,
        String(row.paidRevenue),
        "fact",
        `${row.paidInvoiceCount} paid invoices · ${row.completedJobs} completed jobs`,
      ]),
    ],
  };
}

/** Recorded-fact hooks for the BSOS recommendation engine. */
export function financialSignalsForBsos(intel: FinancialIntelligence): BsosFinancialSignal[] {
  const signals: BsosFinancialSignal[] = [];
  if (intel.outstandingReceivables.count > 0) {
    signals.push({
      key: "outstanding-receivables",
      kind: "fact",
      label: `${intel.outstandingReceivables.count} unpaid invoice${intel.outstandingReceivables.count === 1 ? "" : "s"} on file`,
      detail: "Recorded SENT invoices only.",
      href: "/invoices",
      priority: 10,
    });
  }
  const lowMargin = intel.serviceProfitability.filter(
    (row) => row.attributed && row.recordedMargin != null && row.recordedMargin < 0,
  );
  if (lowMargin.length > 0) {
    signals.push({
      key: "low-margin-services",
      kind: "fact",
      label: `${lowMargin.length} service${lowMargin.length === 1 ? "" : "s"} with negative recorded margin`,
      detail: "Paid revenue minus recorded job labor and job expenses.",
      href: "/reports?area=services",
      priority: 20,
    });
  }
  if (intel.estimateConversion.sent > 0 && (intel.estimateConversion.conversionRate ?? 100) < 40) {
    signals.push({
      key: "low-estimate-conversion",
      kind: "fact",
      label: `${intel.estimateConversion.approved} of ${intel.estimateConversion.sent} recorded estimates approved`,
      detail: "Conversion uses recorded estimate statuses only.",
      href: "/estimates",
      priority: 30,
    });
  }
  if (intel.laborCostTrend.some((row) => row.recordedMargin == null)) {
    signals.push({
      key: "missing-wage-data",
      kind: "fact",
      label: "Approved labor is missing a wage snapshot",
      detail: "TBBT will not invent an hourly rate.",
      href: "/time-cards",
      priority: 15,
    });
  }
  return signals;
}

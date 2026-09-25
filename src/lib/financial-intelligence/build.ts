import { percentChange, type BuiltReport } from "@/lib/reports";
import { BANKING_NOT_CONNECTED_MESSAGE } from "@/lib/finance-connections";
import { buildKnownCashFlowFromSource, CASH_FLOW_RECORDED_ONLY_MESSAGE, type KnownCashFlow } from "@/lib/financial-intelligence/cash-flow";
import { buildCustomerLifetime, buildCustomerProfitability, type CustomerLifetimeRow, type CustomerProfitRow } from "@/lib/financial-intelligence/customer-profitability";
import { calculateAllJobProfitability, WHOLE_JOB_RANGE_LABEL, type JobProfitability } from "@/lib/financial-intelligence/job-profitability";
import { emptyLaborBurdenConfig, type LaborBurdenConfig } from "@/lib/financial-intelligence/labor-burden";
import { buildPricingRecommendations, type PricingRecommendation } from "@/lib/financial-intelligence/pricing-intelligence";
import { buildReceivables, type ReceivablesAging } from "@/lib/financial-intelligence/receivables";
import { detectRecurringExpensePatterns, type RecurringExpenseSuggestion } from "@/lib/financial-intelligence/recurring-expenses";
import { buildServiceProfitability, type ServiceProfitRow } from "@/lib/financial-intelligence/service-profitability";
import type { FinancialSource } from "@/lib/financial-intelligence/source";

export const BANK_NOT_CONNECTED_MESSAGE = BANKING_NOT_CONNECTED_MESSAGE;

export type EstimateConversion = {
  sent: number;
  approved: number;
  conversionRate: number | null;
};

export type JobMarginPoint = {
  key: string;
  label: string;
  jobCount: number;
  paidRevenue: number;
  recordedMargin: number | null;
};

export type FinancialAttentionItem = {
  key: string;
  label: string;
  detail: string;
  href: string;
  kind: "fact";
};

export type FinancialIntelligence = {
  averageTicket: number | null;
  estimateConversion: EstimateConversion;
  serviceProfitability: ServiceProfitRow[];
  customerProfitability: CustomerProfitRow[];
  jobProfitability: JobProfitability[];
  jobMarginSnapshot: JobMarginPoint[];
  jobMarginKind: "whole-job-for-activity-in-range";
  jobMarginLabel: string;
  laborCostTrend: JobMarginPoint[];
  vendorSpend: Array<{ name: string; amount: number; count: number }>;
  recurringExpenses: Array<{
    id: string;
    description: string;
    amount: number;
    vendor: string | null;
    href: string;
  }>;
  recurringSuggestions: RecurringExpenseSuggestion[];
  outstandingReceivables: { amount: number; count: number };
  receivables: ReceivablesAging;
  customerLifetime: CustomerLifetimeRow[];
  cashFlow: KnownCashFlow;
  pricingRecommendations: PricingRecommendation[];
  laborBurden: LaborBurdenConfig;
  attention: FinancialAttentionItem[];
  bankConnected: false;
  accountingConnected: false;
  messages: {
    bank: string;
    accounting: string;
    cashFlow: string;
  };
};

export function estimateConversionFromSource(
  estimates: readonly { status: string; createdAt: Date }[],
  range: { start: Date | null; end: Date | null },
): EstimateConversion {
  const inPeriod = estimates.filter((row) => {
    if (range.start && row.createdAt < range.start) return false;
    if (range.end && row.createdAt >= range.end) return false;
    return true;
  });
  const sent = inPeriod.filter((row) => row.status === "SENT" || row.status === "APPROVED").length;
  const approved = inPeriod.filter((row) => row.status === "APPROVED").length;
  return {
    sent,
    approved,
    conversionRate: sent > 0 ? Math.round((approved / sent) * 100) : null,
  };
}

export function buildJobMarginRangeSnapshot(jobs: readonly JobProfitability[], label: string): JobMarginPoint[] {
  if (jobs.length === 0) return [];
  let paidRevenue = 0;
  let recordedMargin: number | null = 0;
  for (const job of jobs) {
    paidRevenue += job.collectedRevenue;
    if (job.grossProfit == null) recordedMargin = null;
    else if (recordedMargin != null) recordedMargin += job.grossProfit;
  }
  return [
    {
      key: "selected-range",
      label,
      jobCount: jobs.length,
      paidRevenue,
      recordedMargin: recordedMargin == null ? null : recordedMargin,
    },
  ];
}

function financialAttention(input: {
  receivables: ReceivablesAging;
  jobs: readonly JobProfitability[];
  pricing: readonly PricingRecommendation[];
  cashFlow: KnownCashFlow;
}): FinancialAttentionItem[] {
  const items: FinancialAttentionItem[] = [];
  const aged = input.receivables.rows.filter((row) => row.ageDays > 30);
  if (aged.length > 0) {
    items.push({
      key: "aged-receivables",
      kind: "fact",
      label: `${aged.length} invoice${aged.length === 1 ? "" : "s"} older than 30 days`,
      detail: `Outstanding ${input.receivables.totalOutstanding.toFixed(2)} on sent invoices. Due dates are not invented.`,
      href: "/reports?area=receivables",
    });
  }
  const incomplete = input.jobs.filter((job) => !job.completeness.laborCostComplete && job.completeness.hasTimeEntries);
  if (incomplete.length > 0) {
    items.push({
      key: "incomplete-labor-cost",
      kind: "fact",
      label: `${incomplete.length} job${incomplete.length === 1 ? "" : "s"} missing wage snapshots`,
      detail: "Approved time exists without a recorded wage. Labor cost is omitted.",
      href: "/time-cards",
    });
  }
  const negative = input.jobs.filter((job) => job.grossProfit != null && job.grossProfit < 0);
  if (negative.length > 0) {
    items.push({
      key: "negative-job-margin",
      kind: "fact",
      label: `${negative.length} job${negative.length === 1 ? "" : "s"} with negative recorded gross profit`,
      detail: "Billed revenue minus recorded direct cost (wage + job expenses) on complete jobs.",
      href: "/reports?area=job-profitability",
    });
  }
  for (const rec of input.pricing.slice(0, 3)) {
    items.push({
      key: `pricing:${rec.key}`,
      kind: "fact",
      label: rec.title,
      detail: rec.currentResult,
      href: rec.href,
    });
  }
  if (input.cashFlow.knownInflows === 0 && input.cashFlow.knownOutflows === 0) {
    items.push({
      key: "no-recorded-cash",
      kind: "fact",
      label: "No recorded cash movement in this range",
      detail: input.cashFlow.coverage,
      href: "/reports?area=cash-flow",
    });
  }
  return items;
}

export function buildFinancialIntelligence(
  source: FinancialSource,
  report: BuiltReport,
  now: Date = new Date(),
): FinancialIntelligence {
  const jobs = calculateAllJobProfitability(source, report.range);
  const receivables = buildReceivables(source, now);
  const serviceProfitability = buildServiceProfitability(jobs);
  const customerProfitability = buildCustomerProfitability(source, jobs, receivables.rows);
  const cashFlow = buildKnownCashFlowFromSource(source, report.range);
  const recurringSuggestions = detectRecurringExpensePatterns(source.expenses, source.recurringPatterns);
  const laborBurden = source.laborBurden ?? emptyLaborBurdenConfig();
  const pricingRecommendations = buildPricingRecommendations({
    jobs,
    services: serviceProfitability,
    laborBurden,
    expenseGrowthPercent: percentChange(report.recordedExpenses.current, report.recordedExpenses.prior ?? 0),
    currentExpenses: report.recordedExpenses.current,
    priorExpenses: report.recordedExpenses.prior ?? 0,
  });

  return {
    averageTicket: report.averageIssuedInvoice,
    estimateConversion: estimateConversionFromSource(source.estimates, report.range),
    serviceProfitability,
    customerProfitability,
    jobProfitability: jobs,
    jobMarginSnapshot: buildJobMarginRangeSnapshot(jobs, WHOLE_JOB_RANGE_LABEL),
    jobMarginKind: "whole-job-for-activity-in-range",
    jobMarginLabel: WHOLE_JOB_RANGE_LABEL,
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
    recurringSuggestions,
    outstandingReceivables: {
      amount: receivables.totalOutstanding,
      count: receivables.count,
    },
    receivables,
    customerLifetime: buildCustomerLifetime(source.customers, source.invoices, source.jobs, source.payments),
    cashFlow,
    pricingRecommendations,
    laborBurden,
    attention: financialAttention({ receivables, jobs, pricing: pricingRecommendations, cashFlow }),
    bankConnected: false,
    accountingConnected: false,
    messages: {
      bank: source.financeConnections.banking.message,
      accounting: source.financeConnections.accounting.message,
      cashFlow: CASH_FLOW_RECORDED_ONLY_MESSAGE,
    },
  };
}

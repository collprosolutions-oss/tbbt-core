import { catalogIdForJob, inRange, sumTotals, type ReportDateRange, type ReportSource } from "@/lib/reports";
import { isPaidActivity, roundHours, roundMoney } from "@/lib/time-cards";
import {
  applyLaborBurden,
  emptyLaborBurdenConfig,
  type LaborBurdenApplication,
  type LaborBurdenConfig,
} from "@/lib/financial-intelligence/labor-burden";
import type { FinancialSource } from "@/lib/financial-intelligence/source";

export type DataCompletenessFlags = {
  hasApprovedEstimate: boolean;
  hasInvoice: boolean;
  hasCollectedPayment: boolean;
  laborCostComplete: boolean;
  hasTimeEntries: boolean;
  hasJobExpenses: boolean;
  unpaidInvoicePresent: boolean;
  serviceAttributed: boolean;
};

export type EstimateActualVariance = {
  estimatedLaborHours: number | null;
  estimatedLaborCost: number | null;
  actualLaborHours: number;
  actualLaborCost: number | null;
  estimatedMaterials: number | null;
  actualMaterials: number;
  estimateTotal: number | null;
  approvedChangeOrders: number;
  invoiceTotal: number;
  actualKnownCost: number | null;
  laborHoursVariance: number | null;
  laborCostVariance: number | null;
  materialsVariance: number | null;
  totalCostVariance: number | null;
  revenueVariance: number | null;
};

export type JobProfitability = {
  jobId: string;
  customerId: string | null;
  customerName: string;
  status: string;
  catalogItemId: string | null;
  catalogName: string | null;
  contractedRevenue: number | null;
  billedRevenue: number;
  collectedRevenue: number;
  outstandingReceivable: number;
  laborHours: number;
  directLaborCost: number | null;
  laborBurden: LaborBurdenApplication;
  materialsDirectExpense: number;
  otherAllocatedDirectExpense: number;
  knownTotalDirectCost: number | null;
  grossProfit: number | null;
  collectedGrossProfit: number | null;
  grossMarginPct: number | null;
  estimateActual: EstimateActualVariance;
  completeness: DataCompletenessFlags;
  href: string;
};

function customerName(id: string | null, source: ReportSource): string {
  if (!id) return "Customer";
  return source.customers.find((row) => row.id === id)?.name ?? "Customer";
}

function catalogName(id: string | null, source: ReportSource): string | null {
  if (!id) return null;
  return source.catalogItems.find((item) => item.id === id)?.name ?? "Service";
}

export function paymentsAppliedToInvoice(
  payments: FinancialSource["payments"],
  invoiceId: string,
): number {
  return roundMoney(
    payments.filter((payment) => payment.invoiceId === invoiceId).reduce((sum, payment) => sum + payment.amount, 0),
  );
}

/**
 * Collected cash for a job. Uses recorded Payment rows when present.
 * Legacy PAID invoices with no payment rows count as collected.
 * SENT / unpaid invoice value is never treated as collected cash.
 */
export function collectedRevenueForJob(input: {
  jobId: string;
  invoices: ReportSource["invoices"];
  payments: FinancialSource["payments"];
}): number {
  const jobPayments = input.payments.filter((payment) => payment.jobId === input.jobId);
  const invoicePayments = input.payments.filter((payment) => {
    if (!payment.invoiceId) return false;
    return input.invoices.some((invoice) => invoice.id === payment.invoiceId && invoice.jobId === input.jobId);
  });
  const paymentIds = new Set([...jobPayments, ...invoicePayments].map((row) => row.id));
  const fromPayments = [...jobPayments, ...invoicePayments]
    .filter((row, index, all) => all.findIndex((item) => item.id === row.id) === index)
    .reduce((sum, payment) => sum + payment.amount, 0);

  const paidInvoices = input.invoices.filter((invoice) => invoice.jobId === input.jobId && invoice.status === "PAID");
  let legacyPaid = 0;
  for (const invoice of paidInvoices) {
    const applied = input.payments.some((payment) => payment.invoiceId === invoice.id || paymentIds.has(payment.id));
    if (!applied) legacyPaid += invoice.total;
  }

  return roundMoney(fromPayments + legacyPaid);
}

function estimateLinesForJob(job: { estimateId: string | null }, source: FinancialSource) {
  if (!job.estimateId) return [];
  const approved = source.estimateLines.filter(
    (line) => line.estimateId === job.estimateId && line.fromApprovedVersion,
  );
  if (approved.length > 0) return approved;
  const estimate = source.estimates.find((row) => row.id === job.estimateId && row.status === "APPROVED");
  if (!estimate) return [];
  return source.estimateLines.filter((line) => line.estimateId === job.estimateId);
}

export function calculateJobProfitability(
  jobId: string,
  source: FinancialSource,
  burden: LaborBurdenConfig = source.laborBurden ?? emptyLaborBurdenConfig(),
): JobProfitability | null {
  const job = source.jobs.find((row) => row.id === jobId);
  const jobInvoices = source.invoices.filter((invoice) => invoice.jobId === jobId);
  const jobExpenses = source.expenses.filter((expense) => expense.jobId === jobId);
  const jobEntries = source.approvedTimeEntries.filter((entry) => entry.jobId === jobId);
  if (!job && jobInvoices.length === 0 && jobExpenses.length === 0 && jobEntries.length === 0) {
    return null;
  }

  const customerId = job?.customerId ?? jobInvoices[0]?.customerId ?? null;
  const catalogItemId = job ? catalogIdForJob(job, source) : null;
  const approvedEstimate = job?.estimateId
    ? source.estimates.find((estimate) => estimate.id === job.estimateId && estimate.status === "APPROVED")
    : undefined;
  const approvedChangeOrders = source.changeOrders.filter(
    (order) => order.jobId === jobId && order.status === "APPROVED",
  );
  const approvedChangeOrderTotal = roundMoney(approvedChangeOrders.reduce((sum, order) => sum + order.total, 0));
  const contractedRevenue =
    approvedEstimate != null ? roundMoney(approvedEstimate.total + approvedChangeOrderTotal) : approvedChangeOrders.length > 0 ? approvedChangeOrderTotal : null;

  const billedInvoices = jobInvoices.filter((invoice) => invoice.status === "SENT" || invoice.status === "PAID");
  const billedRevenue = sumTotals(billedInvoices);
  const outstandingReceivable = sumTotals(jobInvoices.filter((invoice) => invoice.status === "SENT"));
  const collectedRevenue = collectedRevenueForJob({
    jobId,
    invoices: source.invoices,
    payments: source.payments,
  });

  let laborHours = 0;
  let wageOnly = 0;
  let sawCost = false;
  let laborCostIncomplete = false;
  for (const entry of jobEntries) {
    laborHours += entry.approvedHours ?? 0;
    if (!isPaidActivity(entry.activityType)) continue;
    if (entry.approvedLaborCost == null) laborCostIncomplete = true;
    else {
      wageOnly += entry.approvedLaborCost;
      sawCost = true;
    }
  }
  laborHours = roundHours(laborHours);
  const directLaborCost = sawCost ? roundMoney(wageOnly) : laborCostIncomplete ? null : 0;
  const laborBurden = applyLaborBurden(directLaborCost, burden);

  const materialsDirectExpense = roundMoney(
    jobExpenses.filter((expense) => expense.category === "MATERIALS").reduce((sum, expense) => sum + expense.amount, 0),
  );
  const otherAllocatedDirectExpense = roundMoney(
    jobExpenses.filter((expense) => expense.category !== "MATERIALS").reduce((sum, expense) => sum + expense.amount, 0),
  );
  const knownTotalDirectCost =
    laborBurden.laborCostWithBurden == null || laborCostIncomplete
      ? null
      : roundMoney(laborBurden.laborCostWithBurden + materialsDirectExpense + otherAllocatedDirectExpense);

  const grossProfit = knownTotalDirectCost == null ? null : roundMoney(billedRevenue - knownTotalDirectCost);
  const collectedGrossProfit = knownTotalDirectCost == null ? null : roundMoney(collectedRevenue - knownTotalDirectCost);
  const grossMarginPct =
    grossProfit == null || billedRevenue <= 0 ? null : roundMoney((grossProfit / billedRevenue) * 100);

  const lines = estimateLinesForJob(job ?? { estimateId: null }, source);
  const laborLines = lines.filter((line) => line.type === "LABOR");
  const materialLines = lines.filter((line) => line.type === "MATERIAL");
  const estimatedLaborHours = laborLines.length > 0 ? roundHours(laborLines.reduce((sum, line) => sum + line.quantity, 0)) : null;
  const estimatedLaborCost = laborLines.length > 0 ? roundMoney(laborLines.reduce((sum, line) => sum + line.total, 0)) : null;
  const estimatedMaterials = materialLines.length > 0 ? roundMoney(materialLines.reduce((sum, line) => sum + line.total, 0)) : null;
  const actualLaborCost = laborBurden.laborCostWithBurden;
  const laborHoursVariance =
    estimatedLaborHours == null ? null : roundHours(laborHours - estimatedLaborHours);
  const laborCostVariance =
    estimatedLaborCost == null || actualLaborCost == null ? null : roundMoney(actualLaborCost - estimatedLaborCost);
  const materialsVariance =
    estimatedMaterials == null ? null : roundMoney(materialsDirectExpense - estimatedMaterials);
  const estimatedDirect =
    estimatedLaborCost == null && estimatedMaterials == null
      ? null
      : roundMoney((estimatedLaborCost ?? 0) + (estimatedMaterials ?? 0));
  const totalCostVariance =
    estimatedDirect == null || knownTotalDirectCost == null ? null : roundMoney(knownTotalDirectCost - estimatedDirect);
  const revenueVariance =
    contractedRevenue == null ? null : roundMoney(billedRevenue - contractedRevenue);

  return {
    jobId,
    customerId,
    customerName: customerName(customerId, source),
    status: job?.status ?? "UNKNOWN",
    catalogItemId,
    catalogName: catalogName(catalogItemId, source),
    contractedRevenue,
    billedRevenue,
    collectedRevenue,
    outstandingReceivable,
    laborHours,
    directLaborCost,
    laborBurden,
    materialsDirectExpense,
    otherAllocatedDirectExpense,
    knownTotalDirectCost,
    grossProfit,
    collectedGrossProfit,
    grossMarginPct,
    estimateActual: {
      estimatedLaborHours,
      estimatedLaborCost,
      actualLaborHours: laborHours,
      actualLaborCost,
      estimatedMaterials,
      actualMaterials: materialsDirectExpense,
      estimateTotal: approvedEstimate?.total ?? null,
      approvedChangeOrders: approvedChangeOrderTotal,
      invoiceTotal: billedRevenue,
      actualKnownCost: knownTotalDirectCost,
      laborHoursVariance,
      laborCostVariance,
      materialsVariance,
      totalCostVariance,
      revenueVariance,
    },
    completeness: {
      hasApprovedEstimate: Boolean(approvedEstimate),
      hasInvoice: billedInvoices.length > 0,
      hasCollectedPayment: collectedRevenue > 0,
      laborCostComplete: !laborCostIncomplete && directLaborCost != null,
      hasTimeEntries: jobEntries.length > 0,
      hasJobExpenses: jobExpenses.length > 0,
      unpaidInvoicePresent: outstandingReceivable > 0,
      serviceAttributed: catalogItemId != null,
    },
    href: `/jobs/${jobId}`,
  };
}

export function calculateAllJobProfitability(
  source: FinancialSource,
  range?: Pick<ReportDateRange, "start" | "end">,
): JobProfitability[] {
  const ids = new Set<string>();
  for (const job of source.jobs) ids.add(job.id);
  for (const invoice of source.invoices) {
    if (invoice.jobId) ids.add(invoice.jobId);
  }
  for (const entry of source.approvedTimeEntries) {
    if (entry.jobId) ids.add(entry.jobId);
  }
  for (const expense of source.expenses) {
    if (expense.jobId) ids.add(expense.jobId);
  }

  return [...ids]
    .map((jobId) => calculateJobProfitability(jobId, source))
    .filter((row): row is JobProfitability => {
      if (!row) return false;
      if (!range) return true;
      const job = source.jobs.find((item) => item.id === row.jobId);
      const invoiceSignal = source.invoices.some(
        (invoice) =>
          invoice.jobId === row.jobId &&
          ((invoice.status === "PAID" && invoice.paidAt != null && inRange(invoice.paidAt, range)) ||
            inRange(invoice.createdAt, range)),
      );
      const laborSignal = source.approvedTimeEntries.some(
        (entry) => entry.jobId === row.jobId && inRange(entry.startedAt, range),
      );
      const expenseSignal = source.expenses.some(
        (expense) => expense.jobId === row.jobId && inRange(expense.occurredOn, range),
      );
      const completedSignal = Boolean(job && job.status === "COMPLETED" && inRange(job.createdAt, range));
      return invoiceSignal || laborSignal || expenseSignal || completedSignal;
    })
    .sort((a, b) => b.billedRevenue - a.billedRevenue || b.collectedRevenue - a.collectedRevenue);
}

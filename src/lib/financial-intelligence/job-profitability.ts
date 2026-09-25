import { catalogIdForJob, inRange, sumTotals, type ReportDateRange, type ReportSource } from "@/lib/reports";
import { isPaidActivity, roundHours, roundMoney } from "@/lib/time-cards";
import {
  collectedRevenueForJob,
  invoiceBalanceDue,
} from "@/lib/financial-intelligence/collected-revenue";
import {
  costAssumptionsFromLines,
  customerChargesFromLines,
  scheduledDurationHours,
  SCHEDULED_DURATION_LABEL,
} from "@/lib/financial-intelligence/estimate-actual";
import {
  applyLaborBurden,
  emptyLaborBurdenConfig,
  type LaborBurdenApplication,
  type LaborBurdenConfig,
} from "@/lib/financial-intelligence/labor-burden";
import type { FinancialSource } from "@/lib/financial-intelligence/source";

export { collectedRevenueForJob, paymentsAppliedToInvoice } from "@/lib/financial-intelligence/collected-revenue";

export const WHOLE_JOB_RANGE_LABEL =
  "Whole-job profitability for jobs with financial activity in this selected range.";

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
  customerLaborCharge: number | null;
  customerMaterialCharge: number | null;
  estimatedLaborHours: number | null;
  estimatedLaborHoursProvenance: "none" | "calculator-hours" | "takeoff-unit-cost" | "scheduled-duration";
  estimatedLaborCost: number | null;
  estimatedLaborCostProvenance: "none" | "calculator-hours" | "takeoff-unit-cost" | "scheduled-duration";
  actualLaborHours: number;
  actualLaborCost: number | null;
  estimatedMaterials: number | null;
  estimatedMaterialCost: number | null;
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
  scheduledDurationMinutes: number | null;
  scheduledDurationHours: number | null;
  scheduledDurationLabel: typeof SCHEDULED_DURATION_LABEL;
  scheduledVsActualHoursVariance: number | null;
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
  recordedWageLaborCost: number | null;
  directLaborCost: number | null;
  laborBurden: LaborBurdenApplication;
  materialsDirectExpense: number;
  otherAllocatedDirectExpense: number;
  recordedDirectCost: number | null;
  knownTotalDirectCost: number | null;
  burdenAdjustedDirectCost: number | null;
  grossProfit: number | null;
  collectedGrossProfit: number | null;
  grossMarginPct: number | null;
  burdenAdjustedGrossProfit: number | null;
  burdenAdjustedMarginPct: number | null;
  estimateActual: EstimateActualVariance;
  completeness: DataCompletenessFlags;
  financialActivityAt: Date;
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

function financialActivityAtForJob(
  jobId: string,
  source: FinancialSource,
  fallback: Date,
): Date {
  const dates: Date[] = [fallback];
  for (const invoice of source.invoices.filter((row) => row.jobId === jobId)) {
    dates.push(invoice.createdAt);
    if (invoice.paidAt) dates.push(invoice.paidAt);
  }
  for (const entry of source.approvedTimeEntries.filter((row) => row.jobId === jobId)) {
    dates.push(entry.startedAt);
  }
  for (const expense of source.expenses.filter((row) => row.jobId === jobId)) {
    dates.push(expense.occurredOn);
  }
  for (const payment of source.payments.filter((row) => row.jobId === jobId)) {
    dates.push(payment.receivedAt);
  }
  return dates.reduce((latest, date) => (date.getTime() > latest.getTime() ? date : latest));
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
    approvedEstimate != null
      ? roundMoney(approvedEstimate.total + approvedChangeOrderTotal)
      : approvedChangeOrders.length > 0
        ? approvedChangeOrderTotal
        : null;

  const billedInvoices = jobInvoices.filter((invoice) => invoice.status === "SENT" || invoice.status === "PAID");
  const billedRevenue = sumTotals(billedInvoices);
  const outstandingReceivable = roundMoney(
    jobInvoices
      .filter((invoice) => invoice.status === "SENT")
      .reduce((sum, invoice) => sum + invoiceBalanceDue(invoice, source.payments), 0),
  );
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
  const recordedWageLaborCost = sawCost ? roundMoney(wageOnly) : laborCostIncomplete ? null : 0;
  const directLaborCost = recordedWageLaborCost;
  const laborBurden = applyLaborBurden(directLaborCost, burden);

  const materialsDirectExpense = roundMoney(
    jobExpenses.filter((expense) => expense.category === "MATERIALS").reduce((sum, expense) => sum + expense.amount, 0),
  );
  const otherAllocatedDirectExpense = roundMoney(
    jobExpenses.filter((expense) => expense.category !== "MATERIALS").reduce((sum, expense) => sum + expense.amount, 0),
  );
  const recordedDirectCost =
    recordedWageLaborCost == null || laborCostIncomplete
      ? null
      : roundMoney(recordedWageLaborCost + materialsDirectExpense + otherAllocatedDirectExpense);
  const knownTotalDirectCost = recordedDirectCost;
  const burdenAdjustedDirectCost =
    recordedDirectCost == null || laborBurden.burdenAmount == null
      ? recordedDirectCost
      : roundMoney(recordedDirectCost + laborBurden.burdenAmount);

  const grossProfit = recordedDirectCost == null ? null : roundMoney(billedRevenue - recordedDirectCost);
  const collectedGrossProfit = recordedDirectCost == null ? null : roundMoney(collectedRevenue - recordedDirectCost);
  const grossMarginPct =
    grossProfit == null || billedRevenue <= 0 ? null : roundMoney((grossProfit / billedRevenue) * 100);
  const burdenAdjustedGrossProfit =
    burdenAdjustedDirectCost == null ? null : roundMoney(billedRevenue - burdenAdjustedDirectCost);
  const burdenAdjustedMarginPct =
    burdenAdjustedGrossProfit == null || billedRevenue <= 0
      ? null
      : roundMoney((burdenAdjustedGrossProfit / billedRevenue) * 100);

  const lines = estimateLinesForJob(job ?? { estimateId: null }, source);
  const charges = customerChargesFromLines(lines);
  const assumptions = costAssumptionsFromLines(lines, job?.scheduledDurationMinutes ?? null);
  const plannedHours = scheduledDurationHours(assumptions.scheduledDurationMinutes);
  const laborHoursVariance =
    assumptions.estimatedLaborHours == null ? null : roundHours(laborHours - assumptions.estimatedLaborHours);
  const laborCostVariance =
    assumptions.estimatedLaborCost == null || recordedWageLaborCost == null
      ? null
      : roundMoney(recordedWageLaborCost - assumptions.estimatedLaborCost);
  const materialsVariance =
    assumptions.estimatedMaterialCost == null
      ? null
      : roundMoney(materialsDirectExpense - assumptions.estimatedMaterialCost);
  const estimatedDirect =
    assumptions.estimatedLaborCost == null && assumptions.estimatedMaterialCost == null
      ? null
      : roundMoney((assumptions.estimatedLaborCost ?? 0) + (assumptions.estimatedMaterialCost ?? 0));
  const totalCostVariance =
    estimatedDirect == null || recordedDirectCost == null ? null : roundMoney(recordedDirectCost - estimatedDirect);
  const revenueVariance = contractedRevenue == null ? null : roundMoney(billedRevenue - contractedRevenue);

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
    recordedWageLaborCost,
    directLaborCost,
    laborBurden,
    materialsDirectExpense,
    otherAllocatedDirectExpense,
    recordedDirectCost,
    knownTotalDirectCost,
    burdenAdjustedDirectCost,
    grossProfit,
    collectedGrossProfit,
    grossMarginPct,
    burdenAdjustedGrossProfit,
    burdenAdjustedMarginPct,
    estimateActual: {
      customerLaborCharge: charges.customerLaborCharge,
      customerMaterialCharge: charges.customerMaterialCharge,
      estimatedLaborHours: assumptions.estimatedLaborHours,
      estimatedLaborHoursProvenance: assumptions.estimatedLaborHoursProvenance,
      estimatedLaborCost: assumptions.estimatedLaborCost,
      estimatedLaborCostProvenance: assumptions.estimatedLaborCostProvenance,
      actualLaborHours: laborHours,
      actualLaborCost: recordedWageLaborCost,
      estimatedMaterials: charges.customerMaterialCharge,
      estimatedMaterialCost: assumptions.estimatedMaterialCost,
      actualMaterials: materialsDirectExpense,
      estimateTotal: approvedEstimate?.total ?? null,
      approvedChangeOrders: approvedChangeOrderTotal,
      invoiceTotal: billedRevenue,
      actualKnownCost: recordedDirectCost,
      laborHoursVariance,
      laborCostVariance,
      materialsVariance,
      totalCostVariance,
      revenueVariance,
      scheduledDurationMinutes: assumptions.scheduledDurationMinutes,
      scheduledDurationHours: plannedHours,
      scheduledDurationLabel: SCHEDULED_DURATION_LABEL,
      scheduledVsActualHoursVariance:
        plannedHours == null ? null : roundHours(laborHours - plannedHours),
    },
    completeness: {
      hasApprovedEstimate: Boolean(approvedEstimate),
      hasInvoice: billedInvoices.length > 0,
      hasCollectedPayment: collectedRevenue > 0,
      laborCostComplete: !laborCostIncomplete && recordedWageLaborCost != null,
      hasTimeEntries: jobEntries.length > 0,
      hasJobExpenses: jobExpenses.length > 0,
      unpaidInvoicePresent: outstandingReceivable > 0,
      serviceAttributed: catalogItemId != null,
    },
    financialActivityAt: financialActivityAtForJob(jobId, source, job?.createdAt ?? jobInvoices[0]?.createdAt ?? new Date(0)),
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

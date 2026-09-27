/**
 * Read-only Job Profitability / Actual-vs-Estimate closeout.
 *
 * Connects recorded Estimate, Job, Invoice, Payment, TimeEntry, Expense,
 * and material-allocation facts for one job. Reuses canonical financial
 * intelligence math — it does not invent cost, rewrite records, or build
 * another financial engine.
 *
 * Missing labor or material cost stays "not recorded". Partial coverage
 * never produces a false full-profit number.
 */
import type { BusinessAccess } from "@/lib/access";
import {
  CAPABILITIES,
  ForbiddenError,
  canAccessManagementConsole,
  requireBusinessCapability,
} from "@/lib/authorization";
import { formatDateTime } from "@/lib/format";
import { getFinanceConnectionProvider } from "@/lib/finance-connections";
import {
  calculateJobProfitability,
  collectedRevenueForJob,
  emptyLaborBurdenConfig,
  invoiceBalanceDue,
  type FinancialEstimateLine,
  type FinancialPayment,
  type FinancialSource,
  type JobProfitability,
  type LaborBurdenConfig,
} from "@/lib/financial-intelligence";
import { customerChargesFromLines } from "@/lib/financial-intelligence/estimate-actual";
import type { ReportExpense, ReportInvoice } from "@/lib/reports";
import { isPaidActivity, roundHours, roundMoney } from "@/lib/time-cards";

export const CLOSEOUT_IN_PROGRESS_MESSAGE = "Closeout is still in progress";
export const LABOR_COST_NOT_RECORDED_MESSAGE = "Labor cost not recorded";
export const MATERIAL_COST_NOT_RECORDED_MESSAGE = "Material cost not recorded";
export const MATERIAL_COST_COVERAGE_INCOMPLETE_MESSAGE = "Material cost coverage incomplete";
export const PROFITABILITY_CANNOT_BE_CALCULATED_MESSAGE =
  "Profitability cannot be fully calculated from recorded data";

export const RECORDED_REVENUE_DEFINITION =
  "Recorded billed revenue is the sum of same-business, same-job SENT and PAID invoice totals.";

export const RECORDED_COST_DEFINITION =
  "Recorded attributable cost is approved wage snapshots on paid same-job time entries, plus same-job active MATERIALS expenses (the only counted material financial cost), plus other same-job active expenses. Unlinked purchase actualCost and owner labor-burden assumptions are not recorded cost. A missing category is omitted, never treated as $0.";

export const CLOSEOUT_READ_BOUND = 200;

export type CloseoutCoverageState = "Complete" | "Partial" | "Not recorded";

export type CloseoutCoverageKey =
  | "estimate"
  | "laborTime"
  | "laborCost"
  | "materials"
  | "expenses"
  | "invoice"
  | "payments";

export type CloseoutTimeEntry = {
  id: string;
  businessId: string;
  jobId: string | null;
  activityType: string;
  status: string;
  startedAt: Date;
  approvedHours: number | null;
  approvedLaborCost: number | null;
};

export type CloseoutMaterialItem = {
  id: string;
  businessId: string;
  jobId: string | null;
  status: string;
  actualCost: number | null;
  expenseId: string | null;
  expense: {
    id: string;
    businessId: string;
    jobId: string | null;
    amount: number;
    voidedAt: Date | null;
    category: string;
  } | null;
};

export type CloseoutChangeOrder = {
  id: string;
  businessId: string;
  jobId: string;
  status: string;
  total: number;
  approvedAt: Date | null;
};

export type CloseoutEstimate = {
  id: string;
  businessId: string;
  status: string;
  total: number;
  createdAt: Date;
  customerId: string | null;
  serviceRequestId: string | null;
};

export type CloseoutEstimateLine = FinancialEstimateLine & {
  estimateVersionId?: string | null;
};

export type JobCloseoutJob = {
  id: string;
  businessId: string;
  status: string;
  customerId: string | null;
  customerName: string | null;
  estimateId: string | null;
  createdAt: Date;
  scheduledDurationMinutes: number | null;
  approvedEstimateVersionId: string | null;
  approvedEstimateVersionTotal: number | null;
  approvedEstimateVersionNumber: number | null;
};

export type JobCloseoutInput = {
  businessId: string;
  jobId: string;
  timeZone: string;
  job: JobCloseoutJob | null;
  estimates: readonly CloseoutEstimate[];
  estimateLines: readonly CloseoutEstimateLine[];
  invoices: readonly ReportInvoice[];
  payments: readonly FinancialPayment[];
  timeEntries: readonly CloseoutTimeEntry[];
  expenses: readonly ReportExpense[];
  materialItems: readonly CloseoutMaterialItem[];
  changeOrders: readonly CloseoutChangeOrder[];
  laborBurden?: LaborBurdenConfig;
  readsTruncated?: boolean;
};

export type CloseoutCoverage = Record<CloseoutCoverageKey, CloseoutCoverageState>;

export type CloseoutMoneyFact = {
  amount: number | null;
  message: string | null;
};

export type CloseoutHoursFact = {
  hours: number | null;
  message: string | null;
};

export type LikeVariance = {
  estimated: number;
  actual: number;
  variance: number;
} | null;

export type JobProfitabilityCloseout = {
  jobId: string;
  businessId: string;
  customerName: string;
  jobStatus: string;
  timeZone: string;
  closeoutInProgress: boolean;
  closeoutStatusMessage: string | null;
  coverage: CloseoutCoverage;
  coverageComplete: boolean;
  sold: {
    approvedEstimateTotal: number | null;
    approvedEstimateSource: "approved-version" | "approved-estimate" | "none";
    estimatedLaborLineTotal: number | null;
    estimatedMaterialLineTotal: number | null;
    estimatedOtherLineTotal: number | null;
    usedDraftOrSentAsApproved: false;
  };
  actualWork: {
    jobHours: CloseoutHoursFact;
    travelHours: CloseoutHoursFact;
    materialPickupHours: CloseoutHoursFact;
    laborCost: CloseoutMoneyFact;
    materialCost: CloseoutMoneyFact;
    jobLinkedExpenses: CloseoutMoneyFact;
  };
  billing: {
    invoiceTotal: number;
    recordedPayments: number;
    outstandingBalance: number;
  };
  profitability: {
    recordedRevenue: number | null;
    recordedAttributableCost: number | null;
    grossProfit: number | null;
    grossMarginPct: number | null;
    available: boolean;
    message: string | null;
    revenueDefinition: typeof RECORDED_REVENUE_DEFINITION;
    costDefinition: typeof RECORDED_COST_DEFINITION;
  };
  variance: {
    laborHours: LikeVariance;
    laborCost: LikeVariance;
    materialsCost: LikeVariance;
    estimateVsInvoice: LikeVariance;
    invoiceVsPayments: LikeVariance;
  };
  engine: JobProfitability;
  readsTruncated: boolean;
};

export function assertCanReadJobProfitabilityCloseout(access: BusinessAccess): void {
  if (!canAccessManagementConsole(access.workspace.role)) {
    throw new ForbiddenError();
  }
  requireBusinessCapability(access, CAPABILITIES.VIEW_REPORTS);
}

export function formatCloseoutInstant(value: Date, timeZone: string): string {
  return formatDateTime(value, timeZone);
}

export function isolateSameBusinessJobInvoices(
  invoices: readonly ReportInvoice[],
  businessId: string,
  jobId: string,
): ReportInvoice[] {
  return invoices.filter((invoice) => invoice.businessId === businessId && invoice.jobId === jobId);
}

export function isolateSameBusinessJobPayments(
  payments: readonly FinancialPayment[],
  invoices: readonly ReportInvoice[],
  businessId: string,
  jobId: string,
): FinancialPayment[] {
  const jobInvoiceIds = new Set(
    isolateSameBusinessJobInvoices(invoices, businessId, jobId).map((invoice) => invoice.id),
  );
  const seen = new Set<string>();
  const isolated: FinancialPayment[] = [];
  for (const payment of payments) {
    if (payment.businessId !== businessId) continue;
    const onJob = payment.jobId === jobId;
    const onJobInvoice = payment.invoiceId != null && jobInvoiceIds.has(payment.invoiceId);
    if (!onJob && !onJobInvoice) continue;
    if (seen.has(payment.id)) continue;
    seen.add(payment.id);
    isolated.push(payment);
  }
  return isolated;
}

export function isolateSameBusinessJobTimeEntries(
  entries: readonly CloseoutTimeEntry[],
  businessId: string,
  jobId: string,
): CloseoutTimeEntry[] {
  return entries.filter((entry) => entry.businessId === businessId && entry.jobId === jobId);
}

export function isolateSameBusinessJobExpenses(
  expenses: readonly ReportExpense[],
  businessId: string,
  jobId: string,
): ReportExpense[] {
  return expenses.filter((expense) => expense.businessId === businessId && expense.jobId === jobId);
}

export function isolateSameBusinessJobMaterialItems(
  items: readonly CloseoutMaterialItem[],
  businessId: string,
  jobId: string,
): CloseoutMaterialItem[] {
  return items.filter((item) => item.businessId === businessId && item.jobId === jobId);
}

export function isolateApprovedEstimate(
  estimates: readonly CloseoutEstimate[],
  businessId: string,
  estimateId: string | null,
  approvedEstimateVersionId?: string | null,
): CloseoutEstimate | null {
  if (!estimateId) return null;
  if (approvedEstimateVersionId) {
    return (
      estimates.find((estimate) => estimate.id === estimateId && estimate.businessId === businessId) ??
      null
    );
  }
  return (
    estimates.find(
      (estimate) =>
        estimate.id === estimateId &&
        estimate.businessId === businessId &&
        estimate.status === "APPROVED",
    ) ?? null
  );
}

export function isolateApprovedEstimateLines(
  lines: readonly CloseoutEstimateLine[],
  estimate: CloseoutEstimate | null,
  approvedEstimateVersionId?: string | null,
): CloseoutEstimateLine[] {
  if (approvedEstimateVersionId) {
    return lines.filter(
      (line) =>
        line.fromApprovedVersion &&
        line.estimateVersionId === approvedEstimateVersionId &&
        (!estimate || line.estimateId === estimate.id),
    );
  }
  if (!estimate) return [];
  const approved = lines.filter(
    (line) => line.estimateId === estimate.id && line.fromApprovedVersion,
  );
  if (approved.length > 0) return approved;
  return lines.filter((line) => line.estimateId === estimate.id && !line.fromApprovedVersion);
}

function estimatedOtherLineTotal(lines: readonly FinancialEstimateLine[]): number | null {
  const other = lines.filter((line) => line.type === "OTHER");
  return other.length > 0 ? roundMoney(other.reduce((sum, line) => sum + line.total, 0)) : null;
}

function approvedHoursFor(
  entries: readonly CloseoutTimeEntry[],
  activityType: string,
): number {
  return roundHours(
    entries
      .filter((entry) => entry.status === "APPROVED" && entry.activityType === activityType)
      .reduce((sum, entry) => sum + (entry.approvedHours ?? 0), 0),
  );
}

function materialsExpected(
  approvedLines: readonly FinancialEstimateLine[],
  materialItems: readonly CloseoutMaterialItem[],
): boolean {
  return (
    approvedLines.some((line) => line.type === "MATERIAL") ||
    materialItems.some((item) => item.status !== "CANCELLED")
  );
}

/**
 * Same rule as financialMaterialCost(): only a linked non-voided Expense
 * is counted financial material cost. Unlinked operational actualCost is
 * not recorded cost.
 */
function materialFinancialAmount(item: CloseoutMaterialItem): number | null {
  if (item.expense && !item.expense.voidedAt) return item.expense.amount;
  return null;
}

export function assessCloseoutCoverage(input: {
  approvedEstimate: CloseoutEstimate | null;
  hasAnyEstimate: boolean;
  timeEntries: readonly CloseoutTimeEntry[];
  expenses: readonly ReportExpense[];
  materialItems: readonly CloseoutMaterialItem[];
  invoices: readonly ReportInvoice[];
  payments: readonly FinancialPayment[];
  approvedLines: readonly FinancialEstimateLine[];
  readsTruncated?: boolean;
}): CloseoutCoverage {
  const estimate: CloseoutCoverageState = input.approvedEstimate
    ? "Complete"
    : input.hasAnyEstimate
      ? "Partial"
      : "Not recorded";

  const jobTime = input.timeEntries.filter((entry) => entry.activityType === "JOB");
  const approvedJobTime = jobTime.filter((entry) => entry.status === "APPROVED");
  const laborTime: CloseoutCoverageState =
    approvedJobTime.length > 0
      ? "Complete"
      : input.timeEntries.length > 0
        ? "Partial"
        : "Not recorded";

  const paidApproved = input.timeEntries.filter(
    (entry) => entry.status === "APPROVED" && isPaidActivity(entry.activityType),
  );
  const paidWithCost = paidApproved.filter((entry) => entry.approvedLaborCost != null);
  const paidMissingCost = paidApproved.filter((entry) => entry.approvedLaborCost == null);
  const laborCost: CloseoutCoverageState =
    paidApproved.length > 0 && paidMissingCost.length === 0 && paidWithCost.length > 0
      ? "Complete"
      : paidWithCost.length > 0 || paidMissingCost.length > 0
        ? "Partial"
        : "Not recorded";

  const materialExpenses = input.expenses.filter((expense) => expense.category === "MATERIALS");
  const activeItems = input.materialItems.filter((item) => item.status !== "CANCELLED");
  const unlinkedItems = activeItems.filter((item) => materialFinancialAmount(item) == null);
  const linkedItems = activeItems.filter((item) => materialFinancialAmount(item) != null);
  const expected = materialsExpected(input.approvedLines, input.materialItems);
  let materials: CloseoutCoverageState = "Not recorded";
  if (materialExpenses.length > 0 && unlinkedItems.length === 0) {
    materials = "Complete";
  } else if (linkedItems.length > 0 || unlinkedItems.length > 0 || expected || materialExpenses.length > 0) {
    materials = "Partial";
  }

  const expenses: CloseoutCoverageState = input.expenses.length > 0 ? "Complete" : "Not recorded";

  const billed = input.invoices.filter((invoice) => invoice.status === "SENT" || invoice.status === "PAID");
  const draftOnly = input.invoices.length > 0 && billed.length === 0;
  const invoice: CloseoutCoverageState = billed.length > 0 ? "Complete" : draftOnly ? "Partial" : "Not recorded";

  const collected = collectedRevenueForJob({
    jobId: billed[0]?.jobId ?? input.invoices[0]?.jobId ?? "",
    invoices: input.invoices,
    payments: input.payments,
  });
  const outstanding = roundMoney(
    input.invoices
      .filter((row) => row.status === "SENT")
      .reduce((sum, row) => sum + invoiceBalanceDue(row, input.payments), 0),
  );
  const payments: CloseoutCoverageState =
    collected > 0 && outstanding === 0 && billed.length > 0
      ? "Complete"
      : collected > 0 || outstanding > 0
        ? "Partial"
        : "Not recorded";

  const coverage: CloseoutCoverage = {
    estimate,
    laborTime,
    laborCost,
    materials,
    expenses,
    invoice,
    payments,
  };
  if (input.readsTruncated) {
    for (const key of Object.keys(coverage) as CloseoutCoverageKey[]) {
      if (coverage[key] === "Complete") coverage[key] = "Partial";
    }
  }
  return coverage;
}

function emptyFinanceSource(businessId: string): Omit<FinancialSource, never> {
  return {
    businessId,
    invoices: [],
    customers: [],
    jobs: [],
    estimates: [],
    serviceRequests: [],
    catalogItems: [],
    estimateLineItems: [],
    approvedTimeEntries: [],
    payrollRuns: [],
    memberships: [],
    expenses: [],
    payments: [],
    changeOrders: [],
    estimateLines: [],
    laborBurden: emptyLaborBurdenConfig(),
    financeConnections: getFinanceConnectionProvider().status(),
    recurringPatterns: [],
  };
}

function likeVariance(estimated: number | null, actual: number | null): LikeVariance {
  if (estimated == null || actual == null) return null;
  return {
    estimated,
    actual,
    variance: roundMoney(actual - estimated),
  };
}

export function buildJobProfitabilityCloseout(
  input: JobCloseoutInput,
): JobProfitabilityCloseout | null {
  const job = input.job;
  if (!job || job.id !== input.jobId || job.businessId !== input.businessId) {
    return null;
  }

  const estimates = input.estimates.filter((estimate) => estimate.businessId === input.businessId);
  const approvedEstimate = isolateApprovedEstimate(
    estimates,
    input.businessId,
    job.estimateId,
    job.approvedEstimateVersionId,
  );
  const approvedLines = isolateApprovedEstimateLines(
    input.estimateLines,
    approvedEstimate,
    job.approvedEstimateVersionId,
  );
  const invoices = isolateSameBusinessJobInvoices(input.invoices, input.businessId, job.id);
  const payments = isolateSameBusinessJobPayments(
    input.payments,
    input.invoices,
    input.businessId,
    job.id,
  );
  const timeEntries = isolateSameBusinessJobTimeEntries(
    input.timeEntries,
    input.businessId,
    job.id,
  );
  const expenses = isolateSameBusinessJobExpenses(input.expenses, input.businessId, job.id);
  const materialItems = isolateSameBusinessJobMaterialItems(
    input.materialItems,
    input.businessId,
    job.id,
  );
  const changeOrders = input.changeOrders.filter(
    (order) => order.businessId === input.businessId && order.jobId === job.id,
  );
  const approvedTimeEntries = timeEntries
    .filter((entry) => entry.status === "APPROVED")
    .map((entry) => ({
      id: entry.id,
      membershipId: "closeout",
      jobId: entry.jobId,
      activityType: entry.activityType,
      startedAt: entry.startedAt,
      approvedHours: entry.approvedHours,
      approvedLaborCost: entry.approvedLaborCost,
    }));

  const coverage = assessCloseoutCoverage({
    approvedEstimate,
    hasAnyEstimate: Boolean(job.estimateId && estimates.some((row) => row.id === job.estimateId)),
    timeEntries,
    expenses,
    materialItems,
    invoices,
    payments,
    approvedLines,
    readsTruncated: input.readsTruncated,
  });

  const source: FinancialSource = {
    ...emptyFinanceSource(input.businessId),
    customers: job.customerId
      ? [{ id: job.customerId, name: job.customerName ?? "Customer", createdAt: job.createdAt }]
      : [],
    jobs: [
      {
        id: job.id,
        status: job.status,
        createdAt: job.createdAt,
        customerId: job.customerId,
        estimateId: job.estimateId,
        scheduledDurationMinutes: job.scheduledDurationMinutes,
      },
    ],
    estimates: approvedEstimate
      ? [
          {
            id: approvedEstimate.id,
            status: approvedEstimate.status,
            total: job.approvedEstimateVersionTotal ?? approvedEstimate.total,
            createdAt: approvedEstimate.createdAt,
            customerId: approvedEstimate.customerId,
            serviceRequestId: approvedEstimate.serviceRequestId,
          },
        ]
      : [],
    invoices,
    payments,
    approvedTimeEntries,
    expenses,
    changeOrders,
    estimateLines: approvedLines,
    laborBurden: input.laborBurden ?? emptyLaborBurdenConfig(),
  };

  const engine = calculateJobProfitability(job.id, source);
  if (!engine) return null;

  const charges = customerChargesFromLines(approvedLines);
  const approvedEstimateTotal =
    job.approvedEstimateVersionTotal ?? approvedEstimate?.total ?? null;
  const approvedEstimateSource: JobProfitabilityCloseout["sold"]["approvedEstimateSource"] =
    job.approvedEstimateVersionTotal != null
      ? "approved-version"
      : approvedEstimate
        ? "approved-estimate"
        : "none";

  const jobHours = approvedHoursFor(timeEntries, "JOB");
  const travelHours = approvedHoursFor(timeEntries, "TRAVEL");
  const pickupHours = approvedHoursFor(timeEntries, "MATERIAL_PICKUP");

  const laborCostAmount = coverage.laborCost === "Complete" ? engine.recordedWageLaborCost : null;
  const laborCost: CloseoutMoneyFact = {
    amount: laborCostAmount,
    message: laborCostAmount == null ? LABOR_COST_NOT_RECORDED_MESSAGE : null,
  };

  const materialsAreComplete = coverage.materials === "Complete";
  const materialCostAmount = materialsAreComplete ? engine.materialsDirectExpense : null;
  const materialCost: CloseoutMoneyFact = {
    amount: materialCostAmount,
    message:
      coverage.materials === "Partial"
        ? MATERIAL_COST_COVERAGE_INCOMPLETE_MESSAGE
        : coverage.materials === "Not recorded"
          ? MATERIAL_COST_NOT_RECORDED_MESSAGE
          : null,
  };

  const otherExpenses = coverage.expenses === "Complete" ? engine.otherAllocatedDirectExpense : null;
  const jobLinkedExpenses: CloseoutMoneyFact = {
    amount: coverage.expenses === "Complete" ? roundMoney(engine.materialsDirectExpense + engine.otherAllocatedDirectExpense) : null,
    message: coverage.expenses === "Not recorded" ? "Job-linked expenses not recorded" : null,
  };

  const expectedMaterials = materialsExpected(approvedLines, materialItems);
  const closeoutInProgress = job.status !== "COMPLETED";
  const costComplete =
    coverage.laborCost === "Complete" &&
    (materialsAreComplete || (coverage.materials === "Not recorded" && !expectedMaterials));
  const canCalculateProfit =
    !closeoutInProgress &&
    !input.readsTruncated &&
    costComplete &&
    coverage.invoice === "Complete" &&
    laborCostAmount != null;

  let recordedAttributableCost: number | null = null;
  if (canCalculateProfit && laborCostAmount != null) {
    recordedAttributableCost = roundMoney(
      laborCostAmount +
        (materialsAreComplete ? engine.materialsDirectExpense : 0) +
        (otherExpenses ?? 0),
    );
  }

  const recordedRevenue = coverage.invoice === "Complete" ? engine.billedRevenue : null;
  const grossProfit =
    canCalculateProfit && recordedRevenue != null && recordedAttributableCost != null
      ? roundMoney(recordedRevenue - recordedAttributableCost)
      : null;
  const grossMarginPct =
    grossProfit == null || recordedRevenue == null || recordedRevenue <= 0
      ? null
      : roundMoney((grossProfit / recordedRevenue) * 100);

  const profitabilityMessage = closeoutInProgress
    ? CLOSEOUT_IN_PROGRESS_MESSAGE
    : canCalculateProfit
      ? null
      : coverage.laborCost !== "Complete"
        ? LABOR_COST_NOT_RECORDED_MESSAGE
        : coverage.materials === "Partial" || (coverage.materials === "Not recorded" && expectedMaterials)
          ? MATERIAL_COST_COVERAGE_INCOMPLETE_MESSAGE
          : PROFITABILITY_CANNOT_BE_CALCULATED_MESSAGE;

  return {
    jobId: job.id,
    businessId: input.businessId,
    customerName: job.customerName ?? engine.customerName,
    jobStatus: job.status,
    timeZone: input.timeZone,
    closeoutInProgress,
    closeoutStatusMessage: closeoutInProgress ? CLOSEOUT_IN_PROGRESS_MESSAGE : null,
    coverage,
    coverageComplete: Object.values(coverage).every((state) => state === "Complete"),
    sold: {
      approvedEstimateTotal,
      approvedEstimateSource,
      estimatedLaborLineTotal: charges.customerLaborCharge,
      estimatedMaterialLineTotal: charges.customerMaterialCharge,
      estimatedOtherLineTotal: estimatedOtherLineTotal(approvedLines),
      usedDraftOrSentAsApproved: false,
    },
    actualWork: {
      jobHours: {
        hours: coverage.laborTime === "Not recorded" ? null : jobHours,
        message: coverage.laborTime === "Not recorded" ? "Job time not recorded" : null,
      },
      travelHours: {
        hours: travelHours > 0 ? travelHours : null,
        message: travelHours > 0 ? null : null,
      },
      materialPickupHours: {
        hours: pickupHours > 0 ? pickupHours : null,
        message: pickupHours > 0 ? null : null,
      },
      laborCost,
      materialCost,
      jobLinkedExpenses,
    },
    billing: {
      invoiceTotal: engine.billedRevenue,
      recordedPayments: engine.collectedRevenue,
      outstandingBalance: engine.outstandingReceivable,
    },
    profitability: {
      recordedRevenue,
      recordedAttributableCost,
      grossProfit,
      grossMarginPct,
      available: canCalculateProfit,
      message: profitabilityMessage,
      revenueDefinition: RECORDED_REVENUE_DEFINITION,
      costDefinition: RECORDED_COST_DEFINITION,
    },
    variance: {
      laborHours: likeVariance(engine.estimateActual.estimatedLaborHours, jobHours > 0 || coverage.laborTime === "Complete" ? jobHours : null),
      laborCost: likeVariance(engine.estimateActual.estimatedLaborCost, laborCostAmount),
      materialsCost: likeVariance(
        engine.estimateActual.estimatedMaterialCost,
        materialsAreComplete ? engine.materialsDirectExpense : null,
      ),
      estimateVsInvoice: likeVariance(approvedEstimateTotal, coverage.invoice === "Complete" ? engine.billedRevenue : null),
      invoiceVsPayments:
        coverage.invoice === "Complete"
          ? {
              estimated: engine.billedRevenue,
              actual: engine.collectedRevenue,
              variance: roundMoney(engine.collectedRevenue - engine.billedRevenue),
            }
          : null,
    },
    engine,
    readsTruncated: Boolean(input.readsTruncated),
  };
}

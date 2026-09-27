/**
 * OWNER-only deterministic scenario planner.
 *
 * Reuses recorded job profitability, invoice payments, and expenses.
 * Owner knobs (workload, material/labor, price) are forecast overlays
 * only. This module never writes prices, invoices, or catalog records.
 *
 * Forecasts are labeled separately from recorded facts. Unpaid invoices
 * are not cash in. TBBT does not have an actual bank balance. No tax
 * conclusion and no accounting-connection claim is produced.
 */
import type { BusinessAccess } from "@/lib/access";
import {
  CAPABILITIES,
  ForbiddenError,
  canAccessManagementConsole,
  requireBusinessCapability,
  requireBusinessRole,
} from "@/lib/authorization";
import {
  ACCOUNTING_NOT_CONNECTED_MESSAGE,
  BANKING_NOT_CONNECTED_MESSAGE,
  getFinanceConnectionProvider,
} from "@/lib/finance-connections";
import {
  buildKnownCashFlow,
  calculateAllJobProfitability,
  collectedRevenueForInvoices,
  emptyLaborBurdenConfig,
  outstandingReceivableAmount,
  type FinancialChangeOrder,
  type FinancialEstimateLine,
  type FinancialPayment,
  type FinancialSource,
  type JobProfitability,
} from "@/lib/financial-intelligence";
import { sumTotals, type ReportEstimate, type ReportExpense, type ReportInvoice, type ReportJob, type ReportTimeEntry } from "@/lib/reports";
import { roundMoney } from "@/lib/time-cards";

export const SCENARIO_PLANNER_PATH = "/scenario-planner";
export const PLANNER_READ_BOUND = 200;
export const PLANNER_FACTOR_PERCENT_MIN = 0;
export const PLANNER_FACTOR_PERCENT_MAX = 500;
export const PLANNER_IDENTITY_PERCENT = 100;

export const FORECAST_KIND = "forecast" as const;
export const RECORDED_FACT_KIND = "recorded-fact" as const;

export const FORECAST_NOT_FACT_MESSAGE =
  "Forecast only. These numbers are a deterministic what-if overlay on recorded TBBT facts, not recorded results.";

export const UNPAID_NOT_CASH_MESSAGE =
  "Unpaid invoices are outstanding receivables. They are not cash in.";

export const BANK_BALANCE_UNKNOWN_MESSAGE =
  "TBBT does not have an actual bank balance. Banking is Not Connected. No projected bank balance is invented.";

export const ACCOUNTING_NOT_CLAIMED_MESSAGE = ACCOUNTING_NOT_CONNECTED_MESSAGE;

export const NO_TAX_CONCLUSION_MESSAGE =
  "This planner does not produce tax conclusions or filing results.";

export const NO_AUTOMATIC_PRICE_CHANGE_MESSAGE =
  "Changing the price assumption does not update catalog prices, estimates, invoices, or jobs.";

export const LABOR_WAGE_NOT_BANK_CASH_MESSAGE =
  "Recorded wage labor is an operational cost for margin. It is not verified bank cash out.";

export const OVERHEAD_NOT_SCALED_MESSAGE =
  "Unallocated recorded expenses stay at their recorded amounts when workload changes. Only job-linked material and other job expenses scale with workload.";

export const INCOMPLETE_LABOR_MARGIN_MESSAGE =
  "Projected margin uses only jobs with recorded labor cost. Jobs without recorded labor cost do not invent $0 labor.";

export const READ_BOUND_MESSAGE =
  "Nested reads hit the planner bound, so this view is a bounded sample, not a complete ledger.";

export type PlannerTimeEntry = ReportTimeEntry & { businessId: string };

export type PlannerCustomer = {
  id: string;
  businessId: string;
  name: string;
  createdAt: Date;
};

export type PlannerEstimate = ReportEstimate & { businessId: string };

export type PlannerRecordSource = {
  businessId: string;
  jobs: Array<ReportJob & { businessId: string }>;
  invoices: ReportInvoice[];
  payments: FinancialPayment[];
  expenses: ReportExpense[];
  approvedTimeEntries: PlannerTimeEntry[];
  customers: PlannerCustomer[];
  estimates: PlannerEstimate[];
  estimateLines: FinancialEstimateLine[];
  changeOrders: FinancialChangeOrder[];
};

export type OwnerScenarioAssumptions = {
  workloadFactor: number;
  materialCostFactor: number;
  laborCostFactor: number;
  priceFactor: number;
  assumeUnpaidInvoicesCollect: boolean;
  workloadPercent: number;
  materialCostPercent: number;
  laborCostPercent: number;
  pricePercent: number;
  errors: string[];
};

export type OwnerScenarioMoneyFact = {
  kind: typeof RECORDED_FACT_KIND;
  amount: number;
};

export type OwnerScenarioMoneyForecast = {
  kind: typeof FORECAST_KIND;
  amount: number | null;
  message: typeof FORECAST_NOT_FACT_MESSAGE;
};

export type OwnerScenarioPlan = {
  businessId: string;
  writesRecords: false;
  changesPrices: false;
  taxConclusion: null;
  actualBankBalance: null;
  projectedBankBalance: null;
  bankConnected: false;
  accountingConnected: false;
  readsTruncated: boolean;
  assumptions: OwnerScenarioAssumptions;
  jobs: JobProfitability[];
  recorded: {
    kind: typeof RECORDED_FACT_KIND;
    jobCount: number;
    completeCostJobCount: number;
    incompleteLaborJobCount: number;
    billedRevenue: number;
    collectedRevenue: number;
    unpaidReceivable: number;
    unpaidInvoiceCount: number;
    recordedWageLabor: number | null;
    jobMaterialsExpense: number;
    jobOtherExpense: number;
    overheadExpense: number;
    recordedDirectCost: number | null;
    recordedGrossProfit: number | null;
    recordedMarginPct: number | null;
    knownCashIn: number;
    knownCashOut: number;
    knownNet: number;
  };
  forecast: {
    kind: typeof FORECAST_KIND;
    jobEquivalents: number;
    projectedBilledRevenue: number;
    projectedCollectedCashIn: number;
    projectedUnpaidReceivable: number;
    projectedWageLabor: number | null;
    projectedJobMaterials: number;
    projectedJobOther: number;
    projectedOverheadExpense: number;
    projectedDirectCost: number | null;
    projectedGrossProfit: number | null;
    projectedMarginPct: number | null;
    projectedCashIn: number;
    projectedCashOut: number;
    projectedKnownNet: number;
    unpaidIncludedAsCashIn: boolean;
  };
  facts: {
    billed: OwnerScenarioMoneyFact;
    collected: OwnerScenarioMoneyFact;
    unpaid: OwnerScenarioMoneyFact;
    cashIn: OwnerScenarioMoneyFact;
    cashOut: OwnerScenarioMoneyFact;
  };
  projections: {
    billed: OwnerScenarioMoneyForecast;
    cashIn: OwnerScenarioMoneyForecast;
    cashOut: OwnerScenarioMoneyForecast;
    marginPct: OwnerScenarioMoneyForecast;
    bankBalance: OwnerScenarioMoneyForecast;
  };
  messages: {
    forecast: typeof FORECAST_NOT_FACT_MESSAGE;
    unpaid: typeof UNPAID_NOT_CASH_MESSAGE;
    bank: typeof BANK_BALANCE_UNKNOWN_MESSAGE;
    bankingConnection: typeof BANKING_NOT_CONNECTED_MESSAGE;
    accounting: typeof ACCOUNTING_NOT_CLAIMED_MESSAGE;
    tax: typeof NO_TAX_CONCLUSION_MESSAGE;
    prices: typeof NO_AUTOMATIC_PRICE_CHANGE_MESSAGE;
    laborCash: typeof LABOR_WAGE_NOT_BANK_CASH_MESSAGE;
    overhead: typeof OVERHEAD_NOT_SCALED_MESSAGE;
    incompleteLabor: typeof INCOMPLETE_LABOR_MARGIN_MESSAGE;
    bound: typeof READ_BOUND_MESSAGE | null;
  };
};

export function canAccessOwnerScenarioPlanner(role: BusinessAccess["workspace"]["role"]): boolean {
  return role === "OWNER" && canAccessManagementConsole(role);
}

export function assertCanReadOwnerScenarioPlanner(access: BusinessAccess): void {
  if (!canAccessManagementConsole(access.workspace.role)) {
    throw new ForbiddenError();
  }
  requireBusinessCapability(access, CAPABILITIES.VIEW_REPORTS);
  requireBusinessRole(access, "OWNER");
}

export function parsePlannerFactorPercent(raw: string | null | undefined): number | null {
  if (raw == null) return PLANNER_IDENTITY_PERCENT;
  const trimmed = raw.trim();
  if (!trimmed) return PLANNER_IDENTITY_PERCENT;
  const percent = Number(trimmed);
  if (!Number.isFinite(percent)) return null;
  if (percent < PLANNER_FACTOR_PERCENT_MIN || percent > PLANNER_FACTOR_PERCENT_MAX) return null;
  return roundMoney(percent);
}

export function factorFromPercent(percent: number): number {
  return roundMoney(percent / 100);
}

export function parseOwnerScenarioAssumptions(input: {
  workload?: string | null;
  materials?: string | null;
  labor?: string | null;
  price?: string | null;
  assumeUnpaid?: string | null;
}): OwnerScenarioAssumptions {
  const errors: string[] = [];
  const workloadPercent = parsePlannerFactorPercent(input.workload);
  const materialCostPercent = parsePlannerFactorPercent(input.materials);
  const laborCostPercent = parsePlannerFactorPercent(input.labor);
  const pricePercent = parsePlannerFactorPercent(input.price);

  if (workloadPercent == null) errors.push("Workload percent must be from 0 to 500.");
  if (materialCostPercent == null) errors.push("Material assumption percent must be from 0 to 500.");
  if (laborCostPercent == null) errors.push("Labor assumption percent must be from 0 to 500.");
  if (pricePercent == null) errors.push("Price percent must be from 0 to 500.");

  const safeWorkload = workloadPercent ?? PLANNER_IDENTITY_PERCENT;
  const safeMaterials = materialCostPercent ?? PLANNER_IDENTITY_PERCENT;
  const safeLabor = laborCostPercent ?? PLANNER_IDENTITY_PERCENT;
  const safePrice = pricePercent ?? PLANNER_IDENTITY_PERCENT;
  const assumeRaw = input.assumeUnpaid?.trim().toLowerCase() ?? "";

  return {
    workloadFactor: factorFromPercent(safeWorkload),
    materialCostFactor: factorFromPercent(safeMaterials),
    laborCostFactor: factorFromPercent(safeLabor),
    priceFactor: factorFromPercent(safePrice),
    assumeUnpaidInvoicesCollect: assumeRaw === "1" || assumeRaw === "on" || assumeRaw === "true",
    workloadPercent: safeWorkload,
    materialCostPercent: safeMaterials,
    laborCostPercent: safeLabor,
    pricePercent: safePrice,
    errors,
  };
}

export function isolateSameBusinessJobs<T extends { businessId: string }>(
  rows: readonly T[],
  businessId: string,
): T[] {
  return rows.filter((row) => row.businessId === businessId);
}

export function isolateSameBusinessInvoices(
  invoices: readonly ReportInvoice[],
  businessId: string,
): ReportInvoice[] {
  return invoices.filter((invoice) => invoice.businessId === businessId);
}

export function isolateSameBusinessPayments(
  payments: readonly FinancialPayment[],
  businessId: string,
): FinancialPayment[] {
  const seen = new Set<string>();
  const isolated: FinancialPayment[] = [];
  for (const payment of payments) {
    if (payment.businessId !== businessId) continue;
    if (seen.has(payment.id)) continue;
    seen.add(payment.id);
    isolated.push(payment);
  }
  return isolated;
}

export function isolateSameBusinessExpenses(
  expenses: readonly ReportExpense[],
  businessId: string,
): ReportExpense[] {
  return expenses.filter((expense) => expense.businessId === businessId);
}

export function isolateSameBusinessTimeEntries(
  entries: readonly PlannerTimeEntry[],
  businessId: string,
): PlannerTimeEntry[] {
  return entries.filter((entry) => entry.businessId === businessId);
}

export function isolatePlannerSource(source: PlannerRecordSource): PlannerRecordSource {
  const businessId = source.businessId;
  const jobs = isolateSameBusinessJobs(source.jobs, businessId);
  const jobIds = new Set(jobs.map((job) => job.id));
  const invoices = isolateSameBusinessInvoices(source.invoices, businessId);
  const invoiceIds = new Set(invoices.map((invoice) => invoice.id));
  const payments = isolateSameBusinessPayments(source.payments, businessId).filter((payment) => {
    const onOwnedInvoice = payment.invoiceId != null && invoiceIds.has(payment.invoiceId);
    const onOwnedJob = payment.jobId != null && jobIds.has(payment.jobId);
    return onOwnedInvoice || onOwnedJob || (payment.invoiceId == null && payment.jobId == null);
  });
  const expenses = isolateSameBusinessExpenses(source.expenses, businessId);
  const approvedTimeEntries = isolateSameBusinessTimeEntries(source.approvedTimeEntries, businessId);
  const customers = isolateSameBusinessJobs(source.customers, businessId);
  const estimates = isolateSameBusinessJobs(source.estimates, businessId);
  const estimateIds = new Set(estimates.map((estimate) => estimate.id));
  const estimateLines = source.estimateLines.filter((line) => estimateIds.has(line.estimateId));
  const changeOrders = source.changeOrders.filter((order) => jobIds.has(order.jobId));

  return {
    businessId,
    jobs,
    invoices,
    payments,
    expenses,
    approvedTimeEntries,
    customers,
    estimates,
    estimateLines,
    changeOrders,
  };
}

export function plannerSourceToFinancialSource(source: PlannerRecordSource): FinancialSource {
  const isolated = isolatePlannerSource(source);
  return {
    businessId: isolated.businessId,
    invoices: isolated.invoices,
    customers: isolated.customers.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.createdAt,
    })),
    jobs: isolated.jobs.map((job) => ({
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      customerId: job.customerId,
      estimateId: job.estimateId,
      scheduledDurationMinutes: job.scheduledDurationMinutes,
    })),
    estimates: isolated.estimates.map((estimate) => ({
      id: estimate.id,
      status: estimate.status,
      total: estimate.total,
      createdAt: estimate.createdAt,
      customerId: estimate.customerId,
      serviceRequestId: estimate.serviceRequestId,
    })),
    serviceRequests: [],
    catalogItems: [],
    estimateLineItems: [],
    approvedTimeEntries: isolated.approvedTimeEntries,
    payrollRuns: [],
    memberships: [],
    expenses: isolated.expenses,
    payments: isolated.payments,
    changeOrders: isolated.changeOrders,
    estimateLines: isolated.estimateLines,
    laborBurden: emptyLaborBurdenConfig(),
    financeConnections: getFinanceConnectionProvider().status(),
    recurringPatterns: [],
  };
}

function moneyFact(amount: number): OwnerScenarioMoneyFact {
  return { kind: RECORDED_FACT_KIND, amount };
}

function moneyForecast(amount: number | null): OwnerScenarioMoneyForecast {
  return { kind: FORECAST_KIND, amount, message: FORECAST_NOT_FACT_MESSAGE };
}

function splitExpenses(expenses: readonly ReportExpense[]) {
  let jobMaterialsExpense = 0;
  let jobOtherExpense = 0;
  let overheadExpense = 0;
  let overheadMaterials = 0;
  let overheadOther = 0;
  for (const expense of expenses) {
    const isMaterials = expense.category === "MATERIALS";
    if (expense.jobId) {
      if (isMaterials) jobMaterialsExpense += expense.amount;
      else jobOtherExpense += expense.amount;
    } else if (isMaterials) {
      overheadMaterials += expense.amount;
      overheadExpense += expense.amount;
    } else {
      overheadOther += expense.amount;
      overheadExpense += expense.amount;
    }
  }
  return {
    jobMaterialsExpense: roundMoney(jobMaterialsExpense),
    jobOtherExpense: roundMoney(jobOtherExpense),
    overheadExpense: roundMoney(overheadExpense),
    overheadMaterials: roundMoney(overheadMaterials),
    overheadOther: roundMoney(overheadOther),
  };
}

export function buildOwnerScenarioPlan(
  source: PlannerRecordSource,
  assumptions: OwnerScenarioAssumptions,
  options?: { readsTruncated?: boolean },
): OwnerScenarioPlan {
  const isolated = isolatePlannerSource(source);
  const financial = plannerSourceToFinancialSource(isolated);
  const jobs = calculateAllJobProfitability(financial);
  const completeJobs = jobs.filter((job) => job.recordedDirectCost != null);
  const incompleteLaborJobCount = jobs.filter((job) => !job.completeness.laborCostComplete).length;
  const billedRevenue = sumTotals(
    isolated.invoices.filter((invoice) => invoice.status === "SENT" || invoice.status === "PAID"),
  );
  const collectedRevenue = collectedRevenueForInvoices(isolated.invoices, isolated.payments);
  const unpaid = outstandingReceivableAmount(isolated.invoices, isolated.payments);
  const recordedWageLabor = completeJobs.length
    ? roundMoney(completeJobs.reduce((sum, job) => sum + (job.recordedWageLaborCost ?? 0), 0))
    : jobs.some((job) => job.recordedWageLaborCost != null)
      ? roundMoney(jobs.reduce((sum, job) => sum + (job.recordedWageLaborCost ?? 0), 0))
      : incompleteLaborJobCount > 0
        ? null
        : 0;
  const expenses = splitExpenses(isolated.expenses);
  const recordedDirectCost =
    completeJobs.length > 0 && incompleteLaborJobCount === 0
      ? roundMoney(completeJobs.reduce((sum, job) => sum + (job.recordedDirectCost ?? 0), 0))
      : completeJobs.length > 0
        ? roundMoney(completeJobs.reduce((sum, job) => sum + (job.recordedDirectCost ?? 0), 0))
        : null;
  const completeBilled = roundMoney(completeJobs.reduce((sum, job) => sum + job.billedRevenue, 0));
  const recordedGrossProfit =
    recordedDirectCost == null ? null : roundMoney(completeBilled - recordedDirectCost);
  const recordedMarginPct =
    recordedGrossProfit == null || completeBilled <= 0
      ? null
      : roundMoney((recordedGrossProfit / completeBilled) * 100);

  const cash = buildKnownCashFlow({
    collectedPayments: [{ amount: collectedRevenue }],
    recordedExpenses: isolated.expenses,
  });

  const completeLabor = completeJobs.reduce((sum, job) => sum + (job.recordedWageLaborCost ?? 0), 0);
  const completeMaterials = completeJobs.reduce((sum, job) => sum + job.materialsDirectExpense, 0);
  const completeOther = completeJobs.reduce((sum, job) => sum + job.otherAllocatedDirectExpense, 0);

  const projectedBilledRevenue = roundMoney(billedRevenue * assumptions.priceFactor * assumptions.workloadFactor);
  const projectedCollectedFromRecorded = roundMoney(
    collectedRevenue * assumptions.priceFactor * assumptions.workloadFactor,
  );
  const projectedCashIn = roundMoney(
    projectedCollectedFromRecorded + (assumptions.assumeUnpaidInvoicesCollect ? unpaid.amount : 0),
  );
  const projectedUnpaidReceivable = assumptions.assumeUnpaidInvoicesCollect ? 0 : unpaid.amount;
  const projectedWageLabor =
    recordedWageLabor == null && completeJobs.length === 0
      ? null
      : roundMoney(completeLabor * assumptions.laborCostFactor * assumptions.workloadFactor);
  const projectedJobMaterials = roundMoney(
    completeMaterials * assumptions.materialCostFactor * assumptions.workloadFactor,
  );
  const projectedJobOther = roundMoney(completeOther * assumptions.workloadFactor);
  const projectedOverheadExpense = roundMoney(
    expenses.overheadMaterials * assumptions.materialCostFactor + expenses.overheadOther,
  );
  const projectedDirectCost =
    projectedWageLabor == null && completeJobs.length === 0
      ? null
      : roundMoney((projectedWageLabor ?? 0) + projectedJobMaterials + projectedJobOther);
  const marginBilled = roundMoney(completeBilled * assumptions.priceFactor * assumptions.workloadFactor);
  const projectedGrossProfit =
    projectedDirectCost == null ? null : roundMoney(marginBilled - projectedDirectCost);
  const projectedMarginPct =
    projectedGrossProfit == null || marginBilled <= 0
      ? null
      : roundMoney((projectedGrossProfit / marginBilled) * 100);
  const projectedCashOut = roundMoney(
    expenses.jobMaterialsExpense * assumptions.materialCostFactor * assumptions.workloadFactor +
      expenses.overheadMaterials * assumptions.materialCostFactor +
      expenses.jobOtherExpense * assumptions.workloadFactor +
      expenses.overheadOther,
  );

  const readsTruncated = Boolean(options?.readsTruncated);

  return {
    businessId: isolated.businessId,
    writesRecords: false,
    changesPrices: false,
    taxConclusion: null,
    actualBankBalance: null,
    projectedBankBalance: null,
    bankConnected: false,
    accountingConnected: false,
    readsTruncated,
    assumptions,
    jobs,
    recorded: {
      kind: RECORDED_FACT_KIND,
      jobCount: jobs.length,
      completeCostJobCount: completeJobs.length,
      incompleteLaborJobCount,
      billedRevenue,
      collectedRevenue,
      unpaidReceivable: unpaid.amount,
      unpaidInvoiceCount: unpaid.count,
      recordedWageLabor,
      jobMaterialsExpense: expenses.jobMaterialsExpense,
      jobOtherExpense: expenses.jobOtherExpense,
      overheadExpense: expenses.overheadExpense,
      recordedDirectCost,
      recordedGrossProfit,
      recordedMarginPct,
      knownCashIn: cash.knownInflows,
      knownCashOut: cash.knownOutflows,
      knownNet: cash.netKnown,
    },
    forecast: {
      kind: FORECAST_KIND,
      jobEquivalents: roundMoney(jobs.length * assumptions.workloadFactor),
      projectedBilledRevenue,
      projectedCollectedCashIn: projectedCollectedFromRecorded,
      projectedUnpaidReceivable,
      projectedWageLabor,
      projectedJobMaterials,
      projectedJobOther,
      projectedOverheadExpense,
      projectedDirectCost,
      projectedGrossProfit,
      projectedMarginPct,
      projectedCashIn,
      projectedCashOut,
      projectedKnownNet: roundMoney(projectedCashIn - projectedCashOut),
      unpaidIncludedAsCashIn: assumptions.assumeUnpaidInvoicesCollect,
    },
    facts: {
      billed: moneyFact(billedRevenue),
      collected: moneyFact(collectedRevenue),
      unpaid: moneyFact(unpaid.amount),
      cashIn: moneyFact(cash.knownInflows),
      cashOut: moneyFact(cash.knownOutflows),
    },
    projections: {
      billed: moneyForecast(projectedBilledRevenue),
      cashIn: moneyForecast(projectedCashIn),
      cashOut: moneyForecast(projectedCashOut),
      marginPct: moneyForecast(projectedMarginPct),
      bankBalance: moneyForecast(null),
    },
    messages: {
      forecast: FORECAST_NOT_FACT_MESSAGE,
      unpaid: UNPAID_NOT_CASH_MESSAGE,
      bank: BANK_BALANCE_UNKNOWN_MESSAGE,
      bankingConnection: BANKING_NOT_CONNECTED_MESSAGE,
      accounting: ACCOUNTING_NOT_CLAIMED_MESSAGE,
      tax: NO_TAX_CONCLUSION_MESSAGE,
      prices: NO_AUTOMATIC_PRICE_CHANGE_MESSAGE,
      laborCash: LABOR_WAGE_NOT_BANK_CASH_MESSAGE,
      overhead: OVERHEAD_NOT_SCALED_MESSAGE,
      incompleteLabor: INCOMPLETE_LABOR_MARGIN_MESSAGE,
      bound: readsTruncated ? READ_BOUND_MESSAGE : null,
    },
  };
}

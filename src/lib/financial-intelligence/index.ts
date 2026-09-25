export {
  BANK_NOT_CONNECTED_MESSAGE,
  buildFinancialIntelligence,
  buildJobMarginRangeSnapshot,
  estimateConversionFromSource,
  type EstimateConversion,
  type FinancialAttentionItem,
  type FinancialIntelligence,
  type JobMarginPoint,
} from "@/lib/financial-intelligence/build";
export { financialSignalsForBsos, type BsosFinancialSignal } from "@/lib/financial-intelligence/bsos-signals";
export {
  buildKnownCashFlow,
  buildKnownCashFlowFromSource,
  CASH_FLOW_COVERAGE_MESSAGE,
  CASH_FLOW_RECORDED_ONLY_MESSAGE,
  collectedPaymentsInRange,
  type KnownCashFlow,
  type KnownCashFlowInput,
} from "@/lib/financial-intelligence/cash-flow";
export {
  buildCustomerLifetime,
  buildCustomerProfitability,
  type CustomerLifetimeRow,
  type CustomerProfitRow,
} from "@/lib/financial-intelligence/customer-profitability";
export {
  jobProfitabilityCsvRows,
  managementReportCsvRows,
  receivablesCsvRows,
} from "@/lib/financial-intelligence/export";
export {
  calculateAllJobProfitability,
  calculateJobProfitability,
  collectedRevenueForJob,
  paymentsAppliedToInvoice,
  type DataCompletenessFlags,
  type EstimateActualVariance,
  type JobProfitability,
} from "@/lib/financial-intelligence/job-profitability";
export {
  applyLaborBurden,
  emptyLaborBurdenConfig,
  formatRatePercent,
  NO_BURDEN_CONFIGURED_MESSAGE,
  parseOptionalRate,
  type LaborBurdenApplication,
  type LaborBurdenConfig,
} from "@/lib/financial-intelligence/labor-burden";
export {
  buildPricingRecommendations,
  PRICING_MIN_SAMPLE,
  type PricingRecommendation,
} from "@/lib/financial-intelligence/pricing-intelligence";
export {
  ageInWholeDays,
  agingBucketForDays,
  buildReceivables,
  RECEIVABLE_AGING_BUCKETS,
  type ReceivableAgingBucket,
  type ReceivableRow,
  type ReceivablesAging,
} from "@/lib/financial-intelligence/receivables";
export {
  detectRecurringExpensePatterns,
  RECURRING_PATTERN_MIN_OCCURRENCES,
  type RecurringExpenseSuggestion,
} from "@/lib/financial-intelligence/recurring-expenses";
export { buildServiceProfitability, type ServiceProfitRow } from "@/lib/financial-intelligence/service-profitability";
export type {
  FinancialChangeOrder,
  FinancialEstimateLine,
  FinancialPayment,
  FinancialSource,
  RecurringPatternRecord,
} from "@/lib/financial-intelligence/source";

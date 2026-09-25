import { WHOLE_JOB_RANGE_LABEL } from "@/lib/financial-intelligence/job-profitability";
import { BURDEN_ASSUMPTION_MESSAGE } from "@/lib/financial-intelligence/labor-burden";
import type { FinancialIntelligence } from "@/lib/financial-intelligence/build";

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
      ["Honesty", "Coverage", intel.cashFlow.coverage, "fact", "Recorded TBBT transactions only"],
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
        "Outstanding remaining balance",
        `${intel.outstandingReceivables.count}:${intel.outstandingReceivables.amount}`,
        "fact",
        "SENT invoice remaining balance after recorded payments. Not the original invoice total after partial collection.",
      ],
      ...(["0-30", "31-60", "61-90", "90+"] as const).map((bucket) => [
        "Receivables aging",
        bucket,
        `${intel.receivables.buckets[bucket].count}:${intel.receivables.buckets[bucket].amount}`,
        "fact",
        "Age from invoice issued date. Due dates are not invented.",
      ]),
      [
        "Cash flow",
        "Collected customer payments",
        String(intel.cashFlow.collectedCustomerPayments),
        "fact",
        "Payment rows plus legacy PAID invoices with no Payment rows.",
      ],
      [
        "Cash flow",
        "Recorded expense outflows",
        String(intel.cashFlow.recordedExpenseOutflows),
        "fact",
        "Expense.occurredOn in range. Known cash out.",
      ],
      [
        "Cash flow",
        "Processed payroll gross labor",
        String(intel.cashFlow.processedPayrollGrossLabor),
        "recorded-operational-cost",
        intel.cashFlow.payrollNote,
      ],
      [
        "Cash flow",
        "Verified payroll bank outflows",
        String(intel.cashFlow.processedPayrollOutflows),
        "fact",
        "Zero unless TBBT later receives an authoritative disbursement/bank record.",
      ],
      [
        "Cash flow",
        "Known net",
        String(intel.cashFlow.netKnown),
        "fact",
        "Collected in minus recorded expense out. Processed payroll gross is not subtracted as verified bank movement.",
      ],
      [
        "Labor burden",
        "Configured burden rate",
        intel.laborBurden.burdenRate == null ? "" : String(intel.laborBurden.burdenRate),
        intel.laborBurden.burdenRate == null ? "unconfigured" : "owner-assumption",
        BURDEN_ASSUMPTION_MESSAGE,
      ],
      [
        "Range semantics",
        "Job profitability",
        intel.jobMarginKind,
        "label",
        intel.jobMarginLabel,
      ],
      ...intel.jobProfitability.map((row) => [
        "Job profitability",
        row.customerName,
        row.grossProfit == null ? "" : String(row.grossProfit),
        row.completeness.laborCostComplete ? "fact" : "incomplete",
        `${WHOLE_JOB_RANGE_LABEL} Billed ${row.billedRevenue} collected ${row.collectedRevenue} recorded direct cost ${row.recordedDirectCost ?? ""} burden-adjusted scenario ${row.burdenAdjustedDirectCost ?? ""}`,
      ]),
      ...intel.serviceProfitability.map((row) => [
        "Service profitability",
        row.name,
        row.grossProfit == null ? "" : String(row.grossProfit),
        row.attributed ? "fact" : "unattributed",
        `Jobs ${row.jobs} billed ${row.revenue ?? 0} recorded direct cost ${row.directCost ?? ""}`,
      ]),
      ...intel.customerProfitability.map((row) => [
        "Customer profitability",
        row.name,
        row.grossProfit == null ? "" : String(row.grossProfit),
        "fact",
        `Invoiced ${row.invoiced} collected ${row.collected} outstanding remaining ${row.outstandingReceivables}`,
      ]),
      ...intel.recurringSuggestions.map((row) => [
        "Recurring expenses",
        row.description,
        String(row.suggestedAmount),
        row.ownerStatus === "CONFIRMED" ? "owner-confirmed" : "suggestion",
        `${row.ownerStatus} · ${row.occurrenceCount} occurrences. ${(row.why ?? []).join(" ")} Not a liability.`,
      ]),
      ...intel.pricingRecommendations.map((row) => [
        "Pricing intelligence",
        row.title,
        row.currentResult,
        "owner-review",
        `${row.sampleSize} sample. ${row.proposedAction}`,
      ]),
    ],
  };
}

export function jobProfitabilityCsvRows(intel: FinancialIntelligence) {
  return {
    headers: [
      "Job",
      "Customer",
      "Status",
      "Contracted",
      "Billed",
      "Collected",
      "Outstanding remaining",
      "Approved labor hours",
      "Recorded wage labor cost",
      "Recorded materials/direct expenses",
      "Recorded direct cost",
      "Owner-configured burden %",
      "Burden-adjusted direct-cost scenario",
      "Gross profit (billed minus recorded direct cost)",
      "Gross margin % (billed)",
      "Burden-adjusted margin scenario %",
      "Customer labor charge",
      "Estimated labor hours (snapshot only)",
      "Estimated labor cost (cost snapshot only)",
      "Customer material charge",
      "Estimated material cost (takeoff only)",
      "Range semantics",
    ],
    rows: intel.jobProfitability.map((row) => [
      row.jobId,
      row.customerName,
      row.status,
      row.contractedRevenue == null ? "" : String(row.contractedRevenue),
      String(row.billedRevenue),
      String(row.collectedRevenue),
      String(row.outstandingReceivable),
      String(row.laborHours),
      row.recordedWageLaborCost == null ? "" : String(row.recordedWageLaborCost),
      String(row.materialsDirectExpense + row.otherAllocatedDirectExpense),
      row.recordedDirectCost == null ? "" : String(row.recordedDirectCost),
      row.laborBurden.burdenRate == null ? "" : String(row.laborBurden.burdenRate),
      row.burdenAdjustedDirectCost == null ? "" : String(row.burdenAdjustedDirectCost),
      row.grossProfit == null ? "" : String(row.grossProfit),
      row.grossMarginPct == null ? "" : String(row.grossMarginPct),
      row.burdenAdjustedMarginPct == null ? "" : String(row.burdenAdjustedMarginPct),
      row.estimateActual.customerLaborCharge == null ? "" : String(row.estimateActual.customerLaborCharge),
      row.estimateActual.estimatedLaborHours == null ? "" : String(row.estimateActual.estimatedLaborHours),
      row.estimateActual.estimatedLaborCost == null ? "" : String(row.estimateActual.estimatedLaborCost),
      row.estimateActual.customerMaterialCharge == null ? "" : String(row.estimateActual.customerMaterialCharge),
      row.estimateActual.estimatedMaterialCost == null ? "" : String(row.estimateActual.estimatedMaterialCost),
      intel.jobMarginLabel,
    ]),
  };
}

export function receivablesCsvRows(intel: FinancialIntelligence) {
  return {
    headers: ["Invoice", "Customer", "Job", "Issued", "Age days", "Bucket", "Invoice total", "Collected", "Remaining balance due", "Due date"],
    rows: intel.receivables.rows.map((row) => [
      row.invoiceId,
      row.customerName,
      row.jobId ?? "",
      row.issuedAt.toISOString(),
      String(row.ageDays),
      row.agingBucket,
      String(row.invoiceTotal),
      String(row.collectedAgainstInvoice),
      String(row.balanceDue),
      "",
    ]),
  };
}

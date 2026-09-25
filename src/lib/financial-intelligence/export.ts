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
        "Outstanding SENT invoices",
        `${intel.outstandingReceivables.count}:${intel.outstandingReceivables.amount}`,
        "fact",
        "Unpaid sent invoices. Not collected cash.",
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
        intel.cashFlow.coverage,
      ],
      [
        "Cash flow",
        "Recorded expense outflows",
        String(intel.cashFlow.recordedExpenseOutflows),
        "fact",
        "Expense.occurredOn in range",
      ],
      [
        "Cash flow",
        "Processed payroll outflows",
        String(intel.cashFlow.processedPayrollOutflows),
        "fact",
        "PROCESSED payroll only",
      ],
      [
        "Cash flow",
        "Known net",
        String(intel.cashFlow.netKnown),
        "fact",
        "Collected in minus recorded out. Not a bank balance.",
      ],
      [
        "Labor burden",
        "Configured burden rate",
        intel.laborBurden.burdenRate == null ? "" : String(intel.laborBurden.burdenRate),
        intel.laborBurden.burdenRate == null ? "unconfigured" : "fact",
        "Null means wage-only. No default percentage is invented.",
      ],
      ...intel.jobProfitability.map((row) => [
        "Job profitability",
        row.customerName,
        row.grossProfit == null ? "" : String(row.grossProfit),
        row.completeness.laborCostComplete ? "fact" : "incomplete",
        `Billed ${row.billedRevenue} collected ${row.collectedRevenue} cost ${row.knownTotalDirectCost ?? ""}`,
      ]),
      ...intel.serviceProfitability.map((row) => [
        "Service profitability",
        row.name,
        row.grossProfit == null ? "" : String(row.grossProfit),
        row.attributed ? "fact" : "unattributed",
        `Jobs ${row.jobs} billed ${row.revenue ?? 0} cost ${row.directCost ?? ""}`,
      ]),
      ...intel.customerProfitability.map((row) => [
        "Customer profitability",
        row.name,
        row.grossProfit == null ? "" : String(row.grossProfit),
        "fact",
        `Invoiced ${row.invoiced} collected ${row.collected} outstanding ${row.outstandingReceivables}`,
      ]),
      ...intel.recurringSuggestions.map((row) => [
        "Recurring expenses",
        row.description,
        String(row.suggestedAmount),
        row.ownerStatus === "CONFIRMED" ? "confirmed" : "suggestion",
        `${row.ownerStatus} · ${row.occurrenceCount} occurrences. Not a liability.`,
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
      "Labor hours",
      "Wage-only labor",
      "Burden rate",
      "Labor with burden",
      "Materials",
      "Other direct",
      "Known direct cost",
      "Gross profit",
      "Gross margin %",
    ],
    rows: intel.jobProfitability.map((row) => [
      row.jobId,
      row.customerName,
      row.status,
      row.contractedRevenue == null ? "" : String(row.contractedRevenue),
      String(row.billedRevenue),
      String(row.collectedRevenue),
      String(row.laborHours),
      row.directLaborCost == null ? "" : String(row.directLaborCost),
      row.laborBurden.burdenRate == null ? "" : String(row.laborBurden.burdenRate),
      row.laborBurden.laborCostWithBurden == null ? "" : String(row.laborBurden.laborCostWithBurden),
      String(row.materialsDirectExpense),
      String(row.otherAllocatedDirectExpense),
      row.knownTotalDirectCost == null ? "" : String(row.knownTotalDirectCost),
      row.grossProfit == null ? "" : String(row.grossProfit),
      row.grossMarginPct == null ? "" : String(row.grossMarginPct),
    ]),
  };
}

export function receivablesCsvRows(intel: FinancialIntelligence) {
  return {
    headers: ["Invoice", "Customer", "Job", "Issued", "Age days", "Bucket", "Invoice total", "Collected", "Balance due", "Due date"],
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

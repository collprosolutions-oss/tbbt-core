import type { FinancialIntelligence } from "@/lib/financial-intelligence/build";

export type BsosFinancialSignal = {
  key: string;
  kind: "fact";
  label: string;
  detail: string;
  href: string;
  priority: number;
};

/** Recorded-fact hooks for the BSOS recommendation engine. */
export function financialSignalsForBsos(intel: FinancialIntelligence): BsosFinancialSignal[] {
  const signals: BsosFinancialSignal[] = [];
  if (intel.outstandingReceivables.count > 0) {
    signals.push({
      key: "outstanding-receivables",
      kind: "fact",
      label: `${intel.outstandingReceivables.count} unpaid invoice${intel.outstandingReceivables.count === 1 ? "" : "s"} on file`,
      detail: "Recorded SENT invoices only. Not collected cash.",
      href: "/reports?area=receivables",
      priority: 10,
    });
  }
  const aged = intel.receivables.rows.filter((row) => row.ageDays > 30);
  if (aged.length > 0) {
    signals.push({
      key: "aged-receivables",
      kind: "fact",
      label: `${aged.length} receivable${aged.length === 1 ? "" : "s"} older than 30 days`,
      detail: "Age uses the invoice issued date. Due dates are not invented.",
      href: "/reports?area=receivables",
      priority: 8,
    });
  }
  const lowMargin = intel.serviceProfitability.filter(
    (row) => row.attributed && row.grossProfit != null && row.grossProfit < 0,
  );
  if (lowMargin.length > 0) {
    signals.push({
      key: "low-margin-services",
      kind: "fact",
      label: `${lowMargin.length} service${lowMargin.length === 1 ? "" : "s"} with negative recorded margin`,
      detail: "Billed revenue minus known direct cost on attributed jobs.",
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
  if (intel.laborCostTrend.some((row) => row.recordedMargin == null) || intel.jobProfitability.some((job) => !job.completeness.laborCostComplete && job.completeness.hasTimeEntries)) {
    signals.push({
      key: "missing-wage-data",
      kind: "fact",
      label: "Approved labor is missing a wage snapshot",
      detail: "TBBT will not invent an hourly rate or a burden percentage.",
      href: "/time-cards",
      priority: 15,
    });
  }
  const overruns = intel.jobProfitability.filter(
    (job) => job.estimateActual.laborHoursVariance != null && job.estimateActual.laborHoursVariance > 0,
  );
  if (overruns.length >= 2) {
    signals.push({
      key: "estimate-labor-overrun",
      kind: "fact",
      label: `${overruns.length} jobs used more labor hours than estimated`,
      detail: "Variance compares approved time to estimated LABOR quantity.",
      href: "/reports?area=estimate-accuracy",
      priority: 22,
    });
  }
  const collected = intel.customerProfitability.reduce((sum, row) => sum + row.collected, 0);
  const top = intel.customerProfitability[0];
  if (top && collected > 0 && top.collected / collected >= 0.4 && intel.customerProfitability.length >= 2) {
    signals.push({
      key: "customer-concentration",
      kind: "fact",
      label: `${top.name} is ${Math.round((top.collected / collected) * 100)}% of collected revenue`,
      detail: "Concentration uses recorded collected cash, not sent invoices.",
      href: "/reports?area=customers",
      priority: 35,
    });
  }
  return signals;
}

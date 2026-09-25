/**
 * Financial specialist — thin read/explain interpreter.
 *
 * Reuses the turn-scoped Financial Intelligence snapshot already built
 * for the canonical catalog. Performs no LLM call, no domain writes,
 * and no second FinancialSource load.
 */
import type { CanonicalRecommendationCatalog } from "@/lib/chief-of-staff/recommendations";
import {
  EMPTY_FINANCIAL_SNAPSHOT,
  recordFinancialSpecialistInterpretation,
} from "@/lib/chief-of-staff/financial-snapshot";
import type { SpecialistContext, SpecialistResult } from "@/lib/chief-of-staff/types";
import type { FinancialIntelligence } from "@/lib/financial-intelligence";

export const FINANCIAL_OWNED_RECOMMENDATION_KEYS = [
  "collect-unpaid-invoices",
  "receivable-needs-attention",
  "review-low-margin-jobs",
  "service-margin-below-target",
  "missing-wage-data",
  "estimate-labor-overrun",
  "review-recurring-expenses",
  "expense-growth",
  "high-value-customer-concentration",
] as const;

export type FinancialOwnedRecommendationKey = (typeof FINANCIAL_OWNED_RECOMMENDATION_KEYS)[number];

export const FINANCIAL_CONTEXT_CAPS = {
  receivables: 5,
  profitabilityJobs: 5,
  services: 4,
  customers: 4,
  recurringSuggestions: 3,
  pricingFindings: 3,
  entityRefs: 8,
  facts: 24,
} as const;

export const FINANCIAL_ENTITLEMENT_LIMITATION =
  "This workspace is not entitled to Reporting Insights. Deep Financial intelligence was not loaded. No revenue, receivables, or profitability figures were invented.";

export const FINANCIAL_FAILURE_LIMITATION =
  "Recorded Financial Intelligence could not be loaded. No substitute revenue, receivables, or profitability figures were invented.";

export function isFinancialOwnedRecommendationKey(key: string): key is FinancialOwnedRecommendationKey {
  return (FINANCIAL_OWNED_RECOMMENDATION_KEYS as readonly string[]).includes(key);
}

function money(value: number) {
  return value.toFixed(2);
}

function addFact(facts: Record<string, string>, keys: string[], key: string, value: string) {
  if (keys.includes(key) || keys.length >= FINANCIAL_CONTEXT_CAPS.facts) return;
  facts[key] = value;
  keys.push(key);
}

function pushEntity(ids: string[], value: string | null | undefined) {
  if (!value || ids.includes(value) || ids.length >= FINANCIAL_CONTEXT_CAPS.entityRefs) return;
  ids.push(value);
}

export function projectFinancialContext(
  catalog: CanonicalRecommendationCatalog,
  question: string,
  intel: FinancialIntelligence,
  entityHints?: { jobId?: string; recommendationKey?: string },
): SpecialistContext {
  const facts: Record<string, string> = {};
  const factKeys: string[] = [];
  const entityIds: string[] = [];
  if (entityHints?.jobId) pushEntity(entityIds, entityHints.jobId);

  addFact(facts, factKeys, "collected-customer-cash", money(intel.cashFlow.collectedCustomerPayments));
  addFact(
    facts,
    factKeys,
    "outstanding-receivables",
    `${intel.outstandingReceivables.count}/${money(intel.outstandingReceivables.amount)}`,
  );

  const aged = intel.receivables.rows.filter((row) => row.ageDays > 30);
  addFact(
    facts,
    factKeys,
    "aging-summary",
    `${aged.length}/${money(aged.reduce((sum, row) => sum + row.balanceDue, 0))}; due-dates-not-invented`,
  );

  const incompleteLabor = intel.jobProfitability.filter(
    (job) => !job.completeness.laborCostComplete && job.completeness.hasTimeEntries,
  );
  const laborUnknown = incompleteLabor.length > 0 || catalog.facts.missingWageEntries.count > 0;
  addFact(facts, factKeys, "labor-cost-completeness", laborUnknown ? "incomplete/unknown" : "complete-on-recorded-time");
  addFact(
    facts,
    factKeys,
    "burden-configuration",
    intel.laborBurden.burdenRate == null ? "unconfigured" : "configured",
  );
  addFact(
    facts,
    factKeys,
    "target-margin-configuration",
    intel.laborBurden.targetGrossMarginRate == null ? "unconfigured" : "configured",
  );
  addFact(facts, factKeys, "bank-connected", intel.bankConnected ? "true" : "false");
  addFact(facts, factKeys, "accounting-connected", intel.accountingConnected ? "true" : "false");
  addFact(facts, factKeys, "projected-bank-balance", "unknown");
  addFact(facts, factKeys, "projected-accounting-balance", "unknown");
  addFact(
    facts,
    factKeys,
    "expense-change",
    catalog.facts.expenseGrowthPercent == null
      ? "not-comparable"
      : `${catalog.facts.expenseGrowthPercent.toFixed(1)}%`,
  );
  addFact(facts, factKeys, "recorded-expenses", money(intel.cashFlow.recordedExpenseOutflows));
  addFact(facts, factKeys, "payroll-gross-not-cash", "PROCESSED payroll gross is not verified bank outflow");

  const completedWithCost = intel.jobProfitability.filter(
    (job) => job.status === "COMPLETED" && job.completeness.laborCostComplete && job.recordedDirectCost != null,
  );
  addFact(
    facts,
    factKeys,
    "pricing-sample",
    completedWithCost.length === 0 ? "no-completed-jobs-with-complete-cost" : String(completedWithCost.length),
  );

  const negativeJobs = intel.jobProfitability
    .filter((job) => job.grossProfit != null && job.grossProfit < 0)
    .sort((a, b) => (a.grossProfit ?? 0) - (b.grossProfit ?? 0))
    .slice(0, FINANCIAL_CONTEXT_CAPS.profitabilityJobs);
  addFact(facts, factKeys, "low-margin-job-count", String(negativeJobs.length));
  if (negativeJobs[0]) {
    addFact(facts, factKeys, "lowest-margin-job", `${money(negativeJobs[0].grossProfit ?? 0)}`);
    pushEntity(entityIds, negativeJobs[0].jobId);
  }

  const receivableRows = intel.receivables.rows
    .filter((row) => row.balanceDue > 0)
    .sort((a, b) => b.balanceDue - a.balanceDue || b.ageDays - a.ageDays)
    .slice(0, FINANCIAL_CONTEXT_CAPS.receivables);
  addFact(
    facts,
    factKeys,
    "receivables-top",
    receivableRows.map((row) => `${money(row.balanceDue)}:${row.ageDays}d:${row.agingBucket}`).join("|") || "none",
  );
  for (const row of receivableRows) pushEntity(entityIds, row.invoiceId);

  const services = intel.serviceProfitability
    .filter((row) => row.attributed)
    .slice(0, FINANCIAL_CONTEXT_CAPS.services);
  addFact(
    facts,
    factKeys,
    "services-top",
    services
      .map((row) => `${row.grossProfit == null ? "unknown" : money(row.grossProfit)}`)
      .join("|") || "none",
  );

  const customers = intel.customerProfitability.slice(0, FINANCIAL_CONTEXT_CAPS.customers);
  const collected = intel.cashFlow.collectedCustomerPayments;
  const topCustomer = customers[0];
  addFact(
    facts,
    factKeys,
    "customer-concentration",
    topCustomer && collected > 0
      ? `${Math.round((topCustomer.collected / collected) * 100)}%`
      : "none",
  );

  const recurring = intel.recurringSuggestions.slice(0, FINANCIAL_CONTEXT_CAPS.recurringSuggestions);
  addFact(facts, factKeys, "recurring-suggestions", String(recurring.length));

  const ownedRecs = catalog.activeRecommendations.filter((item) =>
    isFinancialOwnedRecommendationKey(item.key),
  );
  const findings = ownedRecs.map((item) => ({
    key: item.key,
    title: item.title,
    why: item.why,
  }));

  findings.push({
    key: "financial-collected-cash",
    title: "Collected customer cash",
    why: `Recorded collected customer cash is ${money(intel.cashFlow.collectedCustomerPayments)}. Payment rows are collected-revenue truth. SENT invoice totals are not collected cash.`,
  });
  findings.push({
    key: "financial-outstanding-receivables",
    title: "Outstanding receivables",
    why: `${intel.outstandingReceivables.count} SENT invoice(s) have ${money(intel.outstandingReceivables.amount)} remaining. Remaining SENT balance is receivable truth. Due dates are not invented.`,
  });

  if (laborUnknown) {
    findings.push({
      key: "financial-labor-cost-unknown",
      title: "Labor cost is incomplete",
      why: "Missing wage stays unknown/incomplete. TBBT does not invent an hourly rate or treat missing burden as 0%.",
    });
  }
  if (intel.laborBurden.burdenRate == null) {
    findings.push({
      key: "financial-burden-unconfigured",
      title: "Labor burden is unconfigured",
      why: "No employer labor burden is configured. That is unconfigured, not 0%.",
    });
  }
  if (intel.laborBurden.targetGrossMarginRate == null) {
    findings.push({
      key: "financial-target-margin-unconfigured",
      title: "Target margin is unconfigured",
      why: "No owner target margin is configured. That is unconfigured, not 0%.",
    });
  }
  if (!intel.bankConnected) {
    findings.push({
      key: "financial-bank-not-connected",
      title: "Bank is not connected",
      why: `${intel.messages.bank} No bank balance was invented.`,
    });
  }
  if (!intel.accountingConnected) {
    findings.push({
      key: "financial-accounting-not-connected",
      title: "Accounting is not connected",
      why: `${intel.messages.accounting} No accounting balance was invented.`,
    });
  }
  for (const job of negativeJobs) {
    findings.push({
      key: `financial-negative-job:${job.jobId}`,
      title: "Low-margin job",
      why: `Recorded gross profit on a completed job is ${money(job.grossProfit ?? 0)}. This uses billed revenue minus recorded direct cost.`,
    });
    pushEntity(entityIds, job.jobId);
  }
  if (completedWithCost.length > 0) {
    for (const rec of intel.pricingRecommendations.slice(0, FINANCIAL_CONTEXT_CAPS.pricingFindings)) {
      findings.push({
        key: `financial-pricing:${rec.key}`,
        title: rec.title,
        why: rec.currentResult,
      });
    }
  }
  for (const suggestion of recurring) {
    findings.push({
      key: `financial-recurring:${suggestion.patternKey}`,
      title: "Recurring expense pattern",
      why: suggestion.why[0] ?? "A recurring expense pattern is on file from recorded Expense rows.",
    });
  }

  return {
    specialistId: "FINANCIAL",
    question,
    factKeys,
    recommendationKeys: ownedRecs.map((item) => item.key),
    facts,
    findings,
    entityHints: {
      jobId: entityHints?.jobId ?? entityIds[0],
      recommendationKey: entityHints?.recommendationKey,
    },
  };
}

export function interpretFinancialSpecialist(
  catalog: CanonicalRecommendationCatalog,
  question: string,
  entityHints?: { jobId?: string; recommendationKey?: string },
): SpecialistResult {
  recordFinancialSpecialistInterpretation();
  const snapshot = catalog.financial ?? EMPTY_FINANCIAL_SNAPSHOT;
  if (!snapshot.entitled) {
    return {
      specialistId: "FINANCIAL",
      status: "SKIPPED",
      findings: [],
      factKeys: [],
      recommendationKeys: [],
      limitation: FINANCIAL_ENTITLEMENT_LIMITATION,
    };
  }
  if (snapshot.failed || !snapshot.intelligence) {
    return {
      specialistId: "FINANCIAL",
      status: "FAILED",
      findings: [],
      factKeys: [],
      recommendationKeys: [],
      limitation: FINANCIAL_FAILURE_LIMITATION,
      failure: {
        specialistId: "FINANCIAL",
        message: snapshot.failureMessage ?? "Financial Intelligence could not be loaded.",
      },
    };
  }

  const context = projectFinancialContext(catalog, question, snapshot.intelligence, entityHints);
  const entityIds: string[] = [];
  if (context.entityHints?.jobId) pushEntity(entityIds, context.entityHints.jobId);
  for (const job of snapshot.intelligence.jobProfitability
    .filter((job) => job.grossProfit != null && job.grossProfit < 0)
    .slice(0, FINANCIAL_CONTEXT_CAPS.profitabilityJobs)) {
    pushEntity(entityIds, job.jobId);
  }
  for (const row of snapshot.intelligence.receivables.rows
    .filter((row) => row.balanceDue > 0)
    .slice(0, FINANCIAL_CONTEXT_CAPS.receivables)) {
    pushEntity(entityIds, row.invoiceId);
  }

  return {
    specialistId: "FINANCIAL",
    status: "OK",
    findings: context.findings.map((item) => ({
      key: item.key,
      title: item.title,
      summary: item.why,
      recommendationKeys: isFinancialOwnedRecommendationKey(item.key) ? [item.key] : [],
      factKeys: context.factKeys,
      entityIds: entityIds.length > 0 ? entityIds : undefined,
    })),
    factKeys: context.factKeys,
    recommendationKeys: context.recommendationKeys,
  };
}

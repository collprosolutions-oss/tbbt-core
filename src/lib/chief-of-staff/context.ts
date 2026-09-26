/**
 * Specialist context projection. ATTENTION still reads already-loaded
 * BSOS catalog facts. FINANCIAL and GROWTH reuse turn snapshots. Deep
 * WORKFORCE explanation lives in workforce-specialist.ts and reuses the
 * catalog snapshot. MATERIALS and COMMUNICATIONS load bounded
 * projections only when selected. KNOWLEDGE_LAUNCH and
 * BUSINESS_PROTECTION load bounded projections only when selected.
 * Disabled specialists never deep-load.
 */
import type { BsosFacts, BsosRecommendation } from "@/lib/bsos";
import { getSpecialistEntry, isSpecialistEnabled } from "@/lib/chief-of-staff/registry";
import { projectGrowthContext } from "@/lib/chief-of-staff/growth-specialist";
import { projectFinancialContext } from "@/lib/chief-of-staff/specialists/financial";
import type { CosEntityHints, SpecialistContext, SpecialistId } from "@/lib/chief-of-staff/types";
import type { CanonicalRecommendationCatalog } from "@/lib/chief-of-staff/recommendations";

const deepLoaderInvocations: SpecialistId[] = [];

export function resetDeepLoaderInvocations() {
  deepLoaderInvocations.length = 0;
}

export function getDeepLoaderInvocations() {
  return deepLoaderInvocations.slice();
}

function recordDeepLoader(id: SpecialistId) {
  deepLoaderInvocations.push(id);
}

export function loadFinancialDeep(): never {
  recordDeepLoader("FINANCIAL");
  throw new Error("Financial deep specialist is disabled in PR1.");
}

export function loadGrowthDeep(): never {
  recordDeepLoader("GROWTH");
  throw new Error("Growth specialist reuses the catalog snapshot and must not deep-load independently.");
}

export function loadKnowledgeLaunchDeep(): never {
  recordDeepLoader("KNOWLEDGE_LAUNCH");
  throw new Error("Knowledge/Launch specialist loads a bounded projection when selected and must not use the workspace deep-loader.");
}

export function loadMaterialsDeep(): never {
  recordDeepLoader("MATERIALS");
  throw new Error("Materials specialist loads a bounded projection when selected and must not use the workspace deep-loader.");
}

export function loadCommunicationsDeep(): never {
  recordDeepLoader("COMMUNICATIONS");
  throw new Error("Communications specialist loads a bounded projection when selected and must not use the workspace deep-loader.");
}

export function loadBusinessProtectionDeep(): never {
  recordDeepLoader("BUSINESS_PROTECTION");
  throw new Error("Business Protection specialist loads a bounded projection when selected and must not use the workspace deep-loader.");
}

const DISABLED_DEEP_LOADERS: Partial<Record<SpecialistId, () => never>> = {};

function factValue(facts: BsosFacts, key: string): string | null {
  switch (key) {
    case "paid-revenue":
      return facts.paidRevenue.amount.toFixed(2);
    case "recorded-expenses":
      return facts.recordedExpenses.amount.toFixed(2);
    case "unpaid-invoices":
      return `${facts.unpaidInvoices.count}/${facts.unpaidInvoices.amount.toFixed(2)}`;
    case "sent-estimates":
      return String(facts.sentEstimates.count);
    case "low-margin":
      return String(facts.lowMarginJobs.count);
    case "missing-wage":
      return String(facts.missingWageEntries.count);
    case "repeat-customers":
      return String(facts.repeatCustomers.count);
    case "review-opportunities":
      return String(facts.completedJobsWithoutReview.count);
    case "marketing-ready":
      return String(facts.completedJobsReadyForMarketing.count);
    case "recurring-expenses":
      return `${facts.recurringExpenses.count}/${facts.recurringExpenses.amount.toFixed(2)}`;
    case "growth-recovery":
      return facts.growthRecoveryOpen == null ? null : String(facts.growthRecoveryOpen.count);
    case "growth-reactivation":
      return facts.growthReactivationEligible == null ? null : String(facts.growthReactivationEligible.count);
    case "launch-incomplete":
      return String(facts.launchIncompleteSteps.count);
    case "knowledge-unreviewed":
      return String(facts.knowledgeNeedsApproval.count);
    case "experience-candidates":
      return String(facts.experienceCandidates.count);
    case "aged-receivables":
      return facts.agedReceivables
        ? `${facts.agedReceivables.count}/${facts.agedReceivables.amount.toFixed(2)}`
        : "0/0.00";
    case "available-capacity":
      return String(facts.availableCapacityDays.count);
    case "unscheduled-jobs":
      return String(facts.unscheduledJobs.count);
    default:
      return null;
  }
}

function projectFacts(facts: BsosFacts, keys: string[]) {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = factValue(facts, key);
    if (value != null) out[key] = value;
  }
  return out;
}

function asFindings(recommendations: BsosRecommendation[]) {
  return recommendations.map((item) => ({
    key: item.key,
    title: item.title,
    why: item.why,
  }));
}

export function loadSpecialistContext(
  specialistId: SpecialistId,
  catalog: CanonicalRecommendationCatalog,
  question: string,
  entityHints?: CosEntityHints,
): SpecialistContext {
  const entry = getSpecialistEntry(specialistId);
  if (!entry.enabled || !isSpecialistEnabled(specialistId)) {
    const loader = DISABLED_DEEP_LOADERS[specialistId];
    if (loader) loader();
    throw new Error(`${specialistId} is disabled and cannot load context.`);
  }
  if (entry.deepLoader) {
    const loader = DISABLED_DEEP_LOADERS[specialistId];
    if (loader) loader();
  }

  if (specialistId === "ATTENTION") {
    const keys = [
      "paid-revenue",
      "recorded-expenses",
      "unpaid-invoices",
      "sent-estimates",
      "low-margin",
      "missing-wage",
      "repeat-customers",
      "review-opportunities",
      "marketing-ready",
      "recurring-expenses",
      "growth-recovery",
      "growth-reactivation",
      "launch-incomplete",
      "knowledge-unreviewed",
      "experience-candidates",
      "aged-receivables",
      "available-capacity",
      "unscheduled-jobs",
    ];
    const facts = projectFacts(catalog.facts, keys);
    return {
      specialistId,
      question,
      factKeys: keys.filter((key) => facts[key] != null),
      recommendationKeys: catalog.activeRecommendations.map((item) => item.key),
      facts,
      findings: asFindings(catalog.activeRecommendations.filter((item) => !item.key.startsWith("workforce-"))),
      entityHints,
    };
  }

  if (specialistId === "WORKFORCE") {
    const workforceRecs = catalog.activeRecommendations.filter((item) => item.key.startsWith("workforce-"));
    const keys = ["available-capacity", "unscheduled-jobs", "missing-wage"];
    return {
      specialistId,
      question,
      factKeys: keys,
      recommendationKeys: workforceRecs.map((item) => item.key),
      facts: projectFacts(catalog.facts, keys),
      findings: asFindings(workforceRecs),
      entityHints,
    };
  }

  if (specialistId === "FINANCIAL") {
    const snapshot = catalog.financial;
    if (!snapshot?.entitled || snapshot.failed || !snapshot.intelligence) {
      throw new Error("FINANCIAL context requires a loaded Reporting Insights snapshot.");
    }
    return projectFinancialContext(catalog, question, snapshot.intelligence, entityHints);
  }

  if (specialistId === "GROWTH") {
    const snapshot = catalog.growth;
    if (!snapshot?.entitled || snapshot.failed || !snapshot.source) {
      throw new Error("GROWTH context requires a loaded Marketing Tools and Reporting Insights snapshot.");
    }
    return projectGrowthContext(catalog, question, snapshot.source, entityHints);
  }

  throw new Error(`${specialistId} has no context loader.`);
}

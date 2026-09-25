/**
 * Specialist context projection. Reads already-loaded catalog facts.
 * Disabled specialists never deep-load. FINANCIAL reuses the turn snapshot.
 */
import type { BsosFacts, BsosRecommendation } from "@/lib/bsos";
import { getSpecialistEntry, isSpecialistEnabled } from "@/lib/chief-of-staff/registry";
import { projectFinancialContext } from "@/lib/chief-of-staff/specialists/financial";
import type { SpecialistContext, SpecialistId } from "@/lib/chief-of-staff/types";
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
  throw new Error("Growth deep specialist is disabled in PR1.");
}

export function loadKnowledgeLaunchDeep(): never {
  recordDeepLoader("KNOWLEDGE_LAUNCH");
  throw new Error("Knowledge/Launch deep specialist is disabled in PR1.");
}

export function loadMaterialsDeep(): never {
  recordDeepLoader("MATERIALS");
  throw new Error("Materials deep specialist is disabled in PR1.");
}

export function loadCommunicationsDeep(): never {
  recordDeepLoader("COMMUNICATIONS");
  throw new Error("Communications deep specialist is disabled in PR1.");
}

export function loadBusinessProtectionDeep(): never {
  recordDeepLoader("BUSINESS_PROTECTION");
  throw new Error("Business Protection deep specialist is disabled in PR1.");
}

const DISABLED_DEEP_LOADERS: Partial<Record<SpecialistId, () => never>> = {
  GROWTH: loadGrowthDeep,
  KNOWLEDGE_LAUNCH: loadKnowledgeLaunchDeep,
  MATERIALS: loadMaterialsDeep,
  COMMUNICATIONS: loadCommunicationsDeep,
  BUSINESS_PROTECTION: loadBusinessProtectionDeep,
};

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
      return String(facts.growthRecoveryOpen?.count ?? 0);
    case "growth-reactivation":
      return String(facts.growthReactivationEligible?.count ?? 0);
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
  entityHints?: { jobId?: string; recommendationKey?: string },
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
    return {
      specialistId,
      question,
      factKeys: keys,
      recommendationKeys: catalog.activeRecommendations.map((item) => item.key),
      facts: projectFacts(catalog.facts, keys),
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

  throw new Error(`${specialistId} has no context loader.`);
}

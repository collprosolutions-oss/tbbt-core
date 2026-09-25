/**
 * Deep GROWTH specialist. Same specialist identity as the PR1 placeholder.
 *
 * Reuses the GrowthSource already loaded for the canonical catalog.
 * Does not send messages, start campaigns, create GrowthActionRequest
 * rows, change consent, or write recommendations.
 */
import type { CanonicalRecommendationCatalog } from "@/lib/chief-of-staff/recommendations";
import {
  EMPTY_GROWTH_SNAPSHOT,
  recordGrowthSpecialistInterpretation,
  type GrowthTurnSnapshot,
} from "@/lib/chief-of-staff/growth-snapshot";
import type {
  CosEntityHints,
  SpecialistContext,
  SpecialistFinding,
  SpecialistResult,
} from "@/lib/chief-of-staff/types";
import {
  buildCampaignPerformance,
  buildGrowthFunnel,
  buildLocalGrowth,
  buildReactivationCandidates,
  buildRecoveryQueue,
  buildReferralAttribution,
  buildReviewConversion,
  buildSourcePerformance,
  type CampaignPerformance,
  type GrowthSource,
  type LocalGrowthArea,
  type ReactivationCandidate,
  type RecoveryItem,
} from "@/lib/growth-engine";
import { getProductCapabilityDefinition } from "@/lib/product-catalog";
import { PRODUCT_CAPABILITIES, type ProductCapabilityCode } from "@/lib/product-catalog/codes";

export const GROWTH_OWNED_RECOMMENDATION_KEYS = [
  "growth-lost-lead-recovery",
  "growth-reactivate-customers",
  "repeat-customer-follow-up",
  "request-reviews",
  "market-completed-jobs",
  "outside-area-leads",
] as const;

export type GrowthOwnedRecommendationKey = (typeof GROWTH_OWNED_RECOMMENDATION_KEYS)[number];

export const GROWTH_CONTEXT_CAPS = {
  recovery: 8,
  reactivation: 8,
  campaigns: 5,
  sources: 5,
  localAreas: 4,
  entityIds: 4,
  findings: 16,
  facts: 24,
} as const;

export const GROWTH_REQUIRED_PRODUCT_CAPABILITIES = [
  PRODUCT_CAPABILITIES.MARKETING_TOOLS,
  PRODUCT_CAPABILITIES.REPORTING_INSIGHTS,
] as const;

const FORBIDDEN_PROJECTION_KEYS = [
  "email",
  "phone",
  "contactValue",
  "consentToken",
  "smsConsentToken",
  "notes",
  "workforceNotes",
  "body",
  "requestText",
  "messageBody",
  "webhook",
  "payload",
  "secret",
  "apiKey",
  "authorization",
];

export function isGrowthOwnedRecommendationKey(key: string): key is GrowthOwnedRecommendationKey {
  return (GROWTH_OWNED_RECOMMENDATION_KEYS as readonly string[]).includes(key);
}

export function growthEntitlementLimitation(missing: readonly string[]) {
  const names = missing.map((code) => getProductCapabilityDefinition(code as ProductCapabilityCode).displayName);
  const listed =
    names.length === 2 ? `${names[0]} and ${names[1]}` : names[0] ?? "Marketing Tools and Reporting Insights";
  const noun = names.length === 1 ? "capability" : "capabilities";
  return `Growth intelligence was not loaded because this workspace does not have the required ${listed} ${noun}. Missing Growth data is not treated as zero opportunities.`;
}

export const GROWTH_FAILURE_LIMITATION =
  "Recorded Growth data could not be loaded. No empty pipeline, recovery queue, or zero opportunities were invented.";

export type GrowthRecoveryProjection = {
  requestId: string | null;
  estimateId: string | null;
  customerId: string | null;
  queue: string;
  label: string;
  value: number | null;
  outreachEligible: boolean;
  consentStatus: string;
  recovered: false;
};

export type GrowthReactivationProjection = {
  customerId: string;
  completedJobs: number;
  daysSinceCompleted: number | null;
  outreachEligible: boolean;
  consentStatus: string;
  contacted: false;
};

export type GrowthCampaignProjection = {
  campaignId: string | null;
  name: string;
  leads: number;
  wins: number;
  conversion: number | null;
  collectedRevenue: number;
  roi: number | null;
  roiKnown: boolean;
};

export type GrowthSourceProjection = {
  source: string;
  leads: number;
  wins: number;
  collectedRevenue: number;
  conversion: number | null;
  attributed: boolean;
};

export type GrowthProjectionTotals = {
  recovery: number;
  reactivationCandidates: number;
  reactivationEligible: number;
  campaigns: number;
  campaignsNeedingReview: number;
  sources: number;
  unattributedSources: number;
  unattributedLeads: number;
  reviewEligible: number;
  referrals: number;
  localOpportunities: number;
  funnelStages: number;
};

export type GrowthProjection = {
  totals: GrowthProjectionTotals;
  funnel: Array<{ key: string; label: string; count: number; amount: number | null }>;
  recovery: GrowthRecoveryProjection[];
  reactivation: GrowthReactivationProjection[];
  campaigns: GrowthCampaignProjection[];
  sources: GrowthSourceProjection[];
  reviews: {
    completedJobs: number;
    requestsPrepared: number;
    requestsSent: number;
    reviewsReceived: number;
    requestConversion: number | null;
  };
  referrals: { count: number; collectedRevenue: number };
  local: {
    opportunityCount: number;
    areas: Array<{ label: string; requestCount: number; contentOpportunity: boolean }>;
  };
  snapshotReused: true;
};

let lastGrowthProjection: GrowthProjection | null = null;

export function resetLastGrowthProjection() {
  lastGrowthProjection = null;
}

export function getLastGrowthProjection() {
  return lastGrowthProjection;
}

function addFact(facts: Record<string, string>, keys: string[], key: string, value: string) {
  if (keys.includes(key) || keys.length >= GROWTH_CONTEXT_CAPS.facts) return;
  facts[key] = value;
  keys.push(key);
}

function projectRecovery(item: RecoveryItem): GrowthRecoveryProjection {
  return {
    requestId: item.requestId,
    estimateId: item.estimateId,
    customerId: item.customerId,
    queue: item.queue,
    label: item.label,
    value: item.value,
    outreachEligible: item.anyOutreachEligible,
    consentStatus: item.smsConsentStatus,
    recovered: false,
  };
}

function projectReactivation(item: ReactivationCandidate): GrowthReactivationProjection {
  return {
    customerId: item.customerId,
    completedJobs: item.completedJobs,
    daysSinceCompleted: item.daysSinceCompleted,
    outreachEligible: item.anyOutreachEligible,
    consentStatus: item.smsConsentStatus,
    contacted: false,
  };
}

function projectCampaign(item: CampaignPerformance): GrowthCampaignProjection {
  return {
    campaignId: item.campaignId,
    name: item.name,
    leads: item.leads,
    wins: item.wins,
    conversion: item.conversion,
    collectedRevenue: item.collectedRevenue,
    roi: item.roi,
    roiKnown: item.costAvailable && item.roi != null,
  };
}

function projectSource(row: ReturnType<typeof buildSourcePerformance>[number]): GrowthSourceProjection {
  const attributed = row.source !== "UNKNOWN";
  return {
    source: attributed ? row.source : "UNKNOWN",
    leads: row.leads,
    wins: row.wins,
    collectedRevenue: row.collectedRevenue,
    conversion: row.leads > 0 ? row.conversion : null,
    attributed,
  };
}

function projectLocal(areas: LocalGrowthArea[]) {
  const content = areas.filter((row) => row.contentOpportunity);
  return {
    opportunityCount: content.length,
    areas: areas.slice(0, GROWTH_CONTEXT_CAPS.localAreas).map((row) => ({
      label: row.label,
      requestCount: row.requestCount,
      contentOpportunity: row.contentOpportunity,
    })),
  };
}

function assertSafeProjection(projection: GrowthProjection) {
  const raw = JSON.stringify(projection);
  for (const key of FORBIDDEN_PROJECTION_KEYS) {
    if (raw.includes(`"${key}"`)) {
      throw new Error("Growth projection leaked a forbidden field.");
    }
  }
}

export function growthProjectionHasForbiddenFields(value: unknown) {
  const raw = JSON.stringify(value);
  return FORBIDDEN_PROJECTION_KEYS.some(
    (key) => raw.includes(`"${key}"`) || new RegExp(`"${key}":`, "i").test(raw),
  );
}

function campaignNeedsReview(row: GrowthCampaignProjection) {
  return Boolean(row.campaignId) && (row.leads > 0 || !row.roiKnown);
}

export function projectGrowthFromSource(source: GrowthSource): GrowthProjection {
  const recoveryAll = buildRecoveryQueue(source);
  const reactivationAll = buildReactivationCandidates(source);
  const campaignsAll = buildCampaignPerformance(source)
    .sort((a, b) => b.leads - a.leads || b.collectedRevenue - a.collectedRevenue)
    .map(projectCampaign);
  const sourcesAll = buildSourcePerformance(source)
    .sort((a, b) => b.leads - a.leads || b.collectedRevenue - a.collectedRevenue)
    .map(projectSource);
  const reviews = buildReviewConversion(source);
  const referrals = buildReferralAttribution(source);
  const localAreas = buildLocalGrowth(source);
  const local = projectLocal(localAreas);
  const funnel = buildGrowthFunnel(source).stages.map((row) => ({
    key: row.key,
    label: row.label,
    count: row.count,
    amount: row.amount,
  }));
  const unattributed = sourcesAll.filter((row) => !row.attributed);
  const projection: GrowthProjection = {
    totals: {
      recovery: recoveryAll.length,
      reactivationCandidates: reactivationAll.length,
      reactivationEligible: reactivationAll.filter((row) => row.anyOutreachEligible).length,
      campaigns: campaignsAll.length,
      campaignsNeedingReview: campaignsAll.filter(campaignNeedsReview).length,
      sources: sourcesAll.length,
      unattributedSources: unattributed.length,
      unattributedLeads: unattributed.reduce((sum, row) => sum + row.leads, 0),
      reviewEligible: Math.max(0, reviews.completedJobs - reviews.requestsPrepared),
      referrals: referrals.length,
      localOpportunities: local.opportunityCount,
      funnelStages: funnel.length,
    },
    funnel,
    recovery: recoveryAll.slice(0, GROWTH_CONTEXT_CAPS.recovery).map(projectRecovery),
    reactivation: reactivationAll.slice(0, GROWTH_CONTEXT_CAPS.reactivation).map(projectReactivation),
    campaigns: campaignsAll.slice(0, GROWTH_CONTEXT_CAPS.campaigns),
    sources: sourcesAll.slice(0, GROWTH_CONTEXT_CAPS.sources),
    reviews: {
      completedJobs: reviews.completedJobs,
      requestsPrepared: reviews.requestsPrepared,
      requestsSent: reviews.requestsSent,
      reviewsReceived: reviews.reviewsReceived,
      requestConversion: reviews.requestConversion,
    },
    referrals: {
      count: referrals.length,
      collectedRevenue: referrals.reduce((sum, row) => sum + row.collectedRevenue, 0),
    },
    local,
    snapshotReused: true,
  };
  assertSafeProjection(projection);
  return projection;
}

function missingGrowthCapabilities(
  snapshot: GrowthTurnSnapshot,
  deny?: ProductCapabilityCode[],
): ProductCapabilityCode[] {
  const missing = new Set<ProductCapabilityCode>(snapshot.missingCapabilities);
  for (const code of GROWTH_REQUIRED_PRODUCT_CAPABILITIES) {
    if (deny?.includes(code)) missing.add(code);
  }
  return GROWTH_REQUIRED_PRODUCT_CAPABILITIES.filter((code) => missing.has(code));
}

export function projectGrowthContext(
  catalog: CanonicalRecommendationCatalog,
  question: string,
  source: GrowthSource,
  entityHints?: CosEntityHints,
): SpecialistContext {
  const projection = projectGrowthFromSource(source);
  lastGrowthProjection = projection;
  const facts: Record<string, string> = {};
  const factKeys: string[] = [];

  addFact(facts, factKeys, "growth-recovery", String(projection.totals.recovery));
  addFact(facts, factKeys, "growth-reactivation", String(projection.totals.reactivationEligible));
  addFact(facts, factKeys, "growth-funnel-stages", String(projection.totals.funnelStages));
  addFact(facts, factKeys, "growth-campaigns", String(projection.totals.campaigns));
  addFact(facts, factKeys, "growth-unattributed-sources", String(projection.totals.unattributedSources));
  addFact(facts, factKeys, "growth-unattributed-leads", String(projection.totals.unattributedLeads));
  addFact(facts, factKeys, "growth-review-eligible", String(projection.totals.reviewEligible));
  addFact(facts, factKeys, "growth-referrals", String(projection.totals.referrals));
  addFact(facts, factKeys, "growth-local-opportunities", String(projection.totals.localOpportunities));
  addFact(facts, factKeys, "review-opportunities", String(catalog.facts.completedJobsWithoutReview.count));
  addFact(facts, factKeys, "repeat-customers", String(catalog.facts.repeatCustomers.count));
  addFact(facts, factKeys, "marketing-ready", String(catalog.facts.completedJobsReadyForMarketing.count));

  const ownedRecs = catalog.activeRecommendations.filter((item) => isGrowthOwnedRecommendationKey(item.key));
  const findings: Array<{ key: string; title: string; why: string; entityIds?: string[] }> = ownedRecs.map(
    (item) => ({
      key: item.key,
      title: item.title,
      why: item.why,
    }),
  );

  if (projection.totals.recovery > 0) {
    findings.push({
      key: "growth-recovery-open",
      title: "Review recorded recovery opportunities",
      why: `${projection.totals.recovery} recorded recovery opportunit${projection.totals.recovery === 1 ? "y is" : "ies are"} open. These are follow-up opportunities, not closed sales. Open the Growth workspace to review them.`,
      entityIds: projection.recovery
        .map((row) => row.requestId ?? row.estimateId ?? row.customerId)
        .filter((id): id is string => Boolean(id))
        .slice(0, GROWTH_CONTEXT_CAPS.entityIds),
    });
  }
  if (projection.totals.reactivationCandidates > 0) {
    findings.push({
      key: "growth-reactivation-eligible",
      title: "Consider reactivation candidates",
      why: `${projection.totals.reactivationCandidates} prior customer${projection.totals.reactivationCandidates === 1 ? "" : "s"} meet reactivation rules (${projection.totals.reactivationEligible} outreach-eligible). Eligibility is not proof that outreach already happened. Review candidates in the Growth workspace.`,
      entityIds: projection.reactivation.map((row) => row.customerId).slice(0, GROWTH_CONTEXT_CAPS.entityIds),
    });
  }
  if (projection.totals.campaignsNeedingReview > 0) {
    findings.push({
      key: "growth-campaigns-review",
      title: "Review recorded campaign performance",
      why: `${projection.totals.campaignsNeedingReview} recorded campaign${projection.totals.campaignsNeedingReview === 1 ? "" : "s"} can be reviewed from attribution already on file. Performance is not invented when cost or conversion is incomplete. Open the Growth workspace.`,
    });
  }
  if (projection.totals.unattributedSources > 0 || projection.totals.unattributedLeads > 0) {
    findings.push({
      key: "growth-attribution-unknown",
      title: "Some attribution is unknown",
      why: `${projection.totals.unattributedLeads || projection.totals.unattributedSources} lead or source row${projection.totals.unattributedLeads === 1 ? "" : "s"} remain unattributed. Unknown attribution stays unknown; no source or marketing ROI was invented.`,
    });
  }
  const reviewEligible = projection.totals.reviewEligible;
  if (reviewEligible > 0 || catalog.facts.completedJobsWithoutReview.count > 0) {
    findings.push({
      key: "growth-review-eligible",
      title: "Review eligible review opportunities",
      why: `${reviewEligible || catalog.facts.completedJobsWithoutReview.count} completed job${(reviewEligible || catalog.facts.completedJobsWithoutReview.count) === 1 ? "" : "s"} can be considered for a review request. Eligibility is not a recorded review request.`,
    });
  }
  if (projection.referrals.count > 0 || catalog.facts.repeatCustomers.count > 0) {
    findings.push({
      key: "growth-referral-opportunities",
      title: "Review referral and repeat-customer opportunities",
      why:
        projection.referrals.count > 0
          ? `${projection.referrals.count} recorded referral${projection.referrals.count === 1 ? "" : "s"} are on file. Collected referral revenue is ${projection.referrals.collectedRevenue.toFixed(2)} only where attribution exists.`
          : `${catalog.facts.repeatCustomers.count} repeat customer${catalog.facts.repeatCustomers.count === 1 ? "" : "s"} are on file. Repeat status is not proof that outreach occurred.`,
    });
  }
  if (projection.local.opportunityCount > 0 || catalog.facts.outsideAreaRequests.count > 0) {
    findings.push({
      key: "growth-local-opportunities",
      title: "Review local marketing opportunities",
      why: "Recorded local-area or outside-area demand exists. Rankings were not invented. Review local growth in the existing workspace.",
    });
  }
  if (projection.totals.funnelStages > 0) {
    findings.push({
      key: "growth-funnel-recorded",
      title: "Recorded lead and revenue funnel",
      why: `The recorded funnel has ${projection.totals.funnelStages} present stage${projection.totals.funnelStages === 1 ? "" : "s"}. Missing stages are absent, not zero.`,
    });
  }

  return {
    specialistId: "GROWTH",
    question,
    factKeys,
    recommendationKeys: ownedRecs.map((item) => item.key),
    facts,
    findings: findings.slice(0, GROWTH_CONTEXT_CAPS.findings),
    entityHints,
  };
}

export function interpretGrowthSpecialist(
  catalog: CanonicalRecommendationCatalog,
  question: string,
  entityHints?: CosEntityHints,
  denyProductCapabilities?: ProductCapabilityCode[],
): SpecialistResult {
  recordGrowthSpecialistInterpretation();
  const snapshot = catalog.growth ?? EMPTY_GROWTH_SNAPSHOT;
  const missing = missingGrowthCapabilities(snapshot, denyProductCapabilities);
  if (missing.length > 0 || !snapshot.entitled) {
    lastGrowthProjection = null;
    return {
      specialistId: "GROWTH",
      status: "SKIPPED",
      findings: [],
      factKeys: [],
      recommendationKeys: [],
      limitation: growthEntitlementLimitation(
        missing.length > 0 ? missing : GROWTH_REQUIRED_PRODUCT_CAPABILITIES,
      ),
    };
  }
  if (snapshot.failed || !snapshot.source) {
    lastGrowthProjection = null;
    return {
      specialistId: "GROWTH",
      status: "FAILED",
      findings: [],
      factKeys: [],
      recommendationKeys: [],
      limitation: GROWTH_FAILURE_LIMITATION,
      failure: {
        specialistId: "GROWTH",
        message: snapshot.failureMessage ?? "Growth source could not be loaded.",
      },
    };
  }

  const context = projectGrowthContext(catalog, question, snapshot.source, entityHints);
  const findings: SpecialistFinding[] = context.findings.map((item) => ({
    key: item.key,
    title: item.title,
    summary: item.why,
    recommendationKeys: isGrowthOwnedRecommendationKey(item.key) ? [item.key] : [],
    factKeys: context.factKeys,
    entityIds: item.entityIds,
  }));

  return {
    specialistId: "GROWTH",
    status: "OK",
    findings,
    factKeys: context.factKeys,
    recommendationKeys: context.recommendationKeys,
  };
}

/**
 * Deterministic Growth calculations over recorded TBBT records.
 * AI and UI must not invent numbers this module does not produce.
 */
import {
  daysSince,
  estimateDealValue,
  followUpStatus,
  pickPrimaryEstimate,
  resolvePipelineStage,
} from "@/lib/pipeline";
import { asNumber } from "@/lib/reports";
import { parseLeadSource } from "@/lib/lead-attribution";
import {
  ATTRIBUTION_KIND_LABELS,
  COST_ROI_UNAVAILABLE_MESSAGE,
  DORMANT_OPPORTUNITY_AFTER_DAYS,
  ESTIMATE_NO_RESPONSE_AFTER_DAYS,
  GROWTH_FUNNEL_STAGE_LABELS,
  GROWTH_FUNNEL_STAGES,
  REACTIVATION_AFTER_DAYS,
  RECOVERY_QUEUE_LABELS,
  type AttributionKind,
  type GrowthEvidence,
  type GrowthFunnelStage,
  type GrowthRecommendation,
  type RecoveryQueue,
} from "@/lib/growth";

export type GrowthMoney = { toString(): string } | number | string | null | undefined;

export type GrowthRequestRow = {
  id: string;
  customerId: string | null;
  leadSource: string | null;
  campaignId: string | null;
  originalLeadSource: string | null;
  originalCampaignId: string | null;
  landingPagePath: string | null;
  localPageSlug: string | null;
  matchedServiceAreaId: string | null;
  serviceAreaQualification: string;
  createdAt: Date;
  updatedAt: Date;
};

export type GrowthEstimateRow = {
  id: string;
  customerId: string | null;
  serviceRequestId: string | null;
  status: string;
  total: GrowthMoney;
  leadSource: string | null;
  campaignId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type GrowthJobRow = {
  id: string;
  customerId: string | null;
  estimateId: string | null;
  status: string;
  leadSource: string | null;
  campaignId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type GrowthInvoiceRow = {
  id: string;
  jobId: string | null;
  customerId: string | null;
  status: string;
  total: GrowthMoney;
  paidAt: Date | null;
  createdAt: Date;
};

export type GrowthPipelineRow = {
  serviceRequestId: string | null;
  standaloneEstimateId: string | null;
  ownerStage: string | null;
  followUpOn: Date | null;
  lossReason: string | null;
  updatedAt: Date;
};

export type GrowthCustomerRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  smsConsentStatus: string;
  firstLeadSource: string | null;
  firstCampaignId: string | null;
  createdAt: Date;
};

export type GrowthCampaignRow = {
  id: string;
  name: string;
  sourceKey: string;
  status: string;
  recordedCost: GrowthMoney;
  createdAt: Date;
};

export type GrowthReviewRow = {
  id: string;
  customerId: string;
  jobId: string | null;
  reviewRequestId: string | null;
  websiteSelected: boolean;
  responseStatus: string;
};

export type GrowthReviewRequestRow = {
  id: string;
  customerId: string;
  jobId: string | null;
  status: string;
};

export type GrowthReferralRow = {
  id: string;
  sourceCustomerId: string;
  referredCustomerId: string | null;
  referralRequestId: string | null;
  campaignId: string | null;
  status: string;
};

export type GrowthReferralRequestRow = {
  id: string;
  customerId: string;
  jobId: string | null;
  status: string;
};

export type GrowthFollowUpRow = {
  id: string;
  customerId: string;
  kind: string;
  status: string;
};

export type GrowthServiceAreaRow = {
  id: string;
  label: string;
  kind: string;
  enabled: boolean;
  city: string | null;
};

export type GrowthLocalPageRow = {
  id: string;
  serviceAreaId: string;
  catalogItemId: string;
};

export type GrowthPublishedLocalPageRow = {
  citySlug: string;
  serviceSlug: string;
  serviceAreaId?: string | null;
};

export type GrowthSource = {
  now: Date;
  requests: GrowthRequestRow[];
  estimates: GrowthEstimateRow[];
  jobs: GrowthJobRow[];
  invoices: GrowthInvoiceRow[];
  pipeline: GrowthPipelineRow[];
  customers: GrowthCustomerRow[];
  campaigns: GrowthCampaignRow[];
  reviews: GrowthReviewRow[];
  reviewRequests: GrowthReviewRequestRow[];
  referrals: GrowthReferralRow[];
  referralRequests: GrowthReferralRequestRow[];
  followUps: GrowthFollowUpRow[];
  serviceAreas: GrowthServiceAreaRow[];
  localPageDrafts: GrowthLocalPageRow[];
  publishedLocalPages: GrowthPublishedLocalPageRow[];
};

export type GrowthFunnelStageView = {
  key: GrowthFunnelStage;
  label: string;
  count: number;
  amount: number | null;
  present: boolean;
};

export type GrowthFunnel = {
  stages: GrowthFunnelStageView[];
  path: readonly GrowthFunnelStage[];
};

export type AttributionFlags = {
  source: boolean;
  campaign: boolean;
  landingPage: boolean;
  referral: boolean;
  repeatCustomer: boolean;
  unknown: boolean;
};

export type ClassifiedAttribution = {
  kind: AttributionKind;
  label: string;
  flags: AttributionFlags;
  source: string | null;
  originalSource: string | null;
  campaignId: string | null;
  originalCampaignId: string | null;
  landingPagePath: string | null;
  localPageSlug: string | null;
};

export type CampaignPerformance = {
  campaignId: string | null;
  name: string;
  leads: number;
  estimates: number;
  wins: number;
  losses: number;
  invoicedRevenue: number;
  collectedRevenue: number;
  conversion: number | null;
  averageTicket: number | null;
  reviews: number;
  referrals: number;
  recordedCost: number | null;
  costAvailable: boolean;
  roi: number | null;
  roiMessage: string | null;
};

export type RecoveryItem = {
  queue: RecoveryQueue;
  label: string;
  requestId: string | null;
  estimateId: string | null;
  customerId: string | null;
  customerName: string;
  value: number | null;
  consentEligible: boolean;
  smsConsentStatus: string;
  href: string;
  evidence: GrowthEvidence[];
};

export type ReactivationCandidate = {
  customerId: string;
  customerName: string;
  completedJobs: number;
  lastCompletedAt: Date;
  daysSinceCompleted: number;
  consentEligible: boolean;
  smsConsentStatus: string;
  hasEmail: boolean;
  href: string;
};

export type ReviewConversion = {
  completedJobs: number;
  requestsPrepared: number;
  requestsSent: number;
  reviewsReceived: number;
  responsesRecorded: number;
  websiteSelected: number;
  requestConversion: number | null;
};

export type ReferralAttribution = {
  referralId: string;
  sourceCustomerId: string;
  sourceCustomerName: string;
  referredCustomerId: string | null;
  referredCustomerName: string | null;
  status: string;
  estimates: number;
  jobs: number;
  invoicedRevenue: number;
  collectedRevenue: number;
};

export type LocalGrowthArea = {
  serviceAreaId: string | null;
  label: string;
  enabled: boolean;
  requestCount: number;
  strength: "strong" | "weak" | "none" | "missing";
  hasLocalPageDraft: boolean;
  hasPublishedLocalPage: boolean;
  contentOpportunity: boolean;
};

export function moneyAmount(value: GrowthMoney): number {
  return asNumber(value as { toString(): string } | number | null | undefined);
}

export function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

export function campaignRoi(input: {
  recordedCost: number | null;
  collectedRevenue: number;
}): { costAvailable: boolean; roi: number | null; message: string | null } {
  if (input.recordedCost == null || !(input.recordedCost > 0)) {
    return { costAvailable: false, roi: null, message: COST_ROI_UNAVAILABLE_MESSAGE };
  }
  return {
    costAvailable: true,
    roi: Math.round(((input.collectedRevenue - input.recordedCost) / input.recordedCost) * 1000) / 1000,
    message: null,
  };
}

export function isConsentEligible(customer: {
  smsConsentStatus: string | null | undefined;
  email?: string | null;
}): boolean {
  if (customer.smsConsentStatus === "REVOKED") return false;
  if (customer.smsConsentStatus === "GRANTED") return true;
  return Boolean(customer.email?.trim());
}

export function classifyAttribution(input: {
  leadSource?: string | null;
  campaignId?: string | null;
  originalLeadSource?: string | null;
  originalCampaignId?: string | null;
  landingPagePath?: string | null;
  localPageSlug?: string | null;
  isReferral?: boolean;
  isRepeatCustomer?: boolean;
}): ClassifiedAttribution {
  const source = parseLeadSource(input.leadSource);
  const originalSource = parseLeadSource(input.originalLeadSource) ?? source;
  const flags: AttributionFlags = {
    source: Boolean(source),
    campaign: Boolean(input.campaignId),
    landingPage: Boolean(input.landingPagePath?.trim() || input.localPageSlug?.trim()),
    referral: Boolean(input.isReferral || source === "REFERRAL" || originalSource === "REFERRAL"),
    repeatCustomer: Boolean(input.isRepeatCustomer),
    unknown: false,
  };
  let kind: AttributionKind = "UNKNOWN";
  if (flags.referral) kind = "REFERRAL";
  else if (flags.repeatCustomer) kind = "REPEAT_CUSTOMER";
  else if (flags.campaign) kind = "CAMPAIGN";
  else if (flags.landingPage) kind = "LANDING_PAGE";
  else if (flags.source) kind = "SOURCE";
  flags.unknown = kind === "UNKNOWN";
  return {
    kind,
    label: ATTRIBUTION_KIND_LABELS[kind],
    flags,
    source,
    originalSource,
    campaignId: input.campaignId ?? null,
    originalCampaignId: input.originalCampaignId ?? input.campaignId ?? null,
    landingPagePath: input.landingPagePath ?? null,
    localPageSlug: input.localPageSlug ?? null,
  };
}

export function preserveOriginalSource<T extends {
  originalLeadSource?: string | null;
  originalCampaignId?: string | null;
  leadSource?: string | null;
  campaignId?: string | null;
}>(existing: T, incoming: { leadSource?: string | null; campaignId?: string | null }) {
  return {
    originalLeadSource: existing.originalLeadSource ?? existing.leadSource ?? incoming.leadSource ?? null,
    originalCampaignId: existing.originalCampaignId ?? existing.campaignId ?? incoming.campaignId ?? null,
    leadSource: existing.leadSource ?? incoming.leadSource ?? null,
    campaignId: existing.campaignId ?? incoming.campaignId ?? null,
  };
}

function invoiceTotalsForJob(invoices: readonly GrowthInvoiceRow[], jobId: string) {
  const rows = invoices.filter((invoice) => invoice.jobId === jobId);
  return {
    invoiced: rows
      .filter((invoice) => invoice.status === "SENT" || invoice.status === "PAID")
      .reduce((sum, invoice) => sum + moneyAmount(invoice.total), 0),
    collected: rows
      .filter((invoice) => invoice.status === "PAID")
      .reduce((sum, invoice) => sum + moneyAmount(invoice.total), 0),
  };
}

function referredCustomerIds(referrals: readonly GrowthReferralRow[]) {
  return new Set(
    referrals
      .filter((row) => row.status !== "CANCELLED" && row.referredCustomerId)
      .map((row) => row.referredCustomerId as string),
  );
}

export function buildGrowthFunnel(source: GrowthSource): GrowthFunnel {
  const lostIds = new Set<string>();
  const requestEstimates = new Map<string, GrowthEstimateRow[]>();
  for (const estimate of source.estimates) {
    if (!estimate.serviceRequestId) continue;
    const list = requestEstimates.get(estimate.serviceRequestId) ?? [];
    list.push(estimate);
    requestEstimates.set(estimate.serviceRequestId, list);
  }

  const approvedEstimates = source.estimates.filter((row) => row.status === "APPROVED");
  for (const row of source.pipeline) {
    const estimate = row.serviceRequestId
      ? pickPrimaryEstimate(requestEstimates.get(row.serviceRequestId) ?? [])
      : source.estimates.find((item) => item.id === row.standaloneEstimateId) ?? null;
    const hasJob = source.jobs.some(
      (job) =>
        (estimate && job.estimateId === estimate.id) ||
        (row.serviceRequestId &&
          source.estimates.some((item) => item.serviceRequestId === row.serviceRequestId && item.id === job.estimateId)),
    );
    const stage = resolvePipelineStage({
      ownerStage: row.ownerStage,
      estimateStatus: estimate?.status ?? null,
      hasJob,
    });
    if (stage === "LOST") {
      lostIds.add(row.serviceRequestId ?? row.standaloneEstimateId ?? "");
    }
  }

  const issued = source.invoices.filter((row) => row.status === "SENT" || row.status === "PAID");
  const collected = source.invoices.filter((row) => row.status === "PAID");
  const referralOrReactivation =
    source.referrals.filter((row) => row.status !== "CANCELLED").length +
    source.followUps.filter((row) => row.kind === "REPEAT").length;

  const raw: Array<{ key: GrowthFunnelStage; count: number; amount: number | null }> = [
    { key: "lead", count: source.requests.length, amount: null },
    { key: "estimate", count: source.estimates.length, amount: null },
    { key: "approved", count: approvedEstimates.length, amount: null },
    { key: "lost", count: [...lostIds].filter(Boolean).length, amount: null },
    { key: "job", count: source.jobs.length, amount: null },
    {
      key: "invoice",
      count: issued.length,
      amount: issued.reduce((sum, row) => sum + moneyAmount(row.total), 0),
    },
    {
      key: "collected",
      count: collected.length,
      amount: collected.reduce((sum, row) => sum + moneyAmount(row.total), 0),
    },
    { key: "review", count: source.reviews.length, amount: null },
    { key: "referral", count: referralOrReactivation, amount: null },
  ];

  return {
    path: GROWTH_FUNNEL_STAGES,
    stages: raw
      .filter((row) => row.count > 0)
      .map((row) => ({
        key: row.key,
        label: GROWTH_FUNNEL_STAGE_LABELS[row.key],
        count: row.count,
        amount: row.amount,
        present: true,
      })),
  };
}

export function buildSourcePerformance(source: GrowthSource) {
  const referred = referredCustomerIds(source.referrals);
  const buckets = new Map<
    string,
    {
      source: string;
      leads: number;
      estimates: number;
      wins: number;
      collectedRevenue: number;
      invoicedRevenue: number;
    }
  >();

  function bucket(leadSource: string | null) {
    const key = parseLeadSource(leadSource) ?? "UNKNOWN";
    const existing = buckets.get(key);
    if (existing) return existing;
    const created = {
      source: key,
      leads: 0,
      estimates: 0,
      wins: 0,
      collectedRevenue: 0,
      invoicedRevenue: 0,
    };
    buckets.set(key, created);
    return created;
  }

  for (const request of source.requests) {
    bucket(request.originalLeadSource ?? request.leadSource).leads += 1;
  }
  for (const estimate of source.estimates) {
    const item = bucket(estimate.leadSource);
    item.estimates += 1;
    if (estimate.status === "APPROVED") item.wins += 1;
  }
  for (const job of source.jobs) {
    const item = bucket(job.leadSource);
    const money = invoiceTotalsForJob(source.invoices, job.id);
    item.invoicedRevenue += money.invoiced;
    item.collectedRevenue += money.collected;
  }

  return [...buckets.values()]
    .map((row) => ({
      ...row,
      conversion: ratio(row.wins, row.leads),
      averageTicket: ratio(row.collectedRevenue, row.wins) === null
        ? row.wins > 0
          ? Math.round((row.collectedRevenue / row.wins) * 100) / 100
          : null
        : Math.round((row.collectedRevenue / row.wins) * 100) / 100,
      referralAttributed: row.source === "REFERRAL" || referred.size > 0,
    }))
    .sort((a, b) => b.collectedRevenue - a.collectedRevenue || b.leads - a.leads);
}

function campaignKeyForRecord(input: {
  campaignId: string | null;
  originalCampaignId?: string | null;
}) {
  return input.originalCampaignId ?? input.campaignId ?? null;
}

export function buildCampaignPerformance(source: GrowthSource): CampaignPerformance[] {
  const jobsByEstimate = new Map<string, GrowthJobRow[]>();
  for (const job of source.jobs) {
    if (!job.estimateId) continue;
    const list = jobsByEstimate.get(job.estimateId) ?? [];
    list.push(job);
    jobsByEstimate.set(job.estimateId, list);
  }
  const requestById = new Map(source.requests.map((row) => [row.id, row]));
  const referred = referredCustomerIds(source.referrals);
  const rows = new Map<string, CampaignPerformance>();

  function bucket(campaignId: string | null): CampaignPerformance {
    const key = campaignId ?? "UNATTRIBUTED";
    const existing = rows.get(key);
    if (existing) return existing;
    const campaign = campaignId ? source.campaigns.find((row) => row.id === campaignId) : null;
    const recordedCost = campaign ? moneyAmount(campaign.recordedCost) || null : null;
    const roi = campaignRoi({
      recordedCost: recordedCost && recordedCost > 0 ? recordedCost : null,
      collectedRevenue: 0,
    });
    const created: CampaignPerformance = {
      campaignId,
      name: campaign?.name ?? (campaignId ? "Campaign" : "Unattributed"),
      leads: 0,
      estimates: 0,
      wins: 0,
      losses: 0,
      invoicedRevenue: 0,
      collectedRevenue: 0,
      conversion: null,
      averageTicket: null,
      reviews: 0,
      referrals: 0,
      recordedCost: recordedCost && recordedCost > 0 ? recordedCost : null,
      costAvailable: roi.costAvailable,
      roi: null,
      roiMessage: roi.message,
    };
    rows.set(key, created);
    return created;
  }

  for (const request of source.requests) {
    bucket(campaignKeyForRecord(request)).leads += 1;
  }
  for (const estimate of source.estimates) {
    const request = estimate.serviceRequestId ? requestById.get(estimate.serviceRequestId) : null;
    const item = bucket(campaignKeyForRecord({
      campaignId: estimate.campaignId,
      originalCampaignId: request?.originalCampaignId ?? request?.campaignId ?? estimate.campaignId,
    }));
    item.estimates += 1;
    if (estimate.status === "APPROVED") item.wins += 1;
  }
  for (const row of source.pipeline) {
    const estimate = row.serviceRequestId
      ? pickPrimaryEstimate(source.estimates.filter((item) => item.serviceRequestId === row.serviceRequestId))
      : source.estimates.find((item) => item.id === row.standaloneEstimateId) ?? null;
    const hasJob = Boolean(
      estimate && (jobsByEstimate.get(estimate.id)?.length ?? 0) > 0,
    );
    if (resolvePipelineStage({ ownerStage: row.ownerStage, estimateStatus: estimate?.status ?? null, hasJob }) !== "LOST") {
      continue;
    }
    const request = row.serviceRequestId ? requestById.get(row.serviceRequestId) : null;
    bucket(campaignKeyForRecord({
      campaignId: estimate?.campaignId ?? request?.campaignId ?? null,
      originalCampaignId: request?.originalCampaignId ?? request?.campaignId ?? estimate?.campaignId ?? null,
    })).losses += 1;
  }
  for (const job of source.jobs) {
    const estimate = job.estimateId ? source.estimates.find((row) => row.id === job.estimateId) : null;
    const request = estimate?.serviceRequestId ? requestById.get(estimate.serviceRequestId) : null;
    const item = bucket(campaignKeyForRecord({
      campaignId: job.campaignId,
      originalCampaignId: request?.originalCampaignId ?? job.campaignId,
    }));
    const money = invoiceTotalsForJob(source.invoices, job.id);
    item.invoicedRevenue += money.invoiced;
    item.collectedRevenue += money.collected;
  }
  for (const review of source.reviews) {
    const job = review.jobId ? source.jobs.find((row) => row.id === review.jobId) : null;
    if (!job) continue;
    const estimate = job.estimateId ? source.estimates.find((row) => row.id === job.estimateId) : null;
    const request = estimate?.serviceRequestId ? requestById.get(estimate.serviceRequestId) : null;
    bucket(campaignKeyForRecord({
      campaignId: job.campaignId,
      originalCampaignId: request?.originalCampaignId ?? job.campaignId,
    })).reviews += 1;
  }
  for (const referral of source.referrals) {
    if (referral.status === "CANCELLED") continue;
    bucket(referral.campaignId).referrals += 1;
  }

  for (const item of rows.values()) {
    item.conversion = ratio(item.wins, item.leads);
    item.averageTicket =
      item.wins > 0 ? Math.round((item.collectedRevenue / item.wins) * 100) / 100 : null;
    const roi = campaignRoi({
      recordedCost: item.recordedCost,
      collectedRevenue: item.collectedRevenue,
    });
    item.costAvailable = roi.costAvailable;
    item.roi = roi.roi;
    item.roiMessage = roi.message;
  }

  void referred;
  return [...rows.values()].sort((a, b) => b.collectedRevenue - a.collectedRevenue || b.leads - a.leads);
}

export function buildReviewConversion(source: GrowthSource): ReviewConversion {
  const completedJobs = source.jobs.filter((job) => job.status === "COMPLETED");
  const prepared = source.reviewRequests.filter((row) => row.status !== "CANCELLED");
  const sent = source.reviewRequests.filter((row) => row.status === "SENT" || row.status === "COMPLETED");
  const received = source.reviews.length;
  const responses = source.reviews.filter((row) => row.responseStatus && row.responseStatus !== "NONE").length;
  const websiteSelected = source.reviews.filter((row) => row.websiteSelected).length;
  return {
    completedJobs: completedJobs.length,
    requestsPrepared: prepared.length,
    requestsSent: sent.length,
    reviewsReceived: received,
    responsesRecorded: responses,
    websiteSelected,
    requestConversion: ratio(received, sent.length),
  };
}

export function buildReferralAttribution(source: GrowthSource): ReferralAttribution[] {
  const customers = new Map(source.customers.map((row) => [row.id, row]));
  const seenCustomers = new Set<string>();
  const rows: ReferralAttribution[] = [];

  for (const referral of source.referrals) {
    if (referral.status === "CANCELLED") continue;
    const referredId = referral.referredCustomerId;
    if (referredId && seenCustomers.has(referredId)) continue;
    if (referredId) seenCustomers.add(referredId);

    const estimates = referredId
      ? source.estimates.filter((row) => row.customerId === referredId)
      : [];
    const jobs = referredId ? source.jobs.filter((row) => row.customerId === referredId) : [];
    let invoiced = 0;
    let collected = 0;
    for (const job of jobs) {
      const money = invoiceTotalsForJob(source.invoices, job.id);
      invoiced += money.invoiced;
      collected += money.collected;
    }
    rows.push({
      referralId: referral.id,
      sourceCustomerId: referral.sourceCustomerId,
      sourceCustomerName: customers.get(referral.sourceCustomerId)?.name ?? "Customer",
      referredCustomerId: referredId,
      referredCustomerName: referredId ? customers.get(referredId)?.name ?? null : null,
      status: referral.status,
      estimates: estimates.length,
      jobs: jobs.length,
      invoicedRevenue: invoiced,
      collectedRevenue: collected,
    });
  }
  return rows.sort((a, b) => b.collectedRevenue - a.collectedRevenue);
}

function opportunityStage(
  source: GrowthSource,
  request: GrowthRequestRow | null,
  estimate: GrowthEstimateRow | null,
) {
  const pipeline = source.pipeline.find((row) =>
    request ? row.serviceRequestId === request.id : row.standaloneEstimateId === estimate?.id,
  );
  const hasJob = Boolean(
    estimate && source.jobs.some((job) => job.estimateId === estimate.id),
  );
  return {
    pipeline,
    stage: resolvePipelineStage({
      ownerStage: pipeline?.ownerStage,
      estimateStatus: estimate?.status ?? null,
      hasJob,
    }),
    hasJob,
    followUp: followUpStatus(pipeline?.followUpOn ?? null, source.now),
  };
}

export function buildRecoveryQueue(source: GrowthSource): RecoveryItem[] {
  const customers = new Map(source.customers.map((row) => [row.id, row]));
  const items: RecoveryItem[] = [];
  const requestEstimates = new Map<string, GrowthEstimateRow[]>();
  for (const estimate of source.estimates) {
    if (!estimate.serviceRequestId) continue;
    const list = requestEstimates.get(estimate.serviceRequestId) ?? [];
    list.push(estimate);
    requestEstimates.set(estimate.serviceRequestId, list);
  }

  function push(item: Omit<RecoveryItem, "label">) {
    items.push({ ...item, label: RECOVERY_QUEUE_LABELS[item.queue] });
  }

  for (const request of source.requests) {
    const estimates = requestEstimates.get(request.id) ?? [];
    const estimate = pickPrimaryEstimate(estimates);
    const customer = request.customerId ? customers.get(request.customerId) : null;
    const { stage, followUp, hasJob } = opportunityStage(source, request, estimate);
    const consentEligible = customer
      ? isConsentEligible(customer)
      : false;
    const value = estimate ? Number(estimateDealValue(estimate) ?? 0) || null : null;
    const href = `/pipeline`;
    const base = {
      requestId: request.id,
      estimateId: estimate?.id ?? null,
      customerId: request.customerId,
      customerName: customer?.name ?? "Customer",
      value,
      consentEligible,
      smsConsentStatus: customer?.smsConsentStatus ?? "UNKNOWN",
      href,
    };

    if (!estimate && stage !== "WON" && stage !== "LOST") {
      push({
        queue: "NEVER_ESTIMATED",
        ...base,
        evidence: [
          { key: "request", label: "Request", value: request.id, href: `/requests` },
          { key: "age", label: "Days since request", value: String(daysSince(request.createdAt, source.now)), href },
        ],
      });
    }

    if (estimate?.status === "SENT" && !hasJob && stage !== "LOST") {
      const age = daysSince(estimate.updatedAt, source.now);
      if (age >= ESTIMATE_NO_RESPONSE_AFTER_DAYS) {
        push({
          queue: "ESTIMATE_NO_RESPONSE",
          ...base,
          estimateId: estimate.id,
          evidence: [
            { key: "estimate", label: "Estimate", value: estimate.id, href: `/estimates/${estimate.id}` },
            { key: "days", label: "Days since sent", value: String(age), href: `/estimates/${estimate.id}` },
          ],
        });
      }
    }

    if (stage === "LOST") {
      push({
        queue: "ESTIMATE_LOST",
        ...base,
        evidence: [
          { key: "stage", label: "Pipeline stage", value: "LOST", href },
          {
            key: "reason",
            label: "Loss reason",
            value: opportunityStage(source, request, estimate).pipeline?.lossReason ?? "Not recorded",
            href,
          },
        ],
      });
    }

    if ((followUp === "overdue" || followUp === "due_today") && stage !== "WON" && stage !== "LOST") {
      push({
        queue: "MISSED_FOLLOW_UP",
        ...base,
        evidence: [
          { key: "follow-up", label: "Follow-up", value: followUp, href },
        ],
      });
    }

    const lastActivity = [request.updatedAt, estimate?.updatedAt]
      .filter((value): value is Date => Boolean(value))
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? request.updatedAt;
    if (
      !hasJob &&
      stage !== "WON" &&
      stage !== "LOST" &&
      daysSince(lastActivity, source.now) >= DORMANT_OPPORTUNITY_AFTER_DAYS
    ) {
      push({
        queue: "DORMANT",
        ...base,
        evidence: [
          { key: "idle", label: "Days idle", value: String(daysSince(lastActivity, source.now)), href },
        ],
      });
    }
  }

  for (const estimate of source.estimates.filter((row) => !row.serviceRequestId)) {
    const { stage, followUp, hasJob } = opportunityStage(source, null, estimate);
    const customer = estimate.customerId ? customers.get(estimate.customerId) : null;
    const consentEligible = customer ? isConsentEligible(customer) : false;
    const value = Number(estimateDealValue(estimate) ?? 0) || null;
    const href = `/pipeline`;
    const base = {
      requestId: null,
      estimateId: estimate.id,
      customerId: estimate.customerId,
      customerName: customer?.name ?? "Customer",
      value,
      consentEligible,
      smsConsentStatus: customer?.smsConsentStatus ?? "UNKNOWN",
      href,
    };
    if (estimate.status === "SENT" && !hasJob && stage !== "LOST" && daysSince(estimate.updatedAt, source.now) >= ESTIMATE_NO_RESPONSE_AFTER_DAYS) {
      push({
        queue: "ESTIMATE_NO_RESPONSE",
        ...base,
        evidence: [
          { key: "estimate", label: "Estimate", value: estimate.id, href: `/estimates/${estimate.id}` },
        ],
      });
    }
    if (stage === "LOST") {
      push({
        queue: "ESTIMATE_LOST",
        ...base,
        evidence: [{ key: "stage", label: "Pipeline stage", value: "LOST", href }],
      });
    }
    if ((followUp === "overdue" || followUp === "due_today") && stage !== "WON" && stage !== "LOST") {
      push({
        queue: "MISSED_FOLLOW_UP",
        ...base,
        evidence: [{ key: "follow-up", label: "Follow-up", value: followUp, href }],
      });
    }
    if (!hasJob && stage !== "WON" && stage !== "LOST" && daysSince(estimate.updatedAt, source.now) >= DORMANT_OPPORTUNITY_AFTER_DAYS) {
      push({
        queue: "DORMANT",
        ...base,
        evidence: [{ key: "idle", label: "Days idle", value: String(daysSince(estimate.updatedAt, source.now)), href }],
      });
    }
  }

  return items;
}

export function buildReactivationCandidates(source: GrowthSource): ReactivationCandidate[] {
  const customers = new Map(source.customers.map((row) => [row.id, row]));
  const activeCustomerIds = new Set<string>();
  for (const job of source.jobs) {
    if (job.customerId && job.status !== "COMPLETED") activeCustomerIds.add(job.customerId);
  }
  for (const request of source.requests) {
    if (!request.customerId) continue;
    const estimates = source.estimates.filter((row) => row.serviceRequestId === request.id);
    const estimate = pickPrimaryEstimate(estimates);
    const { stage, hasJob } = opportunityStage(source, request, estimate);
    if (!hasJob && stage !== "LOST" && stage !== "WON") activeCustomerIds.add(request.customerId);
  }

  const completedByCustomer = new Map<string, { count: number; last: Date }>();
  for (const job of source.jobs) {
    if (job.status !== "COMPLETED" || !job.customerId) continue;
    const current = completedByCustomer.get(job.customerId);
    const at = job.updatedAt;
    if (!current) completedByCustomer.set(job.customerId, { count: 1, last: at });
    else {
      current.count += 1;
      if (at.getTime() > current.last.getTime()) current.last = at;
    }
  }

  const rows: ReactivationCandidate[] = [];
  for (const [customerId, stats] of completedByCustomer) {
    if (activeCustomerIds.has(customerId)) continue;
    const days = daysSince(stats.last, source.now);
    if (days < REACTIVATION_AFTER_DAYS) continue;
    const customer = customers.get(customerId);
    if (!customer) continue;
    const consentEligible = isConsentEligible(customer);
    rows.push({
      customerId,
      customerName: customer.name,
      completedJobs: stats.count,
      lastCompletedAt: stats.last,
      daysSinceCompleted: days,
      consentEligible,
      smsConsentStatus: customer.smsConsentStatus,
      hasEmail: Boolean(customer.email?.trim()),
      href: `/customers/${customerId}`,
    });
  }
  return rows.sort((a, b) => b.daysSinceCompleted - a.daysSinceCompleted);
}

export function buildLocalGrowth(source: GrowthSource): LocalGrowthArea[] {
  const requestCounts = new Map<string, number>();
  let unmatched = 0;
  let outside = 0;
  for (const request of source.requests) {
    if (request.matchedServiceAreaId) {
      requestCounts.set(
        request.matchedServiceAreaId,
        (requestCounts.get(request.matchedServiceAreaId) ?? 0) + 1,
      );
    } else {
      unmatched += 1;
    }
    if (request.serviceAreaQualification === "OUTSIDE_PREFERRED") outside += 1;
  }
  const draftAreas = new Set(source.localPageDrafts.map((row) => row.serviceAreaId));
  const publishedAreas = new Set(
    source.publishedLocalPages.map((row) => row.serviceAreaId).filter(Boolean) as string[],
  );
  const max = Math.max(0, ...requestCounts.values());
  const rows: LocalGrowthArea[] = source.serviceAreas.map((area) => {
    const requestCount = requestCounts.get(area.id) ?? 0;
    const hasLocalPageDraft = draftAreas.has(area.id);
    const hasPublishedLocalPage = publishedAreas.has(area.id);
    let strength: LocalGrowthArea["strength"] = "none";
    if (!area.enabled && requestCount === 0) strength = "none";
    else if (requestCount === 0) strength = "weak";
    else if (max > 0 && requestCount >= max) strength = "strong";
    else strength = "weak";
    return {
      serviceAreaId: area.id,
      label: area.label,
      enabled: area.enabled,
      requestCount,
      strength,
      hasLocalPageDraft,
      hasPublishedLocalPage,
      contentOpportunity: area.enabled && requestCount > 0 && !hasLocalPageDraft,
    };
  });
  if (outside > 0 || unmatched > 0) {
    rows.push({
      serviceAreaId: null,
      label: "Unmatched / outside preferred area",
      enabled: false,
      requestCount: outside + unmatched,
      strength: "missing",
      hasLocalPageDraft: false,
      hasPublishedLocalPage: false,
      contentOpportunity: true,
    });
  }
  return rows.sort((a, b) => b.requestCount - a.requestCount);
}

export function buildGrowthRecommendations(input: {
  recovery: RecoveryItem[];
  reactivation: ReactivationCandidate[];
  campaigns: CampaignPerformance[];
  sources: ReturnType<typeof buildSourcePerformance>;
  referrals: ReferralAttribution[];
  reviews: ReviewConversion;
}): GrowthRecommendation[] {
  const items: GrowthRecommendation[] = [];

  const highValue = input.recovery
    .filter((row) => row.queue === "ESTIMATE_NO_RESPONSE" && (row.value ?? 0) > 0)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  if (highValue[0]) {
    items.push({
      key: "follow-up-high-value-estimates",
      title: "Follow up on high-value estimates",
      why: "A sent estimate with recorded value has no recorded response.",
      evidence: highValue[0].evidence.concat(
        highValue[0].value != null
          ? [{ key: "value", label: "Recorded estimate value", value: highValue[0].value.toFixed(2), href: "/pipeline" }]
          : [],
      ),
      href: "/growth?area=recovery",
      priority: 10,
    });
  }

  if (input.reviews.completedJobs > input.reviews.requestsPrepared) {
    const missing = input.reviews.completedJobs - input.reviews.requestsPrepared;
    items.push({
      key: "ask-completed-customers-reviews",
      title: "Ask completed customers for reviews",
      why: "Completed jobs exist without a recorded review request.",
      evidence: [
        { key: "completed", label: "Completed jobs", value: String(input.reviews.completedJobs), href: "/reviews?area=opportunities" },
        { key: "missing", label: "Jobs without a review request", value: String(missing), href: "/reviews?area=opportunities" },
      ],
      href: "/reviews?area=opportunities",
      priority: 20,
    });
  }

  const eligible = input.reactivation.filter((row) => row.consentEligible);
  if (eligible.length > 0) {
    items.push({
      key: "reactivate-prior-customers",
      title: "Reactivate prior customers",
      why: "Completed customers have no active job or request and meet the elapsed-time rule.",
      evidence: [
        { key: "eligible", label: "Consent-eligible candidates", value: String(eligible.length), href: "/growth?area=reactivation" },
        {
          key: "days",
          label: "Days since last completed job (oldest)",
          value: String(eligible[0]!.daysSinceCompleted),
          href: "/growth?area=reactivation",
        },
      ],
      href: "/growth?area=reactivation",
      priority: 30,
    });
  }

  const competing = input.campaigns.filter((row) => row.campaignId && row.leads >= 2);
  if (competing.length >= 2) {
    const ranked = [...competing].sort((a, b) => (a.conversion ?? 0) - (b.conversion ?? 0));
    const weakest = ranked[0]!;
    const strongest = ranked[ranked.length - 1]!;
    if ((weakest.conversion ?? 0) < (strongest.conversion ?? 0)) {
      items.push({
        key: "improve-weak-converting-campaign",
        title: "Improve a weak converting campaign",
        why: "One recorded campaign converts fewer leads than another recorded campaign.",
        evidence: [
          { key: "weak", label: weakest.name, value: `${weakest.wins}/${weakest.leads} wins`, href: "/growth?area=campaigns" },
          { key: "strong", label: strongest.name, value: `${strongest.wins}/${strongest.leads} wins`, href: "/growth?area=campaigns" },
        ],
        href: "/growth?area=campaigns",
        priority: 40,
      });
    }
  }

  const strongSource = [...input.sources]
    .filter((row) => row.leads > 0 && row.wins > 0)
    .sort((a, b) => (b.conversion ?? 0) - (a.conversion ?? 0) || b.collectedRevenue - a.collectedRevenue)[0];
  if (strongSource) {
    items.push({
      key: "source-strong-conversion",
      title: "A source has strong conversion",
      why: "Recorded wins and collected revenue exist for this acquisition source.",
      evidence: [
        { key: "source", label: "Source", value: strongSource.source, href: "/growth?area=attribution" },
        { key: "wins", label: "Wins / leads", value: `${strongSource.wins}/${strongSource.leads}`, href: "/growth?area=attribution" },
        { key: "collected", label: "Collected revenue", value: strongSource.collectedRevenue.toFixed(2), href: "/growth?area=attribution" },
      ],
      href: "/growth?area=attribution",
      priority: 45,
    });
  }

  const referralRevenue = input.referrals.reduce((sum, row) => sum + row.collectedRevenue, 0);
  if (input.referrals.length > 0 && referralRevenue > 0) {
    items.push({
      key: "referral-source-performing",
      title: "Referral source is producing business",
      why: "Recorded referrals have attributable collected revenue. Each referred customer is counted once.",
      evidence: [
        { key: "referrals", label: "Recorded referrals", value: String(input.referrals.length), href: "/growth?area=referrals" },
        { key: "collected", label: "Referral collected revenue", value: referralRevenue.toFixed(2), href: "/growth?area=referrals" },
      ],
      href: "/growth?area=referrals",
      priority: 35,
    });
  }

  return items.sort((a, b) => a.priority - b.priority);
}

export function localPageSlugFromPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const match = path.match(/\/hire\/[^/]+\/in\/([^/]+)\/([^/?#]+)/);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

export function shouldPreserveCustomerFirstTouch(existing: {
  firstLeadSource?: string | null;
  firstCampaignId?: string | null;
}) {
  return Boolean(existing.firstLeadSource || existing.firstCampaignId);
}

/**
 * Tenant-scoped Pipeline loader. Every query is keyed by the
 * authenticated workspace businessId -- never a client-supplied id.
 *
 * Opportunities are derived from existing ServiceRequest / Estimate / Job
 * records. PipelineOpportunity rows only supply owner-managed sales state.
 */

import type { PrismaClient } from "@prisma/client";
import { startOfDay } from "@/lib/schedule";
import {
  ATTENTION_KIND_LABELS,
  attentionKinds,
  daysSince,
  estimateDealValue,
  followUpStatus,
  isOpenPipelineStage,
  matchesActivityFilter,
  matchesPipelineSearch,
  needsFollowUpAttention,
  opportunityKey,
  parsePipelineActivityFilter,
  parsePipelineStageFilter,
  pickPrimaryEstimate,
  resolvePipelineStage,
  sumDealValues,
  type AttentionKind,
  type FollowUpStatus,
  type PipelineActivityFilter,
  type PipelineStage,
} from "@/lib/pipeline";

type PipelineStateRow = {
  id: string;
  serviceRequestId: string | null;
  standaloneEstimateId: string | null;
  ownerStage: string | null;
  followUpOn: Date | null;
  lossReason: string | null;
  lossReasonNote: string | null;
  notes: string | null;
  updatedAt: Date;
};

export type PipelineOpportunityView = {
  key: string;
  stage: PipelineStage;
  ownerStage: string | null;
  customerId: string | null;
  customerName: string;
  propertyId: string | null;
  propertyLabel: string | null;
  serviceRequestId: string | null;
  requestStatus: string | null;
  requestSummary: string;
  requestedWork: string | null;
  estimateId: string | null;
  estimateStatus: string | null;
  estimateValue: string | null;
  jobId: string | null;
  jobStatus: string | null;
  followUpOn: Date | null;
  followUp: FollowUpStatus;
  lossReason: string | null;
  lossReasonNote: string | null;
  notes: string | null;
  createdAt: Date;
  lastActivity: Date;
  ageDays: number;
  attention: AttentionKind[];
};

export type PipelineQuery = {
  q?: string;
  stage?: string;
  activity?: string;
  selected?: string;
};

function propertyLabel(property: {
  label: string | null;
  addressLine1: string;
  city: string | null;
  region: string | null;
} | null): string | null {
  if (!property) return null;
  const cityRegion = [property.city, property.region].filter(Boolean).join(", ");
  return [property.label || property.addressLine1, cityRegion || null].filter(Boolean).join(" · ");
}

function latestDate(dates: Array<Date | null | undefined>): Date {
  return dates.reduce<Date>((latest, date) => {
    if (!date) return latest;
    return date > latest ? date : latest;
  }, dates.find((date): date is Date => Boolean(date)) ?? new Date(0));
}

function toView(input: {
  key: string;
  owner: PipelineStateRow | null;
  customer: { id: string; name: string } | null;
  property: {
    id: string;
    label: string | null;
    addressLine1: string;
    city: string | null;
    region: string | null;
  } | null;
  serviceRequestId: string | null;
  requestStatus: string | null;
  requestSummary: string;
  requestedWork: string | null;
  estimate: {
    id: string;
    status: string;
    total: { toString(): string };
    updatedAt: Date;
    approvedVersion: { total: { toString(): string } } | null;
    versions: { total: { toString(): string } }[];
  } | null;
  job: { id: string; status: string; updatedAt: Date; createdAt: Date } | null;
  createdAt: Date;
  lastActivity: Date;
  now: Date;
}): PipelineOpportunityView {
  const facts = {
    ownerStage: input.owner?.ownerStage ?? null,
    estimateStatus: input.estimate?.status ?? null,
    hasJob: Boolean(input.job),
  };
  const stage = resolvePipelineStage(facts);
  const followUpOn = input.owner?.followUpOn ?? null;
  const followUp = followUpStatus(followUpOn, input.now);
  return {
    key: input.key,
    stage,
    ownerStage: input.owner?.ownerStage ?? null,
    customerId: input.customer?.id ?? null,
    customerName: input.customer?.name ?? "Unassigned customer",
    propertyId: input.property?.id ?? null,
    propertyLabel: propertyLabel(input.property),
    serviceRequestId: input.serviceRequestId,
    requestStatus: input.requestStatus,
    requestSummary: input.requestSummary,
    requestedWork: input.requestedWork,
    estimateId: input.estimate?.id ?? null,
    estimateStatus: input.estimate?.status ?? null,
    estimateValue: estimateDealValue(input.estimate),
    jobId: input.job?.id ?? null,
    jobStatus: input.job?.status ?? null,
    followUpOn,
    followUp,
    lossReason: stage === "LOST" || input.owner?.ownerStage === "LOST" ? input.owner?.lossReason ?? null : null,
    lossReasonNote: stage === "LOST" || input.owner?.ownerStage === "LOST" ? input.owner?.lossReasonNote ?? null : null,
    notes: input.owner?.notes ?? null,
    createdAt: input.createdAt,
    lastActivity: input.lastActivity,
    ageDays: daysSince(input.createdAt, input.now),
    attention: attentionKinds({
      stage,
      followUp,
      estimateStatus: input.estimate?.status ?? null,
    }),
  };
}

export async function loadPipelineSource(
  prisma: PrismaClient,
  businessId: string,
  query: PipelineQuery = {},
) {
  const scope = { businessId } as const;
  const now = startOfDay(new Date());

  const [business, requests, standaloneEstimates, orphanJobs, pipelineRows] = await Promise.all([
    prisma.business.findFirst({
      where: { id: businessId },
      select: { id: true, name: true },
    }),
    prisma.serviceRequest.findMany({
      where: scope,
      select: {
        id: true,
        status: true,
        summary: true,
        description: true,
        createdAt: true,
        updatedAt: true,
        customer: { select: { id: true, name: true } },
        property: {
          select: { id: true, label: true, addressLine1: true, city: true, region: true },
        },
        serviceCatalogItem: { select: { name: true } },
        estimates: {
          select: {
            id: true,
            status: true,
            total: true,
            createdAt: true,
            updatedAt: true,
            approvedVersion: { select: { total: true } },
            versions: { select: { total: true, sentAt: true }, orderBy: { sentAt: "desc" }, take: 1 },
            jobs: {
              select: { id: true, status: true, createdAt: true, updatedAt: true },
              orderBy: { createdAt: "desc" },
              take: 1,
            },
          },
          orderBy: { updatedAt: "desc" },
        },
      },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.estimate.findMany({
      where: { ...scope, serviceRequestId: null },
      select: {
        id: true,
        status: true,
        total: true,
        createdAt: true,
        updatedAt: true,
        customer: { select: { id: true, name: true } },
        property: {
          select: { id: true, label: true, addressLine1: true, city: true, region: true },
        },
        lineItems: { select: { description: true }, orderBy: { createdAt: "asc" }, take: 1 },
        approvedVersion: { select: { total: true } },
        versions: { select: { total: true, sentAt: true }, orderBy: { sentAt: "desc" }, take: 1 },
        jobs: {
          select: { id: true, status: true, createdAt: true, updatedAt: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.job.findMany({
      where: { ...scope, estimateId: null },
      select: {
        id: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        customer: { select: { id: true, name: true } },
        property: {
          select: { id: true, label: true, addressLine1: true, city: true, region: true },
        },
        lineItems: { select: { description: true }, orderBy: { createdAt: "asc" }, take: 1 },
      },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.pipelineOpportunity.findMany({
      where: scope,
    }),
  ]);

  const stateByRequest = new Map<string, PipelineStateRow>();
  const stateByEstimate = new Map<string, PipelineStateRow>();
  for (const row of pipelineRows) {
    if (row.serviceRequestId) stateByRequest.set(row.serviceRequestId, row);
    if (row.standaloneEstimateId) stateByEstimate.set(row.standaloneEstimateId, row);
  }

  const requestOpportunities = requests.map((request) => {
    const estimate = pickPrimaryEstimate(request.estimates);
    const job = request.estimates.flatMap((row) => row.jobs)[0] ?? null;
    const owner = stateByRequest.get(request.id) ?? null;
    const requestedWork =
      request.serviceCatalogItem?.name ?? request.summary ?? request.description ?? null;
    return toView({
      key: opportunityKey({ serviceRequestId: request.id }),
      owner,
      customer: request.customer,
      property: request.property,
      serviceRequestId: request.id,
      requestStatus: request.status,
      requestSummary: request.summary || request.description || requestedWork || "Service request",
      requestedWork,
      estimate,
      job,
      createdAt: request.createdAt,
      lastActivity: latestDate([
        request.updatedAt,
        estimate?.updatedAt,
        job?.updatedAt,
        owner?.updatedAt,
      ]),
      now,
    });
  });

  const coveredEstimateIds = new Set(
    requests.flatMap((request) => request.estimates.map((estimate) => estimate.id)),
  );

  const estimateOpportunities = standaloneEstimates
    .filter((estimate) => !coveredEstimateIds.has(estimate.id))
    .map((estimate) => {
      const job = estimate.jobs[0] ?? null;
      const owner = stateByEstimate.get(estimate.id) ?? null;
      const requestedWork = estimate.lineItems[0]?.description ?? null;
      return toView({
        key: opportunityKey({ estimateId: estimate.id }),
        owner,
        customer: estimate.customer,
        property: estimate.property,
        serviceRequestId: null,
        requestStatus: null,
        requestSummary: requestedWork || "Standalone estimate",
        requestedWork,
        estimate,
        job,
        createdAt: estimate.createdAt,
        lastActivity: latestDate([estimate.updatedAt, job?.updatedAt, owner?.updatedAt]),
        now,
      });
    });

  const coveredJobIds = new Set(
    [
      ...requests.flatMap((request) => request.estimates.flatMap((estimate) => estimate.jobs.map((job) => job.id))),
      ...standaloneEstimates.flatMap((estimate) => estimate.jobs.map((job) => job.id)),
    ],
  );

  const jobOpportunities = orphanJobs
    .filter((job) => !coveredJobIds.has(job.id))
    .map((job) =>
      toView({
        key: opportunityKey({ jobId: job.id }),
        owner: null,
        customer: job.customer,
        property: job.property,
        serviceRequestId: null,
        requestStatus: null,
        requestSummary: job.lineItems[0]?.description || "Job",
        requestedWork: job.lineItems[0]?.description ?? null,
        estimate: null,
        job,
        createdAt: job.createdAt,
        lastActivity: job.updatedAt,
        now,
      }),
    );

  const all = [...requestOpportunities, ...estimateOpportunities, ...jobOpportunities].sort(
    (a, b) => b.lastActivity.getTime() - a.lastActivity.getTime(),
  );

  const search = query.q?.trim() ?? "";
  const stageFilter = parsePipelineStageFilter(query.stage);
  const activityFilter = parsePipelineActivityFilter(query.activity);

  const filtered = all.filter((row) => {
    if (stageFilter !== "all" && row.stage !== stageFilter) return false;
    if (!matchesActivityFilter(row.lastActivity, activityFilter, now)) return false;
    return matchesPipelineSearch(
      [row.customerName, row.requestSummary, row.requestedWork, row.propertyLabel, row.estimateStatus, row.jobStatus],
      search,
    );
  });

  const selected = all.find((row) => row.key === query.selected) ?? filtered[0] ?? null;

  const byStage = Object.fromEntries(
    (
      [
        "NEW_LEAD",
        "CONTACTED",
        "SITE_VISIT_NEEDS_INFO",
        "ESTIMATE_IN_PROGRESS",
        "ESTIMATE_SENT",
        "FOLLOW_UP",
        "WON",
        "LOST",
      ] as const
    ).map((stage) => {
      const rows = filtered.filter((row) => row.stage === stage);
      return [
        stage,
        {
          stage,
          count: rows.length,
          value: sumDealValues(rows.map((row) => row.estimateValue)),
          rows,
        },
      ];
    }),
  ) as Record<
    PipelineStage,
    { stage: PipelineStage; count: number; value: string | null; rows: PipelineOpportunityView[] }
  >;

  const open = all.filter((row) => isOpenPipelineStage(row.stage));
  const followUps = all.filter((row) => needsFollowUpAttention({ stage: row.stage, followUp: row.followUp }));
  const estimatesSent = all.filter((row) => row.stage === "ESTIMATE_SENT" || row.estimateStatus === "SENT");
  const won = all.filter((row) => row.stage === "WON");
  const lost = all.filter((row) => row.stage === "LOST");
  const attention = all
    .filter((row) => row.attention.length > 0)
    .map((row) => ({
      key: row.key,
      customerName: row.customerName,
      summary: row.requestSummary,
      stage: row.stage,
      kinds: row.attention,
      kindLabels: row.attention.map((kind) => ATTENTION_KIND_LABELS[kind]),
    }));

  return {
    businessId,
    businessName: business?.name ?? "Business",
    opportunities: all,
    filtered,
    selected,
    byStage,
    attention,
    counts: {
      open: open.length,
      needsFollowUp: followUps.length,
      estimatesSent: estimatesSent.filter((row) => row.stage === "ESTIMATE_SENT").length,
      won: won.length,
      lost: lost.length,
    },
    values: {
      open: sumDealValues(open.map((row) => row.estimateValue)),
      needsFollowUp: sumDealValues(followUps.map((row) => row.estimateValue)),
      estimatesSent: sumDealValues(
        estimatesSent.filter((row) => row.stage === "ESTIMATE_SENT").map((row) => row.estimateValue),
      ),
      won: sumDealValues(won.map((row) => row.estimateValue)),
      lost: sumDealValues(lost.map((row) => row.estimateValue)),
    },
    query: {
      q: search,
      stage: stageFilter,
      activity: activityFilter as PipelineActivityFilter,
      selected: selected?.key ?? "",
    },
  };
}

export type PipelineSource = Awaited<ReturnType<typeof loadPipelineSource>>;

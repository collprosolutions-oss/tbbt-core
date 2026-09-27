/**
 * Bounded retention candidate loader.
 *
 * Discovery is capped. Absence claims use scoped findFirst / relation
 * filters for the specific job or customer — never “not in this truncated
 * list.” Page load is read-only.
 */
import type { MembershipRole, Prisma, PrismaClient } from "@prisma/client";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import { RECOVERY_QUEUE_LABELS } from "@/lib/growth";
import { buildRecoveryQueue, type GrowthSource } from "@/lib/growth-engine";
import { daysSinceInBusinessTimeZone, formatLastCompletedAge } from "@/lib/growth/retention/age";
import {
  INCOMPLETE_JOURNEY_FACT,
  NO_LATER_JOB_FACT,
  NO_REFERRAL_REQUEST_FACT,
  NO_REVIEW_REQUEST_FACT,
  RECORDED_FOLLOW_UP_FACT,
  RETENTION_CANDIDATE_LIMIT,
} from "@/lib/growth/retention/constants";
import { requireRetentionCenterAccess } from "@/lib/growth/retention/access";
import {
  pushLink,
  sameTenantCommunicationsHref,
  sameTenantRecordHref,
} from "@/lib/growth/retention/links";
import {
  findLastCompletedJobForCustomer,
  hasLaterSameBusinessJob,
  resolveOwnedRetentionCustomer,
} from "@/lib/growth/retention/queries";
import type {
  RetentionCandidate,
  RetentionFollowUpRow,
  RetentionJourneyRow,
  RetentionWorkspace,
} from "@/lib/growth/retention/types";
import { recordedFollowUpStatusLabel } from "@/lib/growth/retention/wording";

type RetentionDb = PrismaClient | Prisma.TransactionClient;

export type LoadRetentionRecoveryCenterInput = {
  businessId: string;
  role: MembershipRole;
  customerId?: string | null;
  now?: Date;
};

function emptyWorkspace(businessId: string, timeZone: string): RetentionWorkspace {
  return {
    businessId,
    timeZone,
    candidateLimit: RETENTION_CANDIDATE_LIMIT,
    readOnly: true,
    mutationsOnLoad: false,
    groups: {
      noReviewRequest: [],
      noLaterJob: [],
      recordedFollowUp: [],
      noReferralRequest: [],
      incompleteJourney: [],
    },
    totals: {
      noReviewRequest: 0,
      noLaterJob: 0,
      recordedFollowUp: 0,
      noReferralRequest: 0,
      incompleteJourney: 0,
    },
  };
}

function customerWhere(customerId: string | null) {
  return customerId ? { customerId } : { customerId: { not: null } };
}

async function loadBusinessTimeZone(db: RetentionDb, businessId: string) {
  const business = await db.business.findFirst({
    where: { id: businessId },
    select: { id: true, timezone: true },
  });
  return resolveBusinessTimeZone(business);
}

async function completionByJobId(
  db: RetentionDb,
  businessId: string,
  jobIds: string[],
): Promise<Map<string, Date>> {
  const map = new Map<string, Date>();
  if (jobIds.length === 0) return map;
  const events = await db.businessEvent.findMany({
    where: {
      businessId,
      type: "JOB_COMPLETED",
      subjectType: "JOB",
      subjectId: { in: jobIds },
    },
    select: { subjectId: true, occurredAt: true },
  });
  for (const event of events) {
    const current = map.get(event.subjectId);
    if (!current || event.occurredAt.getTime() < current.getTime()) {
      map.set(event.subjectId, event.occurredAt);
    }
  }
  return map;
}

async function completedJobCounts(
  db: RetentionDb,
  businessId: string,
  customerIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (customerIds.length === 0) return map;
  const grouped = await db.job.groupBy({
    by: ["customerId"],
    where: {
      businessId,
      customerId: { in: customerIds },
      status: "COMPLETED",
    },
    _count: { id: true },
  });
  for (const row of grouped) {
    if (row.customerId) map.set(row.customerId, row._count.id);
  }
  return map;
}

async function lastInvoiceByJobId(
  db: RetentionDb,
  businessId: string,
  jobIds: string[],
) {
  const map = new Map<string, { id: string; status: string; businessId: string }>();
  if (jobIds.length === 0) return map;
  const invoices = await db.invoice.findMany({
    where: { businessId, jobId: { in: jobIds } },
    select: { id: true, businessId: true, jobId: true, status: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  for (const invoice of invoices) {
    if (!invoice.jobId || map.has(invoice.jobId)) continue;
    map.set(invoice.jobId, {
      id: invoice.id,
      status: invoice.status,
      businessId: invoice.businessId,
    });
  }
  return map;
}

async function lastReviewRequestByJobId(
  db: RetentionDb,
  businessId: string,
  jobIds: string[],
) {
  const map = new Map<string, string>();
  if (jobIds.length === 0) return map;
  const rows = await db.reviewRequest.findMany({
    where: { businessId, jobId: { in: jobIds } },
    select: { jobId: true, status: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
  });
  for (const row of rows) {
    if (!row.jobId || map.has(row.jobId)) continue;
    map.set(row.jobId, row.status);
  }
  return map;
}

async function lastFollowUpByCustomerId(
  db: RetentionDb,
  businessId: string,
  customerIds: string[],
) {
  const map = new Map<string, { status: string; kind: string }>();
  if (customerIds.length === 0) return map;
  const rows = await db.customerFollowUp.findMany({
    where: { businessId, customerId: { in: customerIds } },
    select: { customerId: true, status: true, kind: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
  });
  for (const row of rows) {
    if (map.has(row.customerId)) continue;
    map.set(row.customerId, { status: row.status, kind: row.kind });
  }
  return map;
}

async function laterJobByCompletedJob(
  db: RetentionDb,
  businessId: string,
  jobs: Array<{ id: string; customerId: string | null; createdAt: Date }>,
): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>();
  const customerIds = [
    ...new Set(jobs.map((job) => job.customerId).filter((id): id is string => Boolean(id))),
  ];
  if (customerIds.length === 0) return map;
  const recorded = await db.job.findMany({
    where: { businessId, customerId: { in: customerIds } },
    select: { id: true, customerId: true, createdAt: true },
  });
  for (const job of jobs) {
    if (!job.customerId) {
      map.set(job.id, false);
      continue;
    }
    map.set(
      job.id,
      recorded.some(
        (row) =>
          row.customerId === job.customerId &&
          row.id !== job.id &&
          row.createdAt.getTime() > job.createdAt.getTime(),
      ),
    );
  }
  return map;
}

async function customersById(
  db: RetentionDb,
  businessId: string,
  customerIds: string[],
) {
  const map = new Map<string, { id: string; name: string; businessId: string }>();
  if (customerIds.length === 0) return map;
  const rows = await db.customer.findMany({
    where: { businessId, id: { in: customerIds } },
    select: { id: true, name: true, businessId: true },
  });
  for (const row of rows) map.set(row.id, row);
  return map;
}

function buildCandidateLinks(input: {
  role: MembershipRole;
  accessBusinessId: string;
  customer: { id: string; businessId: string };
  job: { id: string; businessId: string };
  invoice?: { id: string; businessId: string } | null;
}): RetentionCandidate["links"] {
  const links: RetentionCandidate["links"] = [];
  pushLink(
    links,
    sameTenantRecordHref(
      "customer",
      input.customer.id,
      input.customer.businessId,
      input.accessBusinessId,
      input.role,
    ),
    "Open customer",
  );
  pushLink(
    links,
    sameTenantRecordHref("job", input.job.id, input.job.businessId, input.accessBusinessId, input.role),
    "Open job",
  );
  if (input.invoice) {
    pushLink(
      links,
      sameTenantRecordHref(
        "invoice",
        input.invoice.id,
        input.invoice.businessId,
        input.accessBusinessId,
        input.role,
      ),
      "Open invoice",
    );
  }
  pushLink(
    links,
    sameTenantCommunicationsHref(input.customer.id, input.customer.businessId, input.accessBusinessId),
    "Open communications",
  );
  return links;
}

async function hydrateCandidates(input: {
  db: RetentionDb;
  businessId: string;
  role: MembershipRole;
  now: Date;
  timeZone: string;
  group: RetentionCandidate["group"];
  fact: string;
  jobs: Array<{
    id: string;
    businessId: string;
    customerId: string | null;
    createdAt: Date;
  }>;
  laterJobByCustomer?: Map<string, boolean>;
}): Promise<RetentionCandidate[]> {
  const customerIds = [
    ...new Set(input.jobs.map((job) => job.customerId).filter((id): id is string => Boolean(id))),
  ];
  const jobIds = input.jobs.map((job) => job.id);
  const [customers, completions, counts, invoices, reviewStatuses, followUps, laterByJob] =
    await Promise.all([
      customersById(input.db, input.businessId, customerIds),
      completionByJobId(input.db, input.businessId, jobIds),
      completedJobCounts(input.db, input.businessId, customerIds),
      lastInvoiceByJobId(input.db, input.businessId, jobIds),
      lastReviewRequestByJobId(input.db, input.businessId, jobIds),
      lastFollowUpByCustomerId(input.db, input.businessId, customerIds),
      laterJobByCompletedJob(input.db, input.businessId, input.jobs),
    ]);

  const rows: RetentionCandidate[] = [];
  for (const job of input.jobs) {
    if (!job.customerId) continue;
    const customer = customers.get(job.customerId);
    if (!customer) continue;
    const completedAt = completions.get(job.id) ?? null;
    const daysSinceCompleted = completedAt
      ? daysSinceInBusinessTimeZone(completedAt, input.now, input.timeZone)
      : null;
    const invoice = invoices.get(job.id) ?? null;
    const followUp = followUps.get(job.customerId) ?? null;
    rows.push({
      group: input.group,
      fact: input.fact,
      customerId: customer.id,
      customerName: customer.name,
      lastCompletedJobId: job.id,
      lastCompletedAt: completedAt,
      lastCompletedAtSource: completedAt ? "JOB_COMPLETED" : "unrecorded",
      daysSinceCompleted,
      lastCompletedAgeLabel:
        daysSinceCompleted == null ? null : formatLastCompletedAge(daysSinceCompleted),
      completedJobCount: counts.get(customer.id) ?? 0,
      laterJobRecorded:
        input.laterJobByCustomer?.get(customer.id) ?? laterByJob.get(job.id) ?? false,
      lastInvoiceStatus: invoice?.status ?? null,
      lastInvoiceId: invoice?.id ?? null,
      lastReviewRequestStatus: reviewStatuses.get(job.id) ?? null,
      lastFollowUpStatus: followUp ? recordedFollowUpStatusLabel(followUp.status) : null,
      lastFollowUpKind: followUp?.kind ?? null,
      links: buildCandidateLinks({
        role: input.role,
        accessBusinessId: input.businessId,
        customer,
        job,
        invoice,
      }),
    });
  }
  return rows;
}

async function loadNoReviewRequestCandidates(input: {
  db: RetentionDb;
  businessId: string;
  role: MembershipRole;
  customerId: string | null;
  now: Date;
  timeZone: string;
}): Promise<RetentionCandidate[]> {
  const jobs = await input.db.job.findMany({
    where: {
      businessId: input.businessId,
      status: "COMPLETED",
      ...customerWhere(input.customerId),
      NOT: {
        reviewRequests: {
          some: { businessId: input.businessId },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: RETENTION_CANDIDATE_LIMIT,
    select: {
      id: true,
      businessId: true,
      customerId: true,
      createdAt: true,
    },
  });
  return hydrateCandidates({
    db: input.db,
    businessId: input.businessId,
    role: input.role,
    now: input.now,
    timeZone: input.timeZone,
    group: "NO_REVIEW_REQUEST",
    fact: NO_REVIEW_REQUEST_FACT,
    jobs,
  });
}

async function loadNoLaterJobCandidates(input: {
  db: RetentionDb;
  businessId: string;
  role: MembershipRole;
  customerId: string | null;
  now: Date;
  timeZone: string;
}): Promise<RetentionCandidate[]> {
  const seeds = await input.db.job.findMany({
    where: {
      businessId: input.businessId,
      status: "COMPLETED",
      ...customerWhere(input.customerId),
    },
    orderBy: { createdAt: "desc" },
    take: RETENTION_CANDIDATE_LIMIT,
    select: {
      id: true,
      businessId: true,
      customerId: true,
      createdAt: true,
    },
  });

  const seen = new Set<string>();
  const jobs: typeof seeds = [];
  const laterJobByCustomer = new Map<string, boolean>();

  for (const seed of seeds) {
    if (!seed.customerId || seen.has(seed.customerId)) continue;
    seen.add(seed.customerId);
    const lastCompleted = await findLastCompletedJobForCustomer(
      input.db,
      input.businessId,
      seed.customerId,
    );
    if (!lastCompleted || !lastCompleted.customerId) continue;
    const later = await hasLaterSameBusinessJob(
      input.db,
      input.businessId,
      lastCompleted.customerId,
      lastCompleted.createdAt,
      lastCompleted.id,
    );
    laterJobByCustomer.set(lastCompleted.customerId, later);
    if (later) continue;
    jobs.push(lastCompleted);
  }

  return hydrateCandidates({
    db: input.db,
    businessId: input.businessId,
    role: input.role,
    now: input.now,
    timeZone: input.timeZone,
    group: "NO_LATER_JOB",
    fact: NO_LATER_JOB_FACT,
    jobs,
    laterJobByCustomer,
  });
}

async function loadNoReferralRequestCandidates(input: {
  db: RetentionDb;
  businessId: string;
  role: MembershipRole;
  customerId: string | null;
  now: Date;
  timeZone: string;
}): Promise<RetentionCandidate[]> {
  const jobs = await input.db.job.findMany({
    where: {
      businessId: input.businessId,
      status: "COMPLETED",
      ...customerWhere(input.customerId),
      NOT: {
        referralRequests: {
          some: { businessId: input.businessId },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: RETENTION_CANDIDATE_LIMIT,
    select: {
      id: true,
      businessId: true,
      customerId: true,
      createdAt: true,
    },
  });
  return hydrateCandidates({
    db: input.db,
    businessId: input.businessId,
    role: input.role,
    now: input.now,
    timeZone: input.timeZone,
    group: "NO_REFERRAL_REQUEST",
    fact: NO_REFERRAL_REQUEST_FACT,
    jobs,
  });
}

async function loadRecordedFollowUps(input: {
  db: RetentionDb;
  businessId: string;
  role: MembershipRole;
  customerId: string | null;
}): Promise<RetentionFollowUpRow[]> {
  const rows = await input.db.customerFollowUp.findMany({
    where: {
      businessId: input.businessId,
      ...(input.customerId ? { customerId: input.customerId } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: RETENTION_CANDIDATE_LIMIT,
    select: {
      id: true,
      businessId: true,
      customerId: true,
      jobId: true,
      kind: true,
      status: true,
      origin: true,
      customer: { select: { id: true, name: true, businessId: true } },
      job: { select: { id: true, businessId: true } },
    },
  });

  return rows
    .filter((row) => row.customer.businessId === input.businessId)
    .map((row) => {
      const links: RetentionFollowUpRow["links"] = [];
      pushLink(
        links,
        sameTenantRecordHref(
          "customer",
          row.customer.id,
          row.customer.businessId,
          input.businessId,
          input.role,
        ),
        "Open customer",
      );
      if (row.job && row.jobId) {
        pushLink(
          links,
          sameTenantRecordHref("job", row.job.id, row.job.businessId, input.businessId, input.role),
          "Open job",
        );
      }
      pushLink(
        links,
        sameTenantCommunicationsHref(row.customer.id, row.customer.businessId, input.businessId),
        "Open communications",
      );
      return {
        group: "RECORDED_FOLLOW_UP" as const,
        fact: RECORDED_FOLLOW_UP_FACT,
        followUpId: row.id,
        customerId: row.customerId,
        customerName: row.customer.name,
        jobId: row.jobId,
        kind: row.kind,
        status: row.status,
        statusLabel: recordedFollowUpStatusLabel(row.status),
        origin: row.origin,
        links,
      };
    });
}

async function loadIncompleteJourney(input: {
  db: RetentionDb;
  businessId: string;
  role: MembershipRole;
  customerId: string | null;
  now: Date;
}): Promise<RetentionJourneyRow[]> {
  const requests = await input.db.serviceRequest.findMany({
    where: {
      businessId: input.businessId,
      ...(input.customerId ? { customerId: input.customerId } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: RETENTION_CANDIDATE_LIMIT,
    select: {
      id: true,
      customerId: true,
      leadSource: true,
      campaignId: true,
      originalLeadSource: true,
      originalCampaignId: true,
      landingPagePath: true,
      localPageSlug: true,
      matchedServiceAreaId: true,
      serviceAreaQualification: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  const requestIds = requests.map((row) => row.id);
  const relatedEstimates =
    requestIds.length === 0
      ? []
      : await input.db.estimate.findMany({
          where: { businessId: input.businessId, serviceRequestId: { in: requestIds } },
          select: {
            id: true,
            customerId: true,
            serviceRequestId: true,
            status: true,
            total: true,
            leadSource: true,
            campaignId: true,
            createdAt: true,
            updatedAt: true,
          },
        });
  const estimateIds = relatedEstimates.map((row) => row.id);
  const relatedJobs =
    estimateIds.length === 0
      ? []
      : await input.db.job.findMany({
          where: { businessId: input.businessId, estimateId: { in: estimateIds } },
          select: {
            id: true,
            customerId: true,
            estimateId: true,
            status: true,
            leadSource: true,
            campaignId: true,
            createdAt: true,
            updatedAt: true,
          },
        });
  const relatedPipeline =
    requestIds.length === 0
      ? []
      : await input.db.pipelineOpportunity.findMany({
          where: { businessId: input.businessId, serviceRequestId: { in: requestIds } },
          select: {
            serviceRequestId: true,
            standaloneEstimateId: true,
            ownerStage: true,
            followUpOn: true,
            lossReason: true,
            updatedAt: true,
          },
        });
  const customerIds = [
    ...new Set(
      [...requests, ...relatedEstimates]
        .map((row) => row.customerId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const relatedCustomers =
    customerIds.length === 0
      ? []
      : await input.db.customer.findMany({
          where: { businessId: input.businessId, id: { in: customerIds } },
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            smsConsentStatus: true,
            firstLeadSource: true,
            firstCampaignId: true,
            createdAt: true,
          },
        });

  const source: GrowthSource = {
    now: input.now,
    requests,
    estimates: relatedEstimates,
    jobs: relatedJobs,
    invoices: [],
    pipeline: relatedPipeline,
    customers: relatedCustomers,
    campaigns: [],
    reviews: [],
    reviewRequests: [],
    referrals: [],
    referralRequests: [],
    followUps: [],
    serviceAreas: [],
    localPageDrafts: [],
    publishedLocalPages: [],
  };

  const items = buildRecoveryQueue(source).slice(0, RETENTION_CANDIDATE_LIMIT);
  const customerBusiness = new Map(relatedCustomers.map((row) => [row.id, input.businessId]));

  return items.map((item) => {
    const links: RetentionJourneyRow["links"] = [];
    pushLink(links, "/growth?area=recovery", "Open Growth recovery");
    if (item.customerId) {
      const ownedBusinessId = customerBusiness.get(item.customerId);
      if (ownedBusinessId) {
        pushLink(
          links,
          sameTenantRecordHref(
            "customer",
            item.customerId,
            ownedBusinessId,
            input.businessId,
            input.role,
          ),
          "Open customer",
        );
        pushLink(
          links,
          sameTenantCommunicationsHref(item.customerId, ownedBusinessId, input.businessId),
          "Open communications",
        );
      }
    }
    if (item.estimateId) {
      pushLink(
        links,
        sameTenantRecordHref("estimate", item.estimateId, input.businessId, input.businessId, input.role),
        "Open estimate",
      );
    }
    return {
      group: "INCOMPLETE_JOURNEY" as const,
      fact: INCOMPLETE_JOURNEY_FACT,
      queue: item.queue,
      queueLabel: RECOVERY_QUEUE_LABELS[item.queue],
      customerId: item.customerId,
      customerName: item.customerName,
      requestId: item.requestId,
      estimateId: item.estimateId,
      links,
    };
  });
}

export async function loadRetentionRecoveryCenter(
  db: RetentionDb,
  access: LoadRetentionRecoveryCenterInput,
): Promise<RetentionWorkspace> {
  requireRetentionCenterAccess(access);
  const now = access.now ?? new Date();
  const timeZone = await loadBusinessTimeZone(db, access.businessId);

  let customerId: string | null = null;
  if (access.customerId) {
    const owned = await resolveOwnedRetentionCustomer(db, access.businessId, access.customerId);
    if (!owned) return emptyWorkspace(access.businessId, timeZone);
    customerId = owned.id;
  }

  const [noReviewRequest, noLaterJob, recordedFollowUp, noReferralRequest, incompleteJourney] =
    await Promise.all([
      loadNoReviewRequestCandidates({
        db,
        businessId: access.businessId,
        role: access.role,
        customerId,
        now,
        timeZone,
      }),
      loadNoLaterJobCandidates({
        db,
        businessId: access.businessId,
        role: access.role,
        customerId,
        now,
        timeZone,
      }),
      loadRecordedFollowUps({
        db,
        businessId: access.businessId,
        role: access.role,
        customerId,
      }),
      loadNoReferralRequestCandidates({
        db,
        businessId: access.businessId,
        role: access.role,
        customerId,
        now,
        timeZone,
      }),
      loadIncompleteJourney({
        db,
        businessId: access.businessId,
        role: access.role,
        customerId,
        now,
      }),
    ]);

  return {
    businessId: access.businessId,
    timeZone,
    candidateLimit: RETENTION_CANDIDATE_LIMIT,
    readOnly: true,
    mutationsOnLoad: false,
    groups: {
      noReviewRequest,
      noLaterJob,
      recordedFollowUp,
      noReferralRequest,
      incompleteJourney,
    },
    totals: {
      noReviewRequest: noReviewRequest.length,
      noLaterJob: noLaterJob.length,
      recordedFollowUp: recordedFollowUp.length,
      noReferralRequest: noReferralRequest.length,
      incompleteJourney: incompleteJourney.length,
    },
  };
}

/**
 * Bounded same-business retention facts for the Growth specialist.
 *
 * Reuses the merged Retention Recovery Center loader and canonical
 * absence queries. Does not invent churn, buying intent, or a contact
 * cadence, and does not record follow-up tasks or send messages.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, roleHasCapability, type Capability } from "@/lib/authorization";
import type { SpecialistFinding } from "@/lib/chief-of-staff/types";
import {
  DUE_OR_OVERDUE_FACT,
  INCOMPLETE_JOURNEY_FACT,
  NO_LATER_JOB_FACT,
  NO_REFERRAL_REQUEST_FACT,
  NO_REVIEW_REQUEST_FACT,
  RECORDED_FOLLOW_UP_FACT,
  RETENTION_CANDIDATE_LIMIT,
  RETENTION_GROUP_TITLES,
  RETENTION_ROUTE,
} from "@/lib/growth/retention/constants";
import { loadRetentionRecoveryCenter } from "@/lib/growth/retention/load";
import type {
  RetentionCandidate,
  RetentionFollowUpRow,
  RetentionJourneyRow,
  RetentionLink,
  RetentionWorkspace,
} from "@/lib/growth/retention/types";

type RetentionDb = PrismaClient | Prisma.TransactionClient;

export const GROWTH_RETENTION_CONTEXT_CAPS = {
  candidates: 4,
  followUps: 4,
  journeys: 4,
  entityIds: 4,
  ownerLinks: 4,
  facts: 8,
  findings: 8,
} as const;

export const GROWTH_RETENTION_FACT_KEYS = {
  noReviewRequest: "retention-no-review-request",
  noLaterJob: "retention-no-later-job",
  dueOrOverdue: "retention-due-or-overdue",
  recordedFollowUp: "retention-recorded-follow-up",
  noReferralRequest: "retention-no-referral-request",
  incompleteJourney: "retention-incomplete-journey",
} as const;

export const GROWTH_RETENTION_NOT_AUTHORIZED_LIMITATION =
  "Growth and retention facts were not loaded because this role cannot view reports. Assigned field work is not whole-customer retention history. Missing Growth data is not treated as zero opportunities.";

export type RetentionOwnerRecordType = "CUSTOMER" | "JOB" | "FOLLOW_UP_TASK";

export type RetentionOwnerLink = {
  recordType: RetentionOwnerRecordType;
  id: string;
  href: string;
  label: string;
};

export type GrowthRetentionCandidateProjection = {
  group: RetentionCandidate["group"];
  fact: string;
  customerId: string;
  lastCompletedJobId: string;
  completedJobCount: number;
  laterJobRecorded: boolean;
  lastReviewRequestStatus: string | null;
  lastFollowUpStatus: string | null;
  lastCompletedAgeLabel: string | null;
  ownerLinks: RetentionOwnerLink[];
};

export type GrowthRetentionFollowUpProjection = {
  group: RetentionFollowUpRow["group"];
  fact: string;
  followUpId: string;
  customerId: string;
  jobId: string | null;
  kind: string;
  status: string;
  statusLabel: string;
  dueState: RetentionFollowUpRow["dueState"];
  dueStateLabel: string;
  ownerLinks: RetentionOwnerLink[];
};

export type GrowthRetentionJourneyProjection = {
  group: "INCOMPLETE_JOURNEY";
  fact: string;
  queue: string;
  queueLabel: string;
  customerId: string | null;
  requestId: string | null;
  estimateId: string | null;
  ownerLinks: RetentionOwnerLink[];
};

export type GrowthRetentionProjection = {
  totals: RetentionWorkspace["totals"];
  candidateLimit: number;
  noReviewRequest: GrowthRetentionCandidateProjection[];
  noLaterJob: GrowthRetentionCandidateProjection[];
  dueOrOverdue: GrowthRetentionFollowUpProjection[];
  recordedFollowUp: GrowthRetentionFollowUpProjection[];
  noReferralRequest: GrowthRetentionCandidateProjection[];
  incompleteJourney: GrowthRetentionJourneyProjection[];
  centerReused: true;
};

function hrefForLabel(links: RetentionLink[], label: string) {
  return links.find((link) => link.label === label)?.href ?? null;
}

function pushOwnerLink(links: RetentionOwnerLink[], link: RetentionOwnerLink | null) {
  if (!link) return;
  if (links.some((row) => row.href === link.href || (row.recordType === link.recordType && row.id === link.id))) {
    return;
  }
  if (links.length >= GROWTH_RETENTION_CONTEXT_CAPS.ownerLinks) return;
  links.push(link);
}

function ownerLink(
  recordType: RetentionOwnerRecordType,
  id: string,
  href: string | null,
  label: string,
): RetentionOwnerLink | null {
  if (!href) return null;
  return { recordType, id, href, label };
}

export function ownerLinksForRetentionCandidate(row: RetentionCandidate): RetentionOwnerLink[] {
  const links: RetentionOwnerLink[] = [];
  pushOwnerLink(
    links,
    ownerLink("CUSTOMER", row.customerId, hrefForLabel(row.links, "Open customer"), "Open customer"),
  );
  pushOwnerLink(
    links,
    ownerLink("JOB", row.lastCompletedJobId, hrefForLabel(row.links, "Open job"), "Open job"),
  );
  return links;
}

export function ownerLinksForRetentionFollowUp(row: RetentionFollowUpRow): RetentionOwnerLink[] {
  const links: RetentionOwnerLink[] = [];
  pushOwnerLink(
    links,
    ownerLink("CUSTOMER", row.customerId, hrefForLabel(row.links, "Open customer"), "Open customer"),
  );
  if (row.jobId) {
    pushOwnerLink(links, ownerLink("JOB", row.jobId, hrefForLabel(row.links, "Open job"), "Open job"));
  }
  const customerHref = hrefForLabel(row.links, "Open customer");
  if (customerHref) {
    pushOwnerLink(
      links,
      ownerLink(
        "FOLLOW_UP_TASK",
        row.followUpId,
        `${RETENTION_ROUTE}?customerId=${encodeURIComponent(row.customerId)}`,
        "Open follow-up task",
      ),
    );
  }
  return links;
}

export function ownerLinksForRetentionJourney(row: RetentionJourneyRow): RetentionOwnerLink[] {
  const links: RetentionOwnerLink[] = [];
  if (row.customerId) {
    pushOwnerLink(
      links,
      ownerLink("CUSTOMER", row.customerId, hrefForLabel(row.links, "Open customer"), "Open customer"),
    );
  }
  return links;
}

function projectCandidate(row: RetentionCandidate): GrowthRetentionCandidateProjection {
  return {
    group: row.group,
    fact: row.fact,
    customerId: row.customerId,
    lastCompletedJobId: row.lastCompletedJobId,
    completedJobCount: row.completedJobCount,
    laterJobRecorded: row.laterJobRecorded,
    lastReviewRequestStatus: row.lastReviewRequestStatus,
    lastFollowUpStatus: row.lastFollowUpStatus,
    lastCompletedAgeLabel: row.lastCompletedAgeLabel,
    ownerLinks: ownerLinksForRetentionCandidate(row),
  };
}

function projectFollowUp(row: RetentionFollowUpRow): GrowthRetentionFollowUpProjection {
  return {
    group: row.group,
    fact: row.fact,
    followUpId: row.followUpId,
    customerId: row.customerId,
    jobId: row.jobId,
    kind: row.kind,
    status: row.status,
    statusLabel: row.statusLabel,
    dueState: row.dueState,
    dueStateLabel: row.dueStateLabel,
    ownerLinks: ownerLinksForRetentionFollowUp(row),
  };
}

function projectJourney(row: RetentionJourneyRow): GrowthRetentionJourneyProjection {
  return {
    group: "INCOMPLETE_JOURNEY",
    fact: row.fact,
    queue: row.queue,
    queueLabel: row.queueLabel,
    customerId: row.customerId,
    requestId: row.requestId,
    estimateId: row.estimateId,
    ownerLinks: ownerLinksForRetentionJourney(row),
  };
}

export function projectRetentionFromWorkspace(workspace: RetentionWorkspace): GrowthRetentionProjection {
  return {
    totals: { ...workspace.totals },
    candidateLimit: workspace.candidateLimit,
    noReviewRequest: workspace.groups.noReviewRequest
      .slice(0, GROWTH_RETENTION_CONTEXT_CAPS.candidates)
      .map(projectCandidate),
    noLaterJob: workspace.groups.noLaterJob
      .slice(0, GROWTH_RETENTION_CONTEXT_CAPS.candidates)
      .map(projectCandidate),
    dueOrOverdue: workspace.groups.dueOrOverdue
      .slice(0, GROWTH_RETENTION_CONTEXT_CAPS.followUps)
      .map(projectFollowUp),
    recordedFollowUp: workspace.groups.recordedFollowUp
      .slice(0, GROWTH_RETENTION_CONTEXT_CAPS.followUps)
      .map(projectFollowUp),
    noReferralRequest: workspace.groups.noReferralRequest
      .slice(0, GROWTH_RETENTION_CONTEXT_CAPS.candidates)
      .map(projectCandidate),
    incompleteJourney: workspace.groups.incompleteJourney
      .slice(0, GROWTH_RETENTION_CONTEXT_CAPS.journeys)
      .map(projectJourney),
    centerReused: true,
  };
}

export function growthRetentionFactsFromProjection(
  projection: GrowthRetentionProjection,
): Record<string, string> {
  return {
    [GROWTH_RETENTION_FACT_KEYS.noReviewRequest]: String(projection.totals.noReviewRequest),
    [GROWTH_RETENTION_FACT_KEYS.noLaterJob]: String(projection.totals.noLaterJob),
    [GROWTH_RETENTION_FACT_KEYS.dueOrOverdue]: String(projection.totals.dueOrOverdue),
    [GROWTH_RETENTION_FACT_KEYS.recordedFollowUp]: String(projection.totals.recordedFollowUp),
    [GROWTH_RETENTION_FACT_KEYS.noReferralRequest]: String(projection.totals.noReferralRequest),
    [GROWTH_RETENTION_FACT_KEYS.incompleteJourney]: String(projection.totals.incompleteJourney),
  };
}

function collectOwnerLinks(rows: Array<{ ownerLinks: RetentionOwnerLink[] }>) {
  const links: RetentionOwnerLink[] = [];
  for (const row of rows) {
    for (const link of row.ownerLinks) {
      pushOwnerLink(links, link);
    }
  }
  return links;
}

function collectEntityIds(ids: Array<string | null | undefined>) {
  const out: string[] = [];
  for (const id of ids) {
    if (!id || out.includes(id)) continue;
    out.push(id);
    if (out.length >= GROWTH_RETENTION_CONTEXT_CAPS.entityIds) break;
  }
  return out;
}

function countedWhy(count: number, noun: string, fact: string) {
  const unit = count === 1 ? noun : `${noun}s`;
  const verb = count === 1 ? "matches" : "match";
  return `${count} recorded ${unit} ${verb}: ${fact}`;
}

export function findingsFromRetentionProjection(projection: GrowthRetentionProjection): Array<{
  key: string;
  title: string;
  why: string;
  entityIds?: string[];
  ownerLinks?: RetentionOwnerLink[];
}> {
  const findings: Array<{
    key: string;
    title: string;
    why: string;
    entityIds?: string[];
    ownerLinks?: RetentionOwnerLink[];
  }> = [];

  if (projection.totals.noReviewRequest > 0) {
    findings.push({
      key: GROWTH_RETENTION_FACT_KEYS.noReviewRequest,
      title: RETENTION_GROUP_TITLES.NO_REVIEW_REQUEST,
      why: countedWhy(projection.totals.noReviewRequest, "completed job", NO_REVIEW_REQUEST_FACT),
      entityIds: collectEntityIds(
        projection.noReviewRequest.flatMap((row) => [row.customerId, row.lastCompletedJobId]),
      ),
      ownerLinks: collectOwnerLinks(projection.noReviewRequest),
    });
  }
  if (projection.totals.noLaterJob > 0) {
    findings.push({
      key: GROWTH_RETENTION_FACT_KEYS.noLaterJob,
      title: RETENTION_GROUP_TITLES.NO_LATER_JOB,
      why: countedWhy(projection.totals.noLaterJob, "past customer", NO_LATER_JOB_FACT),
      entityIds: collectEntityIds(
        projection.noLaterJob.flatMap((row) => [row.customerId, row.lastCompletedJobId]),
      ),
      ownerLinks: collectOwnerLinks(projection.noLaterJob),
    });
  }
  if (projection.totals.dueOrOverdue > 0) {
    findings.push({
      key: GROWTH_RETENTION_FACT_KEYS.dueOrOverdue,
      title: RETENTION_GROUP_TITLES.DUE_OR_OVERDUE,
      why: countedWhy(projection.totals.dueOrOverdue, "follow-up task", DUE_OR_OVERDUE_FACT),
      entityIds: collectEntityIds(
        projection.dueOrOverdue.flatMap((row) => [row.followUpId, row.customerId, row.jobId]),
      ),
      ownerLinks: collectOwnerLinks(projection.dueOrOverdue),
    });
  }
  if (projection.totals.recordedFollowUp > 0) {
    findings.push({
      key: GROWTH_RETENTION_FACT_KEYS.recordedFollowUp,
      title: RETENTION_GROUP_TITLES.RECORDED_FOLLOW_UP,
      why: `${projection.totals.recordedFollowUp} recorded follow-up ${
        projection.totals.recordedFollowUp === 1 ? "row is" : "rows are"
      } on file. ${RECORDED_FOLLOW_UP_FACT}`,
      entityIds: collectEntityIds(
        projection.recordedFollowUp.flatMap((row) => [row.followUpId, row.customerId, row.jobId]),
      ),
      ownerLinks: collectOwnerLinks(projection.recordedFollowUp),
    });
  }
  if (projection.totals.noReferralRequest > 0) {
    findings.push({
      key: GROWTH_RETENTION_FACT_KEYS.noReferralRequest,
      title: RETENTION_GROUP_TITLES.NO_REFERRAL_REQUEST,
      why: countedWhy(projection.totals.noReferralRequest, "completed job", NO_REFERRAL_REQUEST_FACT),
      entityIds: collectEntityIds(
        projection.noReferralRequest.flatMap((row) => [row.customerId, row.lastCompletedJobId]),
      ),
      ownerLinks: collectOwnerLinks(projection.noReferralRequest),
    });
  }
  if (projection.totals.incompleteJourney > 0) {
    findings.push({
      key: GROWTH_RETENTION_FACT_KEYS.incompleteJourney,
      title: RETENTION_GROUP_TITLES.INCOMPLETE_JOURNEY,
      why: countedWhy(projection.totals.incompleteJourney, "incomplete journey", INCOMPLETE_JOURNEY_FACT),
      entityIds: collectEntityIds(
        projection.incompleteJourney.flatMap((row) => [row.customerId, row.requestId, row.estimateId]),
      ),
      ownerLinks: collectOwnerLinks(projection.incompleteJourney),
    });
  }

  return findings.slice(0, GROWTH_RETENTION_CONTEXT_CAPS.findings);
}

export function appendRetentionFactKeys(
  factKeys: string[],
  facts: Record<string, string>,
  projection: GrowthRetentionProjection,
  factsCap: number,
) {
  const next = growthRetentionFactsFromProjection(projection);
  for (const [key, value] of Object.entries(next)) {
    if (factKeys.includes(key) || factKeys.length >= factsCap) continue;
    facts[key] = value;
    factKeys.push(key);
  }
  return { facts, factKeys };
}

export function attachRetentionFindings(
  baseFindings: SpecialistFinding[],
  factKeys: string[],
  projection: GrowthRetentionProjection,
): SpecialistFinding[] {
  const extra = findingsFromRetentionProjection(projection).map((item) => ({
    key: item.key,
    title: item.title,
    summary: item.why,
    recommendationKeys: [],
    factKeys,
    entityIds: item.entityIds,
    ownerLinks: item.ownerLinks,
  }));
  return [...baseFindings, ...extra];
}

export function hasGrowthViewAccess(access: BusinessAccess, denyRoleCapabilities?: Capability[]) {
  if (denyRoleCapabilities?.includes(CAPABILITIES.VIEW_REPORTS)) return false;
  return roleHasCapability(access.workspace.role, CAPABILITIES.VIEW_REPORTS);
}

export async function loadGrowthRetentionCenter(
  db: RetentionDb,
  access: BusinessAccess,
  input?: { customerId?: string | null; now?: Date },
) {
  return loadRetentionRecoveryCenter(db, {
    businessId: access.businessId,
    role: access.workspace.role,
    customerId: input?.customerId,
    now: input?.now,
  });
}

export function growthRetentionCandidateLimit() {
  return RETENTION_CANDIDATE_LIMIT;
}

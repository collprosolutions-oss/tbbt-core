/**
 * Experience Intelligence mutations and candidate scan.
 * Machine inference stays CANDIDATE until the owner reviews it.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { OWNER_KNOWLEDGE_APPROVAL_MESSAGE } from "@/lib/knowledge";
import {
  EXPERIENCE_CANDIDATE_NOT_POLICY_MESSAGE,
  isExperienceLearningKind,
  isExperienceLearningStatus,
} from "@/lib/experience-intelligence";
import { createKnowledgeEntry } from "@/lib/knowledge-ops";

type Db = PrismaClient | Prisma.TransactionClient;

export class ExperienceIntelligenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExperienceIntelligenceError";
  }
}

export function experienceErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ExperienceIntelligenceError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  if (error instanceof Error && error.name === "KnowledgeError") return error.message;
  return fallback;
}

async function upsertCandidate(
  db: Db,
  access: BusinessAccess,
  input: {
    kind: string;
    evidenceKey: string;
    title: string;
    body: string;
    evidence: Record<string, unknown>;
    sourceKind?: string;
    sourceReferenceId?: string;
    confidence?: string;
  },
) {
  const existing = await db.experienceLearningCandidate.findFirst({
    where: {
      businessId: access.businessId,
      kind: input.kind,
      evidenceKey: input.evidenceKey,
    },
  });
  if (existing) return existing;
  return db.experienceLearningCandidate.create({
    data: {
      businessId: access.businessId,
      kind: input.kind,
      evidenceKey: input.evidenceKey,
      title: input.title,
      body: `${input.body}\n\n${EXPERIENCE_CANDIDATE_NOT_POLICY_MESSAGE}`,
      evidenceJson: JSON.stringify(input.evidence),
      sourceKind: input.sourceKind ?? null,
      sourceReferenceId: input.sourceReferenceId ?? null,
      confidence: input.confidence ?? "MEDIUM",
      status: "CANDIDATE",
    },
  });
}

export async function scanExperienceCandidates(db: Db, access: BusinessAccess) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_KNOWLEDGE);
  const scope = access.scope;
  const created: string[] = [];

  const jobs = await db.job.findMany({
    where: { ...scope, status: "COMPLETED", scheduledDurationMinutes: { not: null } },
    select: {
      id: true,
      scheduledDurationMinutes: true,
      timeEntries: {
        where: { status: "APPROVED" },
        select: { approvedHours: true },
      },
      changeOrders: { select: { id: true } },
      estimate: {
        select: {
          serviceRequest: { select: { summary: true, serviceCatalogItem: { select: { name: true } } } },
        },
      },
    },
    take: 80,
  });

  for (const job of jobs) {
    const expected = job.scheduledDurationMinutes ?? 0;
    const actualHours = job.timeEntries.reduce((sum, entry) => {
      return sum + Number(entry.approvedHours ?? 0);
    }, 0);
    const actualMinutes = actualHours * 60;
    if (expected > 0 && actualMinutes > expected * 1.25 && actualMinutes - expected >= 30) {
      const row = await upsertCandidate(db, access, {
        kind: "DURATION_VARIANCE",
        evidenceKey: `job-duration:${job.id}`,
        title: "Job ran longer than the scheduled duration",
        body: `Recorded approved time was ${Math.round(actualMinutes)} minutes against a scheduled ${expected} minutes.`,
        evidence: { jobId: job.id, expectedMinutes: expected, actualMinutes: Math.round(actualMinutes) },
        sourceKind: "JOB",
        sourceReferenceId: job.id,
      });
      created.push(row.id);
    }
    if (job.changeOrders.length > 0) {
      const serviceName =
        job.estimate?.serviceRequest?.serviceCatalogItem?.name ??
        job.estimate?.serviceRequest?.summary ??
        "this job type";
      const row = await upsertCandidate(db, access, {
        kind: "SCOPE_CHANGE",
        evidenceKey: `scope-change:${job.id}`,
        title: `Scope changed on ${serviceName}`,
        body: `${job.changeOrders.length} recorded change order(s) exist on this completed job.`,
        evidence: { jobId: job.id, changeOrderCount: job.changeOrders.length },
        sourceKind: "JOB",
        sourceReferenceId: job.id,
      });
      created.push(row.id);
    }
  }

  const requests = await db.serviceRequest.findMany({
    where: scope,
    select: { id: true, summary: true, description: true },
    take: 80,
  });
  const questionBuckets = new Map<string, string[]>();
  for (const request of requests) {
    const text = `${request.summary ?? ""} ${request.description ?? ""}`.toLowerCase();
    const token = text
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 4)
      .slice(0, 3)
      .join("-");
    if (!token) continue;
    const list = questionBuckets.get(token) ?? [];
    list.push(request.id);
    questionBuckets.set(token, list);
  }
  for (const [token, ids] of questionBuckets) {
    if (ids.length < 2) continue;
    const row = await upsertCandidate(db, access, {
      kind: "RECURRING_CUSTOMER_QUESTION",
      evidenceKey: `question:${token}`,
      title: "Customers keep asking a similar question",
      body: `${ids.length} recorded requests share similar wording. Consider an intake question or customer FAQ.`,
      evidence: { requestIds: ids.slice(0, 8), token },
      sourceKind: "REQUEST",
      sourceReferenceId: ids[0],
      confidence: "LOW",
    });
    created.push(row.id);
  }

  const problems = await db.jobProblemReport.findMany({
    where: scope,
    select: { id: true, jobId: true, description: true },
    take: 40,
  });
  for (const problem of problems) {
    if (!problem.description || problem.description.trim().length < 8) continue;
    const row = await upsertCandidate(db, access, {
      kind: "FIELD_NOTE",
      evidenceKey: `field:${problem.id}`,
      title: "Field note that may be a service lesson",
      body: problem.description.trim().slice(0, 400),
      evidence: { problemId: problem.id, jobId: problem.jobId },
      sourceKind: "JOB",
      sourceReferenceId: problem.jobId,
      confidence: "LOW",
    });
    created.push(row.id);
  }

  return {
    scanned: true,
    createdCount: created.length,
    message: EXPERIENCE_CANDIDATE_NOT_POLICY_MESSAGE,
  };
}

export async function reviewExperienceCandidate(
  db: Db,
  access: BusinessAccess,
  input: { candidateId: string; status: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_KNOWLEDGE);
  if (!isExperienceLearningStatus(input.status) || input.status === "CANDIDATE") {
    throw new ExperienceIntelligenceError("Choose reviewed, approved, or rejected.");
  }
  if (input.status === "APPROVED" || input.status === "REJECTED") {
    if (access.workspace.role !== "OWNER") {
      throw new ExperienceIntelligenceError(OWNER_KNOWLEDGE_APPROVAL_MESSAGE);
    }
  }
  const existing = access.assertOwned(
    await db.experienceLearningCandidate.findFirst({
      where: { id: input.candidateId, ...access.scope },
    }),
  );
  if (!isExperienceLearningKind(existing.kind)) {
    throw new ExperienceIntelligenceError("That candidate kind is not recognized.");
  }

  let knowledgeEntryId = existing.knowledgeEntryId;
  if (input.status === "APPROVED" && !knowledgeEntryId) {
    const kindToCategory = {
      DURATION_VARIANCE: "JOB_PROCEDURES",
      INTAKE_QUESTION: "CUSTOMERS_POLICIES",
      RECURRING_CUSTOMER_QUESTION: "CUSTOMERS_POLICIES",
      SCOPE_CHANGE: "ESTIMATING_TAKEOFFS",
      FIELD_NOTE: "TRAINING_HOWTO",
      ESTIMATING_ASSUMPTION: "ESTIMATING_TAKEOFFS",
    } as const;
    const kindToKnowledge = {
      DURATION_VARIANCE: "SCHEDULING_LESSON",
      INTAKE_QUESTION: "CUSTOMER_FAQ",
      RECURRING_CUSTOMER_QUESTION: "CUSTOMER_FAQ",
      SCOPE_CHANGE: "SERVICE_LESSON",
      FIELD_NOTE: "FIELD_TECHNIQUE",
      ESTIMATING_ASSUMPTION: "ESTIMATING_ASSUMPTION",
    } as const;
    const entry = await createKnowledgeEntry(db, access, {
      title: existing.title,
      body: existing.body,
      category: kindToCategory[existing.kind],
      sourceType: "TBBT_RECORD",
      sourceKind: "EXPERIENCE_CANDIDATE",
      sourceReferenceId: existing.id,
      trustState: "SUPPORTED",
      knowledgeKind: kindToKnowledge[existing.kind],
    });
    knowledgeEntryId = entry.id;
    await db.knowledgeEntry.update({
      where: { id: entry.id },
      data: {
        approvalState: "APPROVED",
        approvedAt: new Date(),
        approvedByMembershipId: access.workspace.membership.id,
        lastReviewedAt: new Date(),
        lastReviewedByMembershipId: access.workspace.membership.id,
      },
    });
  }

  return db.experienceLearningCandidate.update({
    where: { id: existing.id },
    data: {
      status: input.status,
      reviewedAt: new Date(),
      reviewedByMembershipId: access.workspace.membership.id,
      knowledgeEntryId,
    },
  });
}

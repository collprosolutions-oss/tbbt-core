/**
 * Read-only aftercare loaders. Mutation-free.
 *
 * OWNER review includes drafts, private notes, history, and recorded
 * warranty terms as stored. The customer project token may read only
 * published instructions for that token-scoped Job.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  JOB_AFTERCARE_HISTORY_BOUND,
  JOB_AFTERCARE_OWNER_WORKFLOW_MESSAGE,
  jobAftercareWriteAllowed,
  recordedAftercareEventLabel,
  recordedAftercareStatusLabel,
  type CustomerPublishedAftercare,
  type JobAftercareStatus,
  type OwnerJobAftercare,
  type OwnerJobAftercareHistoryEvent,
} from "@/lib/job-aftercare";
import {
  JOB_CALLBACK_NO_WARRANTY_TERMS_MESSAGE,
  JOB_CALLBACK_WARRANTY_DISCLAIMER,
  completedSameBusinessJobEligible,
  type RecordedWarrantyTerm,
} from "@/lib/job-callback";
import { loadRecordedWarrantyTerms } from "@/lib/job-callback-data";

type Db = PrismaClient | Prisma.TransactionClient;

const AFTERCARE_SELECT = {
  id: true,
  businessId: true,
  jobId: true,
  draftInstructions: true,
  ownerNotes: true,
  publishedInstructions: true,
  status: true,
  publishedAt: true,
  unpublishedAt: true,
  events: {
    orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
    take: JOB_AFTERCARE_HISTORY_BOUND,
    select: {
      id: true,
      eventType: true,
      fromStatus: true,
      toStatus: true,
      instructionsSnapshot: true,
      createdAt: true,
      actor: { select: { user: { select: { name: true } } } },
    },
  },
} satisfies Prisma.JobAftercareInstructionSelect;

export type JobAftercareReview = {
  jobId: string;
  jobStatus: string;
  eligible: boolean;
  canWrite: boolean;
  aftercare: OwnerJobAftercare | null;
  history: OwnerJobAftercareHistoryEvent[];
  warrantyTerms: RecordedWarrantyTerm[];
  warrantyDisclaimer: string;
  noWarrantyTermsMessage: string;
  workflowMessage: string;
};

function asOwnerAftercare(
  row: Prisma.JobAftercareInstructionGetPayload<{ select: typeof AFTERCARE_SELECT }>,
): OwnerJobAftercare {
  return {
    id: row.id,
    jobId: row.jobId,
    status: row.status as JobAftercareStatus,
    statusLabel: recordedAftercareStatusLabel(row.status),
    draftInstructions: row.draftInstructions,
    ownerNotes: row.ownerNotes,
    publishedInstructions: row.publishedInstructions,
    publishedAt: row.publishedAt,
    unpublishedAt: row.unpublishedAt,
  };
}

function asHistory(
  row: Prisma.JobAftercareInstructionGetPayload<{ select: typeof AFTERCARE_SELECT }>,
): OwnerJobAftercareHistoryEvent[] {
  return row.events.map((event) => ({
    id: event.id,
    eventType: event.eventType,
    eventLabel: recordedAftercareEventLabel(event.eventType),
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    instructionsSnapshot: event.instructionsSnapshot,
    createdAt: event.createdAt,
    actorName: event.actor.user.name,
  }));
}

export async function loadJobAftercareReview(
  db: Db,
  access: BusinessAccess,
  jobId: string,
): Promise<JobAftercareReview | null> {
  const job = await db.job.findFirst({
    where: { id: jobId, ...access.scope },
    select: {
      id: true,
      businessId: true,
      status: true,
      approvedEstimateVersionId: true,
      estimateId: true,
    },
  });
  if (!job) return null;
  access.assertOwned(job);

  const [aftercare, warrantyTerms] = await Promise.all([
    db.jobAftercareInstruction.findFirst({
      where: { jobId: job.id, businessId: access.businessId },
      select: AFTERCARE_SELECT,
    }),
    loadRecordedWarrantyTerms(db, access, job),
  ]);
  const owned = aftercare ? access.assertOwned(aftercare) : null;

  return {
    jobId: job.id,
    jobStatus: job.status,
    eligible: completedSameBusinessJobEligible(job, access.businessId),
    canWrite: jobAftercareWriteAllowed(access.workspace.role),
    aftercare: owned ? asOwnerAftercare(owned) : null,
    history: owned ? asHistory(owned) : [],
    warrantyTerms,
    warrantyDisclaimer: JOB_CALLBACK_WARRANTY_DISCLAIMER,
    noWarrantyTermsMessage: JOB_CALLBACK_NO_WARRANTY_TERMS_MESSAGE,
    workflowMessage: JOB_AFTERCARE_OWNER_WORKFLOW_MESSAGE,
  };
}

/**
 * Customer project token may read published instructions for that Job
 * only. Never returns drafts, owner notes, history, or other jobs.
 */
export async function loadPublishedAftercareForProjectToken(
  db: Db,
  projectToken: string,
): Promise<CustomerPublishedAftercare | null> {
  const token = projectToken.trim();
  if (!token) return null;
  const job = await db.job.findUnique({
    where: { projectToken: token },
    select: { id: true, businessId: true },
  });
  if (!job) return null;

  const row = await db.jobAftercareInstruction.findFirst({
    where: {
      jobId: job.id,
      businessId: job.businessId,
      status: "PUBLISHED",
    },
    select: {
      jobId: true,
      businessId: true,
      publishedInstructions: true,
      publishedAt: true,
      status: true,
    },
  });
  const instructions = row?.publishedInstructions?.trim() || "";
  if (!row || row.status !== "PUBLISHED" || !instructions) {
    return null;
  }
  return {
    jobId: job.id,
    businessId: job.businessId,
    instructions,
    publishedAt: row.publishedAt,
  };
}

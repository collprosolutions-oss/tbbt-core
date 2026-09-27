/**
 * OWNER-explicit CustomerFollowUp write from a retention finding.
 *
 * Uses the existing CustomerFollowUp row. Does not send SMS or email,
 * emit a due event, infer customer intent, or write foreign-tenant rows.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { requireRetentionFollowUpWrite } from "@/lib/growth/retention/access";
import {
  RETENTION_FOLLOW_UP_FINDING_GROUPS,
  RETENTION_FOLLOW_UP_FOREIGN_CUSTOMER_MESSAGE,
  RETENTION_FOLLOW_UP_FOREIGN_JOB_MESSAGE,
  RETENTION_FOLLOW_UP_JOB_CUSTOMER_MISMATCH_MESSAGE,
  RETENTION_FOLLOW_UP_JOB_NOT_COMPLETED_MESSAGE,
  RETENTION_FOLLOW_UP_STALE_FINDING_MESSAGE,
  RETENTION_FOLLOW_UP_UNKNOWN_FINDING_MESSAGE,
  type RetentionFollowUpFindingGroup,
} from "@/lib/growth/retention/constants";
import {
  findLastCompletedJobForCustomer,
  hasLaterSameBusinessJob,
  hasSameBusinessReferralRequestForJob,
  hasSameBusinessReviewRequestForJob,
} from "@/lib/growth/retention/queries";

type RetentionDb = PrismaClient | Prisma.TransactionClient;

export class RetentionFollowUpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetentionFollowUpError";
  }
}

export function retentionFollowUpErrorMessage(error: unknown, fallback: string) {
  if (error instanceof RetentionFollowUpError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  return fallback;
}

export function isRetentionFollowUpFindingGroup(
  value: string,
): value is RetentionFollowUpFindingGroup {
  return (RETENTION_FOLLOW_UP_FINDING_GROUPS as readonly string[]).includes(value);
}

export type RecordRetentionFollowUpTaskInput = {
  customerId: string;
  jobId: string;
  group: string;
};

export type RecordedRetentionFollowUp = {
  id: string;
  businessId: string;
  customerId: string;
  jobId: string | null;
  kind: string;
  status: string;
};

export type RecordRetentionFollowUpTaskResult = {
  outcome: "CREATED" | "UPDATED";
  followUp: RecordedRetentionFollowUp;
};

function retentionFollowUpKind(group: RetentionFollowUpFindingGroup): "JOB_COMPLETE" | "REPEAT" {
  return group === "NO_LATER_JOB" ? "REPEAT" : "JOB_COMPLETE";
}

async function assertFindingStillRecorded(
  db: RetentionDb,
  businessId: string,
  group: RetentionFollowUpFindingGroup,
  customerId: string,
  job: { id: string; createdAt: Date },
) {
  if (group === "NO_REVIEW_REQUEST") {
    if (await hasSameBusinessReviewRequestForJob(db, businessId, job.id)) {
      throw new RetentionFollowUpError(RETENTION_FOLLOW_UP_STALE_FINDING_MESSAGE);
    }
    return;
  }
  if (group === "NO_REFERRAL_REQUEST") {
    if (await hasSameBusinessReferralRequestForJob(db, businessId, job.id)) {
      throw new RetentionFollowUpError(RETENTION_FOLLOW_UP_STALE_FINDING_MESSAGE);
    }
    return;
  }
  const lastCompleted = await findLastCompletedJobForCustomer(db, businessId, customerId);
  if (!lastCompleted || lastCompleted.id !== job.id) {
    throw new RetentionFollowUpError(RETENTION_FOLLOW_UP_STALE_FINDING_MESSAGE);
  }
  const later = await hasLaterSameBusinessJob(
    db,
    businessId,
    customerId,
    lastCompleted.createdAt,
    lastCompleted.id,
  );
  if (later) {
    throw new RetentionFollowUpError(RETENTION_FOLLOW_UP_STALE_FINDING_MESSAGE);
  }
}

export async function recordRetentionFollowUpTask(
  db: RetentionDb,
  access: BusinessAccess,
  input: RecordRetentionFollowUpTaskInput,
): Promise<RecordRetentionFollowUpTaskResult> {
  requireRetentionFollowUpWrite(access);
  requireBusinessCapability(access, CAPABILITIES.MANAGE_REVIEWS);

  if (!isRetentionFollowUpFindingGroup(input.group)) {
    throw new RetentionFollowUpError(RETENTION_FOLLOW_UP_UNKNOWN_FINDING_MESSAGE);
  }

  const customerId = input.customerId.trim();
  const jobId = input.jobId.trim();
  if (!customerId || !jobId) {
    throw new RetentionFollowUpError(RETENTION_FOLLOW_UP_UNKNOWN_FINDING_MESSAGE);
  }

  const customer = await db.customer.findFirst({
    where: { id: customerId, businessId: access.businessId },
    select: { id: true, businessId: true },
  });
  if (!customer) {
    throw new RetentionFollowUpError(RETENTION_FOLLOW_UP_FOREIGN_CUSTOMER_MESSAGE);
  }
  access.assertOwned(customer);

  const job = await db.job.findFirst({
    where: { id: jobId, businessId: access.businessId },
    select: { id: true, businessId: true, customerId: true, status: true, createdAt: true },
  });
  if (!job) {
    throw new RetentionFollowUpError(RETENTION_FOLLOW_UP_FOREIGN_JOB_MESSAGE);
  }
  access.assertOwned(job);
  if (job.customerId !== customer.id) {
    throw new RetentionFollowUpError(RETENTION_FOLLOW_UP_JOB_CUSTOMER_MISMATCH_MESSAGE);
  }
  if (job.status !== "COMPLETED") {
    throw new RetentionFollowUpError(RETENTION_FOLLOW_UP_JOB_NOT_COMPLETED_MESSAGE);
  }

  await assertFindingStillRecorded(db, access.businessId, input.group, customer.id, job);

  const kind = retentionFollowUpKind(input.group);
  const existing = await db.customerFollowUp.findFirst({
    where: {
      businessId: access.businessId,
      customerId: customer.id,
      jobId: job.id,
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      businessId: true,
      customerId: true,
      jobId: true,
      kind: true,
      status: true,
    },
  });

  if (existing) {
    const nextStatus = existing.status === "FAILED" ? "OPEN" : existing.status;
    const updated = await db.customerFollowUp.update({
      where: { id: existing.id },
      data: {
        kind: existing.kind,
        status: nextStatus,
      },
      select: {
        id: true,
        businessId: true,
        customerId: true,
        jobId: true,
        kind: true,
        status: true,
      },
    });
    return { outcome: "UPDATED", followUp: updated };
  }

  const created = await db.customerFollowUp.create({
    data: {
      businessId: access.businessId,
      customerId: customer.id,
      jobId: job.id,
      kind,
      status: "OPEN",
      createdByMembershipId: access.workspace.membership.id,
    },
    select: {
      id: true,
      businessId: true,
      customerId: true,
      jobId: true,
      kind: true,
      status: true,
    },
  });
  return { outcome: "CREATED", followUp: created };
}

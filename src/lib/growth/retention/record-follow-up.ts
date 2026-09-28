/**
 * OWNER-explicit CustomerFollowUp write from a retention finding.
 *
 * Uses the existing CustomerFollowUp row with origin RETENTION_TASK.
 * Does not send SMS or email, emit a due event, infer customer intent,
 * write foreign-tenant rows, or mutate communication follow-ups.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import {
  CUSTOMER_FOLLOW_UP_ORIGINS,
  retentionFollowUpLockKey,
} from "@/lib/customer-follow-up-origin";
import { requireRetentionFollowUpWrite } from "@/lib/growth/retention/access";
import {
  RETENTION_FOLLOW_UP_FINDING_GROUPS,
  RETENTION_FOLLOW_UP_FOREIGN_CUSTOMER_MESSAGE,
  RETENTION_FOLLOW_UP_FOREIGN_JOB_MESSAGE,
  RETENTION_FOLLOW_UP_INVALID_DUE_DATE_MESSAGE,
  RETENTION_FOLLOW_UP_JOB_CUSTOMER_MISMATCH_MESSAGE,
  RETENTION_FOLLOW_UP_JOB_NOT_COMPLETED_MESSAGE,
  RETENTION_FOLLOW_UP_STALE_FINDING_MESSAGE,
  RETENTION_FOLLOW_UP_UNKNOWN_FINDING_MESSAGE,
  type RetentionFollowUpFindingGroup,
} from "@/lib/growth/retention/constants";
import { parseRetentionFollowUpDueOn } from "@/lib/growth/retention/due";
import {
  findLastCompletedJobForCustomer,
  hasLaterSameBusinessJob,
  hasSameBusinessReferralRequestForJob,
  hasSameBusinessReviewRequestForJob,
} from "@/lib/growth/retention/queries";

type RetentionDb = PrismaClient | Prisma.TransactionClient;

const followUpSelect = {
  id: true,
  businessId: true,
  customerId: true,
  jobId: true,
  kind: true,
  status: true,
  origin: true,
  dueOn: true,
} as const;

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
  dueOn?: string | null;
};

export type RecordedRetentionFollowUp = {
  id: string;
  businessId: string;
  customerId: string;
  jobId: string | null;
  kind: string;
  status: string;
  origin: string;
  dueOn: Date | null;
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

async function findOwnedRetentionTask(
  db: RetentionDb,
  input: { businessId: string; customerId: string; jobId: string },
) {
  return db.customerFollowUp.findFirst({
    where: {
      businessId: input.businessId,
      customerId: input.customerId,
      jobId: input.jobId,
      origin: CUSTOMER_FOLLOW_UP_ORIGINS.RETENTION_TASK,
    },
    orderBy: { createdAt: "asc" },
    select: followUpSelect,
  });
}

async function writeRetentionFollowUpTask(
  db: RetentionDb,
  access: BusinessAccess,
  input: {
    customerId: string;
    jobId: string;
    kind: "JOB_COMPLETE" | "REPEAT";
    dueOn?: Date | null;
  },
): Promise<RecordRetentionFollowUpTaskResult> {
  const existing = await findOwnedRetentionTask(db, {
    businessId: access.businessId,
    customerId: input.customerId,
    jobId: input.jobId,
  });
  if (existing) {
    const updated = await db.customerFollowUp.update({
      where: { id: existing.id },
      data: {
        kind: existing.kind,
        ...(input.dueOn !== undefined ? { dueOn: input.dueOn } : {}),
      },
      select: followUpSelect,
    });
    return { outcome: "UPDATED", followUp: updated };
  }

  try {
    const created = await db.customerFollowUp.create({
      data: {
        businessId: access.businessId,
        customerId: input.customerId,
        jobId: input.jobId,
        kind: input.kind,
        status: "OPEN",
        origin: CUSTOMER_FOLLOW_UP_ORIGINS.RETENTION_TASK,
        dueOn: input.dueOn ?? null,
        createdByMembershipId: access.workspace.membership.id,
      },
      select: followUpSelect,
    });
    return { outcome: "CREATED", followUp: created };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await findOwnedRetentionTask(db, {
        businessId: access.businessId,
        customerId: input.customerId,
        jobId: input.jobId,
      });
      if (raced) return { outcome: "UPDATED", followUp: raced };
    }
    throw error;
  }
}

async function withRetentionWriteLock<T>(
  db: RetentionDb,
  lockKey: string,
  work: (tx: RetentionDb) => Promise<T>,
): Promise<T> {
  if ("$transaction" in db && typeof db.$transaction === "function") {
    return db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      return work(tx);
    });
  }
  return work(db);
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

  const business = await db.business.findFirst({
    where: { id: access.businessId },
    select: { timezone: true },
  });
  const timeZone = resolveBusinessTimeZone(business);
  const hasDueOnInput = input.dueOn !== undefined;
  const parsedDueOn = hasDueOnInput ? parseRetentionFollowUpDueOn(input.dueOn, timeZone) : null;
  if (hasDueOnInput && parsedDueOn && !parsedDueOn.ok) {
    throw new RetentionFollowUpError(RETENTION_FOLLOW_UP_INVALID_DUE_DATE_MESSAGE);
  }
  const dueOn = hasDueOnInput && parsedDueOn?.ok ? parsedDueOn.dueOn : undefined;

  const kind = retentionFollowUpKind(input.group);
  return withRetentionWriteLock(
    db,
    retentionFollowUpLockKey({
      businessId: access.businessId,
      customerId: customer.id,
      jobId: job.id,
    }),
    (tx) =>
      writeRetentionFollowUpTask(tx, access, {
        customerId: customer.id,
        jobId: job.id,
        kind,
        dueOn,
      }),
  );
}

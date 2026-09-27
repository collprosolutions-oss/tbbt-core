/**
 * OWNER-explicit status write for a recorded RETENTION_TASK follow-up.
 *
 * Done is a recorded work status. It is never SENT, never a send, and
 * never emits CUSTOMER_FOLLOW_UP_DUE. A DONE row cannot retain
 * cancelledAt. COMMUNICATION follow-ups and automation send paths are
 * not used.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  isRetentionFollowUpTask,
  retentionFollowUpStatusLockKey,
} from "@/lib/customer-follow-up-origin";
import { requireRetentionFollowUpWrite } from "@/lib/growth/retention/access";
import {
  RETENTION_FOLLOW_UP_NOT_RESOLVABLE_MESSAGE,
  RETENTION_FOLLOW_UP_NOT_TASK_MESSAGE,
  RETENTION_FOLLOW_UP_RESOLVE_STATUSES,
  RETENTION_FOLLOW_UP_SENT_NOT_DONE_MESSAGE,
  RETENTION_FOLLOW_UP_UNKNOWN_STATUS_MESSAGE,
  RETENTION_FOLLOW_UP_UNKNOWN_TASK_MESSAGE,
  type RetentionFollowUpResolveStatus,
} from "@/lib/growth/retention/constants";
import {
  RetentionFollowUpError,
  type RecordedRetentionFollowUp,
} from "@/lib/growth/retention/record-follow-up";

type RetentionDb = PrismaClient | Prisma.TransactionClient;

const followUpSelect = {
  id: true,
  businessId: true,
  customerId: true,
  jobId: true,
  kind: true,
  status: true,
  origin: true,
  cancelledAt: true,
} as const;

const RESOLVABLE_FROM_STATUSES = ["OPEN", "DONE", "CANCELLED"] as const;

export type ResolveRetentionFollowUpTaskStatusInput = {
  followUpId: string;
  status: string;
};

export type ResolveRetentionFollowUpTaskStatusResult = {
  outcome: "UPDATED" | "UNCHANGED";
  followUp: RecordedRetentionFollowUp;
};

export function isRetentionFollowUpResolveStatus(
  value: string,
): value is RetentionFollowUpResolveStatus {
  return (RETENTION_FOLLOW_UP_RESOLVE_STATUSES as readonly string[]).includes(value);
}

function isResolvableFromStatus(status: string) {
  return (RESOLVABLE_FROM_STATUSES as readonly string[]).includes(status);
}

async function withRetentionStatusLock<T>(
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

async function findOwnedFollowUp(
  db: RetentionDb,
  input: { businessId: string; followUpId: string },
) {
  return db.customerFollowUp.findFirst({
    where: { id: input.followUpId, businessId: input.businessId },
    select: followUpSelect,
  });
}

function assertRetentionTaskResolvable(row: { origin: string; status: string }) {
  if (!isRetentionFollowUpTask(row.origin)) {
    throw new RetentionFollowUpError(RETENTION_FOLLOW_UP_NOT_TASK_MESSAGE);
  }
  if (row.status === "SENT") {
    throw new RetentionFollowUpError(RETENTION_FOLLOW_UP_SENT_NOT_DONE_MESSAGE);
  }
  if (!isResolvableFromStatus(row.status)) {
    throw new RetentionFollowUpError(RETENTION_FOLLOW_UP_NOT_RESOLVABLE_MESSAGE);
  }
}

function recordedFollowUp(row: {
  id: string;
  businessId: string;
  customerId: string;
  jobId: string | null;
  kind: string;
  status: string;
  origin: string;
}): RecordedRetentionFollowUp {
  return {
    id: row.id,
    businessId: row.businessId,
    customerId: row.customerId,
    jobId: row.jobId,
    kind: row.kind,
    status: row.status,
    origin: row.origin,
  };
}

function statusWriteData(status: RetentionFollowUpResolveStatus, cancelledAt: Date | null) {
  if (status === "CANCELLED") {
    return {
      status: "CANCELLED" as const,
      cancelledAt: cancelledAt ?? new Date(),
    };
  }
  return { status: "DONE" as const, cancelledAt: null };
}

export async function resolveRetentionFollowUpTaskStatus(
  db: RetentionDb,
  access: BusinessAccess,
  input: ResolveRetentionFollowUpTaskStatusInput,
): Promise<ResolveRetentionFollowUpTaskStatusResult> {
  requireRetentionFollowUpWrite(access);
  requireBusinessCapability(access, CAPABILITIES.MANAGE_REVIEWS);

  const status = input.status;
  if (!isRetentionFollowUpResolveStatus(status)) {
    throw new RetentionFollowUpError(RETENTION_FOLLOW_UP_UNKNOWN_STATUS_MESSAGE);
  }

  const followUpId = input.followUpId.trim();
  if (!followUpId) {
    throw new RetentionFollowUpError(RETENTION_FOLLOW_UP_UNKNOWN_TASK_MESSAGE);
  }

  const existing = await findOwnedFollowUp(db, {
    businessId: access.businessId,
    followUpId,
  });
  if (!existing) {
    throw new RetentionFollowUpError(RETENTION_FOLLOW_UP_UNKNOWN_TASK_MESSAGE);
  }
  access.assertOwned(existing);
  assertRetentionTaskResolvable(existing);

  return withRetentionStatusLock(db, retentionFollowUpStatusLockKey(existing.id), async (tx) => {
    const current = await findOwnedFollowUp(tx, {
      businessId: access.businessId,
      followUpId: existing.id,
    });
    if (!current) {
      throw new RetentionFollowUpError(RETENTION_FOLLOW_UP_UNKNOWN_TASK_MESSAGE);
    }
    access.assertOwned(current);
    assertRetentionTaskResolvable(current);
    if (current.status === status) {
      return { outcome: "UNCHANGED", followUp: recordedFollowUp(current) };
    }

    const updated = await tx.customerFollowUp.update({
      where: { id: current.id },
      data: statusWriteData(status, current.cancelledAt),
      select: followUpSelect,
    });
    return { outcome: "UPDATED", followUp: recordedFollowUp(updated) };
  });
}

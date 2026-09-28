/**
 * OWNER-explicit due-date write for a recorded RETENTION_TASK follow-up.
 *
 * Sets or clears dueOn only. Status, SENT, cancelledAt, and communication
 * fields stay unchanged. This path never emits CUSTOMER_FOLLOW_UP_DUE.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import {
  isRetentionFollowUpTask,
  retentionFollowUpStatusLockKey,
} from "@/lib/customer-follow-up-origin";
import { requireRetentionFollowUpWrite } from "@/lib/growth/retention/access";
import {
  RETENTION_FOLLOW_UP_DUE_EDITABLE_STATUSES,
  RETENTION_FOLLOW_UP_DUE_NOT_EDITABLE_MESSAGE,
  RETENTION_FOLLOW_UP_INVALID_DUE_DATE_MESSAGE,
  RETENTION_FOLLOW_UP_NOT_TASK_MESSAGE,
  RETENTION_FOLLOW_UP_SENT_NOT_DONE_MESSAGE,
  RETENTION_FOLLOW_UP_UNKNOWN_TASK_MESSAGE,
} from "@/lib/growth/retention/constants";
import { dueOnInstantsEqual, parseRetentionFollowUpDueOn } from "@/lib/growth/retention/due";
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
  dueOn: true,
  cancelledAt: true,
} as const;

export type UpdateRetentionFollowUpDueOnInput = {
  followUpId: string;
  dueOn?: string | null;
};

export type UpdateRetentionFollowUpDueOnResult = {
  outcome: "UPDATED" | "UNCHANGED";
  followUp: RecordedRetentionFollowUp;
};

function isDueEditableStatus(status: string) {
  return (RETENTION_FOLLOW_UP_DUE_EDITABLE_STATUSES as readonly string[]).includes(status);
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

function assertRetentionTaskDueEditable(row: { origin: string; status: string }) {
  if (!isRetentionFollowUpTask(row.origin)) {
    throw new RetentionFollowUpError(RETENTION_FOLLOW_UP_NOT_TASK_MESSAGE);
  }
  if (row.status === "SENT") {
    throw new RetentionFollowUpError(RETENTION_FOLLOW_UP_SENT_NOT_DONE_MESSAGE);
  }
  if (!isDueEditableStatus(row.status)) {
    throw new RetentionFollowUpError(RETENTION_FOLLOW_UP_DUE_NOT_EDITABLE_MESSAGE);
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
  dueOn: Date | null;
}): RecordedRetentionFollowUp {
  return {
    id: row.id,
    businessId: row.businessId,
    customerId: row.customerId,
    jobId: row.jobId,
    kind: row.kind,
    status: row.status,
    origin: row.origin,
    dueOn: row.dueOn,
  };
}

async function loadBusinessTimeZone(db: RetentionDb, businessId: string) {
  const business = await db.business.findFirst({
    where: { id: businessId },
    select: { timezone: true },
  });
  return resolveBusinessTimeZone(business);
}

export async function updateRetentionFollowUpDueOn(
  db: RetentionDb,
  access: BusinessAccess,
  input: UpdateRetentionFollowUpDueOnInput,
): Promise<UpdateRetentionFollowUpDueOnResult> {
  requireRetentionFollowUpWrite(access);
  requireBusinessCapability(access, CAPABILITIES.MANAGE_REVIEWS);

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
  assertRetentionTaskDueEditable(existing);

  const timeZone = await loadBusinessTimeZone(db, access.businessId);
  const parsedDueOn = parseRetentionFollowUpDueOn(input.dueOn, timeZone);
  if (!parsedDueOn.ok) {
    throw new RetentionFollowUpError(RETENTION_FOLLOW_UP_INVALID_DUE_DATE_MESSAGE);
  }
  const dueOn = parsedDueOn.dueOn;

  return withRetentionStatusLock(db, retentionFollowUpStatusLockKey(existing.id), async (tx) => {
    const current = await findOwnedFollowUp(tx, {
      businessId: access.businessId,
      followUpId: existing.id,
    });
    if (!current) {
      throw new RetentionFollowUpError(RETENTION_FOLLOW_UP_UNKNOWN_TASK_MESSAGE);
    }
    access.assertOwned(current);
    assertRetentionTaskDueEditable(current);
    if (dueOnInstantsEqual(current.dueOn, dueOn)) {
      return { outcome: "UNCHANGED", followUp: recordedFollowUp(current) };
    }

    const updated = await tx.customerFollowUp.update({
      where: { id: current.id },
      data: { dueOn },
      select: followUpSelect,
    });
    return { outcome: "UPDATED", followUp: recordedFollowUp(updated) };
  });
}

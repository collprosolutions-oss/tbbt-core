/**
 * OWNER mutations for Handyman maintenance follow-ups.
 *
 * Create and cancel only. Never books a Job, never writes Cleaning
 * recurrence, never emits CUSTOMER_FOLLOW_UP_DUE, and never sends
 * SMS or email. Compose marks SENT after an explicit owner review.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { ForbiddenError, requireBusinessRole } from "@/lib/authorization";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import { CUSTOMER_FOLLOW_UP_ORIGINS } from "@/lib/customer-follow-up-origin";
import { isAcceptedCustomerMessageStatus } from "@/lib/customer-messaging/types";
import {
  HANDYMAN_MAINTENANCE_ALREADY_SENT_MESSAGE,
  HANDYMAN_MAINTENANCE_CANCELLED_MESSAGE,
  HANDYMAN_MAINTENANCE_HAS_MESSAGE_MESSAGE,
  HANDYMAN_MAINTENANCE_COMPLETED_JOB_MESSAGE,
  HANDYMAN_MAINTENANCE_CUSTOMER_REQUIRED_MESSAGE,
  HANDYMAN_MAINTENANCE_DUE_REQUIRED_MESSAGE,
  HANDYMAN_MAINTENANCE_HANDYMAN_ONLY_MESSAGE,
  HANDYMAN_MAINTENANCE_INVALID_DUE_DATE_MESSAGE,
  HANDYMAN_MAINTENANCE_FOLLOW_UP_KIND,
  HANDYMAN_MAINTENANCE_FOLLOW_UP_ORIGIN,
  HANDYMAN_MAINTENANCE_JOB_REQUIRED_MESSAGE,
  HANDYMAN_MAINTENANCE_NOT_OPEN_MESSAGE,
  HANDYMAN_MAINTENANCE_NOT_SENDABLE_MESSAGE,
  HANDYMAN_MAINTENANCE_OPEN_EXISTS_MESSAGE,
  HANDYMAN_MAINTENANCE_OWNER_ONLY_MESSAGE,
  HANDYMAN_MAINTENANCE_OWNER_SEND_MESSAGE,
  HANDYMAN_MAINTENANCE_PAST_DUE_DATE_MESSAGE,
  HANDYMAN_MAINTENANCE_TASK_REQUIRED_MESSAGE,
  HANDYMAN_MAINTENANCE_UNKNOWN_MESSAGE,
  HandymanMaintenanceFollowUpError,
  handymanMaintenanceJobEligible,
  handymanMaintenanceWriteAllowed,
  maintenanceFollowUpLockKey,
  maintenanceFollowUpStatusLockKey,
  parseHandymanMaintenanceDueOn,
  parseHandymanMaintenanceTask,
} from "@/lib/handyman-maintenance-follow-up";

type Db = PrismaClient | Prisma.TransactionClient;

const followUpSelect = {
  id: true,
  businessId: true,
  customerId: true,
  jobId: true,
  kind: true,
  status: true,
  origin: true,
  dueOn: true,
  notes: true,
  cancelledAt: true,
  sentAt: true,
} as const;

export type RecordedMaintenanceFollowUp = Prisma.CustomerFollowUpGetPayload<{
  select: typeof followUpSelect;
}>;

function requireOwnerMaintenanceWrite(access: BusinessAccess) {
  if (!handymanMaintenanceWriteAllowed(access.workspace.role)) {
    throw new ForbiddenError(HANDYMAN_MAINTENANCE_OWNER_ONLY_MESSAGE);
  }
  requireBusinessRole(access, "OWNER");
}

async function withMaintenanceWriteLock<T>(
  db: Db,
  lockKey: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if ("$transaction" in db && typeof db.$transaction === "function") {
    return db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      return work(tx);
    });
  }
  throw new HandymanMaintenanceFollowUpError(HANDYMAN_MAINTENANCE_UNKNOWN_MESSAGE);
}

export const MAINTENANCE_COMPOSE_CLAIM_STATUS = "READY";
export const MAINTENANCE_COMPOSE_CLAIM_LEASE_MS = 2 * 60 * 1000;

export async function withMaintenanceFollowUpStatusLock<T>(
  db: Db,
  followUpId: string,
  work: (tx: Db) => Promise<T>,
): Promise<T> {
  const lockKey = maintenanceFollowUpStatusLockKey(followUpId);
  const run = async (tx: Db) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
    return work(tx);
  };
  if ("$transaction" in db && typeof db.$transaction === "function") {
    return db.$transaction((tx) => run(tx), {
      timeout: 8_000,
      maxWait: 8_000,
    });
  }
  return run(db);
}

export function maintenanceFollowUpCommunicationInLease(
  row: { status: string; attemptedAt: Date | null } | null | undefined,
  now = new Date(),
) {
  if (!row || row.status !== MAINTENANCE_COMPOSE_CLAIM_STATUS || !row.attemptedAt) {
    return false;
  }
  return now.getTime() - row.attemptedAt.getTime() < MAINTENANCE_COMPOSE_CLAIM_LEASE_MS;
}

export function maintenanceFollowUpCommunicationBlocksSend(
  row: { status: string; attemptedAt: Date | null } | null | undefined,
  now = new Date(),
) {
  if (!row) return false;
  return isAcceptedCustomerMessageStatus(row.status) || maintenanceFollowUpCommunicationInLease(row, now);
}

async function listMaintenanceFollowUpCommunications(
  db: Db,
  input: { businessId: string; followUpId: string },
) {
  return db.customerCommunication.findMany({
    where: {
      businessId: input.businessId,
      relatedType: "CUSTOMER_FOLLOW_UP",
      relatedId: input.followUpId,
    },
    select: {
      id: true,
      idempotencyKey: true,
      status: true,
      attemptedAt: true,
      channel: true,
      threadId: true,
      provider: true,
      failureReason: true,
    },
  });
}

async function loadOwnedJobForMaintenance(
  db: Db,
  access: BusinessAccess,
  jobId: string,
) {
  const trimmed = jobId.trim();
  if (!trimmed) {
    throw new HandymanMaintenanceFollowUpError(HANDYMAN_MAINTENANCE_JOB_REQUIRED_MESSAGE);
  }
  const job = await db.job.findFirst({
    where: { id: trimmed, businessId: access.businessId },
    select: {
      id: true,
      businessId: true,
      customerId: true,
      status: true,
      estimate: {
        select: {
          serviceRequest: { select: { tradeCode: true } },
          lineItems: {
            select: { serviceCatalogItem: { select: { tradeCode: true } } },
          },
        },
      },
    },
  });
  if (!job) {
    throw new HandymanMaintenanceFollowUpError(HANDYMAN_MAINTENANCE_JOB_REQUIRED_MESSAGE);
  }
  access.assertOwned(job);
  const eligible = handymanMaintenanceJobEligible({
    job,
    businessId: access.businessId,
    requestTradeCode: job.estimate?.serviceRequest?.tradeCode,
    catalogTradeCodes: (job.estimate?.lineItems ?? []).map(
      (line) => line.serviceCatalogItem?.tradeCode,
    ),
  });
  if (!eligible.ok && eligible.reason === "not_completed") {
    throw new HandymanMaintenanceFollowUpError(HANDYMAN_MAINTENANCE_COMPLETED_JOB_MESSAGE);
  }
  if (!eligible.ok) {
    throw new HandymanMaintenanceFollowUpError(HANDYMAN_MAINTENANCE_HANDYMAN_ONLY_MESSAGE);
  }
  if (!job.customerId) {
    throw new HandymanMaintenanceFollowUpError(
      HANDYMAN_MAINTENANCE_CUSTOMER_REQUIRED_MESSAGE,
    );
  }
  return { ...job, customerId: job.customerId };
}

export async function createHandymanMaintenanceFollowUp(
  db: PrismaClient,
  access: BusinessAccess,
  input: { jobId: string; task?: string | null; dueOn?: string | null },
): Promise<RecordedMaintenanceFollowUp> {
  requireOwnerMaintenanceWrite(access);
  const job = await loadOwnedJobForMaintenance(db, access, input.jobId);
  const customer = await db.customer.findFirst({
    where: { id: job.customerId, businessId: access.businessId },
    select: { id: true, businessId: true },
  });
  if (!customer) {
    throw new HandymanMaintenanceFollowUpError(
      HANDYMAN_MAINTENANCE_CUSTOMER_REQUIRED_MESSAGE,
    );
  }
  access.assertOwned(customer);

  const task = parseHandymanMaintenanceTask(input.task);
  if (!task) {
    throw new HandymanMaintenanceFollowUpError(HANDYMAN_MAINTENANCE_TASK_REQUIRED_MESSAGE);
  }

  const business = await db.business.findFirst({
    where: { id: access.businessId },
    select: { timezone: true },
  });
  const timeZone = resolveBusinessTimeZone(business);
  const parsedDue = parseHandymanMaintenanceDueOn(input.dueOn, timeZone);
  if (!parsedDue.ok && parsedDue.reason === "past") {
    throw new HandymanMaintenanceFollowUpError(HANDYMAN_MAINTENANCE_PAST_DUE_DATE_MESSAGE);
  }
  if (!parsedDue.ok) {
    throw new HandymanMaintenanceFollowUpError(
      input.dueOn?.trim()
        ? HANDYMAN_MAINTENANCE_INVALID_DUE_DATE_MESSAGE
        : HANDYMAN_MAINTENANCE_DUE_REQUIRED_MESSAGE,
    );
  }

  return withMaintenanceWriteLock(
    db,
    maintenanceFollowUpLockKey({ businessId: access.businessId, jobId: job.id }),
    async (tx) => {
      const existing = await tx.customerFollowUp.findFirst({
        where: {
          businessId: access.businessId,
          jobId: job.id,
          origin: HANDYMAN_MAINTENANCE_FOLLOW_UP_ORIGIN,
          status: "OPEN",
        },
        select: followUpSelect,
      });
      if (existing) {
        throw new HandymanMaintenanceFollowUpError(HANDYMAN_MAINTENANCE_OPEN_EXISTS_MESSAGE);
      }
      return tx.customerFollowUp.create({
        data: {
          businessId: access.businessId,
          customerId: customer.id,
          jobId: job.id,
          kind: HANDYMAN_MAINTENANCE_FOLLOW_UP_KIND,
          status: "OPEN",
          origin: HANDYMAN_MAINTENANCE_FOLLOW_UP_ORIGIN,
          dueOn: parsedDue.dueOn,
          notes: task,
          createdByMembershipId: access.workspace.membership.id,
        },
        select: followUpSelect,
      });
    },
  );
}

export async function cancelHandymanMaintenanceFollowUp(
  db: PrismaClient,
  access: BusinessAccess,
  input: { followUpId: string },
): Promise<RecordedMaintenanceFollowUp> {
  requireOwnerMaintenanceWrite(access);
  const followUpId = input.followUpId.trim();
  if (!followUpId) {
    throw new HandymanMaintenanceFollowUpError(HANDYMAN_MAINTENANCE_UNKNOWN_MESSAGE);
  }

  return withMaintenanceWriteLock(
    db,
    maintenanceFollowUpStatusLockKey(followUpId),
    async (tx) => {
      const row = await tx.customerFollowUp.findFirst({
        where: { id: followUpId, businessId: access.businessId },
        select: followUpSelect,
      });
      if (!row) {
        throw new HandymanMaintenanceFollowUpError(HANDYMAN_MAINTENANCE_UNKNOWN_MESSAGE);
      }
      access.assertOwned(row);
      if (row.origin !== HANDYMAN_MAINTENANCE_FOLLOW_UP_ORIGIN) {
        throw new HandymanMaintenanceFollowUpError(HANDYMAN_MAINTENANCE_UNKNOWN_MESSAGE);
      }
      if (row.status === "CANCELLED") return row;
      if (row.status !== "OPEN") {
        throw new HandymanMaintenanceFollowUpError(HANDYMAN_MAINTENANCE_NOT_OPEN_MESSAGE);
      }
      const comms = await listMaintenanceFollowUpCommunications(tx, {
        businessId: access.businessId,
        followUpId: row.id,
      });
      if (comms.some((comm) => maintenanceFollowUpCommunicationBlocksSend(comm))) {
        throw new HandymanMaintenanceFollowUpError(HANDYMAN_MAINTENANCE_HAS_MESSAGE_MESSAGE);
      }
      return tx.customerFollowUp.update({
        where: { id: row.id },
        data: { status: "CANCELLED", cancelledAt: new Date() },
        select: followUpSelect,
      });
    },
  );
}

export async function assertMaintenanceFollowUpComposeAllowed(
  db: Db,
  access: { businessId: string; workspace: { role: string } },
  input: { followUpId: string; customerId: string; idempotencyKey?: string | null },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const followUpId = input.followUpId.trim();
  if (!followUpId) return { ok: true };

  const row = await db.customerFollowUp.findFirst({
    where: { id: followUpId, businessId: access.businessId },
    select: {
      id: true,
      businessId: true,
      customerId: true,
      origin: true,
      status: true,
    },
  });
  if (!row) return { ok: true };
  if (row.origin !== CUSTOMER_FOLLOW_UP_ORIGINS.MAINTENANCE) {
    return { ok: true };
  }
  if (row.customerId !== input.customerId) {
    return { ok: false, reason: HANDYMAN_MAINTENANCE_UNKNOWN_MESSAGE };
  }
  if (access.workspace.role !== "OWNER") {
    return { ok: false, reason: HANDYMAN_MAINTENANCE_OWNER_SEND_MESSAGE };
  }
  if (row.status === "CANCELLED") {
    return { ok: false, reason: HANDYMAN_MAINTENANCE_CANCELLED_MESSAGE };
  }
  const comms = await listMaintenanceFollowUpCommunications(db, {
    businessId: access.businessId,
    followUpId: row.id,
  });
  const key = input.idempotencyKey?.trim() ?? "";
  const blocking = comms.filter((comm) => maintenanceFollowUpCommunicationBlocksSend(comm));
  if (blocking.length > 0) {
    if (key && blocking.some((comm) => comm.idempotencyKey === key)) {
      return { ok: true };
    }
    return { ok: false, reason: HANDYMAN_MAINTENANCE_ALREADY_SENT_MESSAGE };
  }
  if (row.status === "SENT") {
    return { ok: false, reason: HANDYMAN_MAINTENANCE_ALREADY_SENT_MESSAGE };
  }
  if (row.status !== "OPEN" && row.status !== "FAILED") {
    return { ok: false, reason: HANDYMAN_MAINTENANCE_NOT_SENDABLE_MESSAGE };
  }
  return { ok: true };
}

export type MaintenanceComposeClaim =
  | { ok: false; reason: string }
  | {
      ok: true;
      communicationId: string;
      alreadyAccepted: boolean;
      status: string;
      provider: string;
      failureReason: string | null;
    };

export async function claimMaintenanceFollowUpCompose(
  db: PrismaClient,
  access: { businessId: string; workspace: { role: string; membership?: { id?: string | null } | null } },
  input: {
    followUpId: string;
    customerId: string;
    idempotencyKey: string;
    channel: "SMS" | "EMAIL";
    purpose: string;
    subject?: string | null;
    body: string;
  },
): Promise<MaintenanceComposeClaim> {
  return withMaintenanceFollowUpStatusLock(db, input.followUpId, async (tx) => {
    const gate = await assertMaintenanceFollowUpComposeAllowed(tx, access, {
      followUpId: input.followUpId,
      customerId: input.customerId,
      idempotencyKey: input.idempotencyKey,
    });
    if (!gate.ok) return { ok: false as const, reason: gate.reason };

    const comms = await listMaintenanceFollowUpCommunications(tx, {
      businessId: access.businessId,
      followUpId: input.followUpId,
    });
    const key = input.idempotencyKey.trim();
    const sameKey = comms.find((comm) => comm.idempotencyKey === key);
    if (sameKey && isAcceptedCustomerMessageStatus(sameKey.status)) {
      return {
        ok: true as const,
        communicationId: sameKey.id,
        alreadyAccepted: true,
        status: sameKey.status,
        provider: sameKey.provider,
        failureReason: sameKey.failureReason,
      };
    }
    if (sameKey && maintenanceFollowUpCommunicationInLease(sameKey)) {
      return {
        ok: true as const,
        communicationId: sameKey.id,
        alreadyAccepted: false,
        status: sameKey.status,
        provider: sameKey.provider,
        failureReason: sameKey.failureReason,
      };
    }

    const now = new Date();
    const data = {
      businessId: access.businessId,
      customerId: input.customerId,
      direction: "OUTBOUND",
      channel: input.channel,
      purpose: input.purpose,
      subject: input.subject ?? null,
      relatedType: "CUSTOMER_FOLLOW_UP",
      relatedId: input.followUpId,
      idempotencyKey: key,
      bodySnapshot: input.body,
      status: MAINTENANCE_COMPOSE_CLAIM_STATUS,
      provider: input.channel === "EMAIL" ? "resend" : "pending",
      initiatedByMembershipId: access.workspace.membership?.id ?? null,
      attemptedAt: now,
      failureReason: null,
    };
    try {
      const created = sameKey
        ? await tx.customerCommunication.update({
            where: { id: sameKey.id },
            data,
          })
        : await tx.customerCommunication.create({ data });
      return {
        ok: true as const,
        communicationId: created.id,
        alreadyAccepted: false,
        status: created.status,
        provider: created.provider,
        failureReason: created.failureReason,
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const raced = await tx.customerCommunication.findFirst({
          where: { businessId: access.businessId, idempotencyKey: key },
          select: {
            id: true,
            status: true,
            provider: true,
            failureReason: true,
            attemptedAt: true,
          },
        });
        if (raced) {
          return {
            ok: true as const,
            communicationId: raced.id,
            alreadyAccepted: isAcceptedCustomerMessageStatus(raced.status),
            status: raced.status,
            provider: raced.provider,
            failureReason: raced.failureReason,
          };
        }
      }
      throw error;
    }
  });
}

export async function markMaintenanceFollowUpSentAfterCompose(
  db: Db,
  access: { businessId: string },
  input: { followUpId: string },
) {
  const followUpId = input.followUpId.trim();
  if (!followUpId) return null;
  const row = await db.customerFollowUp.findFirst({
    where: { id: followUpId, businessId: access.businessId },
    select: {
      id: true,
      origin: true,
      status: true,
      sentAt: true,
    },
  });
  if (!row || row.origin !== CUSTOMER_FOLLOW_UP_ORIGINS.MAINTENANCE) {
    return null;
  }
  if (row.status === "SENT") return row;
  if (row.status !== "OPEN" && row.status !== "FAILED") return null;
  return db.customerFollowUp.update({
    where: { id: row.id },
    data: {
      status: "SENT",
      sentAt: row.sentAt ?? new Date(),
    },
    select: followUpSelect,
  });
}

export async function countBusinessJobs(db: Db, businessId: string) {
  return db.job.count({ where: { businessId } });
}

export async function countBusinessCommunications(db: Db, businessId: string) {
  return db.customerCommunication.count({ where: { businessId } });
}

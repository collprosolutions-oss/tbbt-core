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
import {
  HANDYMAN_MAINTENANCE_ALREADY_SENT_MESSAGE,
  HANDYMAN_MAINTENANCE_CANCELLED_MESSAGE,
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
  if (row.status === "SENT") {
    const key = input.idempotencyKey?.trim() ?? "";
    if (key) {
      const existing = await db.customerCommunication.findFirst({
        where: {
          businessId: access.businessId,
          customerId: input.customerId,
          relatedType: "CUSTOMER_FOLLOW_UP",
          relatedId: row.id,
          idempotencyKey: key,
        },
        select: { id: true },
      });
      if (existing) return { ok: true };
    }
    return { ok: false, reason: HANDYMAN_MAINTENANCE_ALREADY_SENT_MESSAGE };
  }
  if (row.status !== "OPEN" && row.status !== "FAILED") {
    return { ok: false, reason: HANDYMAN_MAINTENANCE_NOT_SENDABLE_MESSAGE };
  }
  return { ok: true };
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

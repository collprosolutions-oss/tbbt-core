/**
 * OWNER mutations for customer-reported callbacks on completed jobs.
 *
 * Record / review / outcome only. Never writes invoices, jobs, payments,
 * or customer messages. Coverage and legal determinations are refused.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { ForbiddenError, requireBusinessRole } from "@/lib/authorization";
import {
  JOB_CALLBACK_ALREADY_OPEN_MESSAGE,
  JOB_CALLBACK_COMPLETED_JOB_MESSAGE,
  JOB_CALLBACK_COVERAGE_REFUSED_MESSAGE,
  JOB_CALLBACK_DESCRIPTION_REQUIRED_MESSAGE,
  JOB_CALLBACK_JOB_REQUIRED_MESSAGE,
  JOB_CALLBACK_NOT_REVIEWABLE_MESSAGE,
  JOB_CALLBACK_OUTCOME_ALREADY_RECORDED_MESSAGE,
  JOB_CALLBACK_OUTCOME_REQUIRED_MESSAGE,
  JOB_CALLBACK_OWNER_ONLY_MESSAGE,
  JOB_CALLBACK_REPORTED_VIA_REQUIRED_MESSAGE,
  JOB_CALLBACK_REVIEW_FIRST_MESSAGE,
  JOB_CALLBACK_UNKNOWN_MESSAGE,
  completedSameBusinessJobEligible,
  isForbiddenCoverageOutcome,
  isJobCallbackOpenStatus,
  jobCallbackWriteAllowed,
  parseJobCallbackDescription,
  parseJobCallbackOutcome,
  parseJobCallbackOutcomeNotes,
  parseJobCallbackReportedVia,
  type JobCallbackOutcome,
  type JobCallbackReportedVia,
} from "@/lib/job-callback";
import { lockTenantOwnedJob } from "@/lib/time-card-ops";

type Db = PrismaClient | Prisma.TransactionClient;

export class JobCallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobCallbackError";
  }
}

export function jobCallbackErrorMessage(error: unknown, fallback: string) {
  if (error instanceof JobCallbackError) return error.message;
  if (error instanceof ForbiddenError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  return fallback;
}

function requireOwnerCallbackWrite(access: BusinessAccess) {
  if (!jobCallbackWriteAllowed(access.workspace.role)) {
    throw new ForbiddenError(JOB_CALLBACK_OWNER_ONLY_MESSAGE);
  }
  requireBusinessRole(access, "OWNER");
}

function actorMembershipId(access: BusinessAccess) {
  return access.workspace.membership.id;
}

function eventPayload(input: Record<string, unknown>) {
  return JSON.stringify(input);
}

async function findOpenCallback(db: Db, businessId: string, jobId: string) {
  return db.jobCallback.findFirst({
    where: {
      businessId,
      jobId,
      status: { in: ["RECORDED", "UNDER_REVIEW"] },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

async function loadOwnedCallback(
  db: Db,
  access: BusinessAccess,
  callbackId: string,
) {
  if (!callbackId) {
    throw new JobCallbackError(JOB_CALLBACK_UNKNOWN_MESSAGE);
  }
  return access.assertOwned(
    await db.jobCallback.findFirst({
      where: { id: callbackId, ...access.scope },
    }),
  );
}

export async function countBusinessInvoices(db: Db, businessId: string) {
  return db.invoice.count({ where: { businessId } });
}

export async function countBusinessJobs(db: Db, businessId: string) {
  return db.job.count({ where: { businessId } });
}

export async function countBusinessPayments(db: Db, businessId: string) {
  return db.payment.count({ where: { businessId } });
}

export async function countBusinessCommunications(db: Db, businessId: string) {
  return db.customerCommunication.count({ where: { businessId } });
}

export async function recordCustomerReportedCallback(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    jobId: string;
    description?: string | null;
    reportedVia?: string | null;
  },
) {
  requireOwnerCallbackWrite(access);
  const jobId = input.jobId.trim();
  if (!jobId) {
    throw new JobCallbackError(JOB_CALLBACK_JOB_REQUIRED_MESSAGE);
  }
  const description = parseJobCallbackDescription(input.description);
  if (!description) {
    throw new JobCallbackError(JOB_CALLBACK_DESCRIPTION_REQUIRED_MESSAGE);
  }
  const reportedVia = parseJobCallbackReportedVia(input.reportedVia);
  if (!reportedVia) {
    throw new JobCallbackError(JOB_CALLBACK_REPORTED_VIA_REQUIRED_MESSAGE);
  }

  try {
    return await db.$transaction(async (tx) => {
      const locked = await lockTenantOwnedJob(tx, access.businessId, jobId);
      if (!locked) {
        throw new JobCallbackError(JOB_CALLBACK_JOB_REQUIRED_MESSAGE);
      }
      access.assertOwned(locked);
      if (!completedSameBusinessJobEligible(locked, access.businessId)) {
        throw new JobCallbackError(JOB_CALLBACK_COMPLETED_JOB_MESSAGE);
      }

      const existing = await findOpenCallback(tx, access.businessId, locked.id);
      if (existing) {
        throw new JobCallbackError(JOB_CALLBACK_ALREADY_OPEN_MESSAGE);
      }

      const created = await tx.jobCallback.create({
        data: {
          businessId: access.businessId,
          jobId: locked.id,
          customerId: locked.customerId,
          description,
          reportedVia,
          status: "RECORDED",
          recordedByMembershipId: actorMembershipId(access),
        },
      });
      await tx.jobCallbackEvent.create({
        data: {
          businessId: access.businessId,
          callbackId: created.id,
          eventType: "RECORDED",
          fromStatus: null,
          toStatus: "RECORDED",
          actorMembershipId: actorMembershipId(access),
          payload: eventPayload({
            reportedVia,
            descriptionLength: description.length,
          }),
        },
      });
      return created;
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new JobCallbackError(JOB_CALLBACK_ALREADY_OPEN_MESSAGE);
    }
    throw error;
  }
}

export async function reviewCustomerReportedCallback(
  db: PrismaClient,
  access: BusinessAccess,
  input: { callbackId: string },
) {
  requireOwnerCallbackWrite(access);
  const callback = await loadOwnedCallback(db, access, input.callbackId.trim());

  if (callback.status === "OUTCOME_RECORDED") {
    throw new JobCallbackError(JOB_CALLBACK_NOT_REVIEWABLE_MESSAGE);
  }
  if (callback.status === "UNDER_REVIEW") {
    return { callback, unchanged: true as const };
  }
  if (callback.status !== "RECORDED") {
    throw new JobCallbackError(JOB_CALLBACK_NOT_REVIEWABLE_MESSAGE);
  }

  const updated = await db.$transaction(async (tx) => {
    const locked = await lockTenantOwnedJob(tx, access.businessId, callback.jobId);
    if (!locked || locked.businessId !== access.businessId) {
      throw new JobCallbackError(JOB_CALLBACK_JOB_REQUIRED_MESSAGE);
    }
    const current = access.assertOwned(
      await tx.jobCallback.findFirst({
        where: { id: callback.id, businessId: access.businessId },
      }),
    );
    if (current.status === "UNDER_REVIEW") {
      return { callback: current, unchanged: true as const };
    }
    if (current.status !== "RECORDED") {
      throw new JobCallbackError(JOB_CALLBACK_NOT_REVIEWABLE_MESSAGE);
    }

    const now = new Date();
    const write = await tx.jobCallback.updateMany({
      where: { id: current.id, businessId: access.businessId, status: "RECORDED" },
      data: {
        status: "UNDER_REVIEW",
        reviewedAt: now,
        reviewedByMembershipId: actorMembershipId(access),
      },
    });
    if (write.count !== 1) {
      const latest = access.assertOwned(
        await tx.jobCallback.findFirst({
          where: { id: current.id, businessId: access.businessId },
        }),
      );
      if (latest.status === "UNDER_REVIEW") {
        return { callback: latest, unchanged: true as const };
      }
      throw new JobCallbackError(JOB_CALLBACK_NOT_REVIEWABLE_MESSAGE);
    }
    await tx.jobCallbackEvent.create({
      data: {
        businessId: access.businessId,
        callbackId: current.id,
        eventType: "REVIEWED",
        fromStatus: "RECORDED",
        toStatus: "UNDER_REVIEW",
        actorMembershipId: actorMembershipId(access),
      },
    });
    return {
      callback: access.assertOwned(
        await tx.jobCallback.findFirst({
          where: { id: current.id, businessId: access.businessId },
        }),
      ),
      unchanged: false as const,
    };
  });

  return updated;
}

function sameRecordedOutcome(
  callback: { outcome: string | null; outcomeNotes: string | null },
  outcome: JobCallbackOutcome,
  notes: string,
) {
  return callback.outcome === outcome && (callback.outcomeNotes ?? "") === notes;
}

export async function recordCustomerReportedCallbackOutcome(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    callbackId: string;
    outcome?: string | null;
    outcomeNotes?: string | null;
  },
) {
  requireOwnerCallbackWrite(access);
  if (input.outcome && isForbiddenCoverageOutcome(input.outcome)) {
    throw new JobCallbackError(JOB_CALLBACK_COVERAGE_REFUSED_MESSAGE);
  }
  const outcome = parseJobCallbackOutcome(input.outcome);
  if (!outcome) {
    throw new JobCallbackError(JOB_CALLBACK_OUTCOME_REQUIRED_MESSAGE);
  }
  const notes = parseJobCallbackOutcomeNotes(input.outcomeNotes);
  const callback = await loadOwnedCallback(db, access, input.callbackId.trim());

  if (callback.status === "OUTCOME_RECORDED") {
    if (sameRecordedOutcome(callback, outcome, notes)) {
      return { callback, unchanged: true as const };
    }
    throw new JobCallbackError(JOB_CALLBACK_OUTCOME_ALREADY_RECORDED_MESSAGE);
  }
  if (callback.status !== "UNDER_REVIEW") {
    throw new JobCallbackError(JOB_CALLBACK_REVIEW_FIRST_MESSAGE);
  }

  return db.$transaction(async (tx) => {
    const locked = await lockTenantOwnedJob(tx, access.businessId, callback.jobId);
    if (!locked || locked.businessId !== access.businessId) {
      throw new JobCallbackError(JOB_CALLBACK_JOB_REQUIRED_MESSAGE);
    }
    const current = access.assertOwned(
      await tx.jobCallback.findFirst({
        where: { id: callback.id, businessId: access.businessId },
      }),
    );
    if (current.status === "OUTCOME_RECORDED") {
      if (sameRecordedOutcome(current, outcome, notes)) {
        return { callback: current, unchanged: true as const };
      }
      throw new JobCallbackError(JOB_CALLBACK_OUTCOME_ALREADY_RECORDED_MESSAGE);
    }
    if (current.status !== "UNDER_REVIEW") {
      throw new JobCallbackError(JOB_CALLBACK_REVIEW_FIRST_MESSAGE);
    }

    const now = new Date();
    const write = await tx.jobCallback.updateMany({
      where: {
        id: current.id,
        businessId: access.businessId,
        status: "UNDER_REVIEW",
      },
      data: {
        status: "OUTCOME_RECORDED",
        outcome,
        outcomeNotes: notes || null,
        outcomeAt: now,
        outcomeByMembershipId: actorMembershipId(access),
      },
    });
    if (write.count !== 1) {
      const latest = access.assertOwned(
        await tx.jobCallback.findFirst({
          where: { id: current.id, businessId: access.businessId },
        }),
      );
      if (
        latest.status === "OUTCOME_RECORDED" &&
        sameRecordedOutcome(latest, outcome, notes)
      ) {
        return { callback: latest, unchanged: true as const };
      }
      throw new JobCallbackError(JOB_CALLBACK_OUTCOME_ALREADY_RECORDED_MESSAGE);
    }
    await tx.jobCallbackEvent.create({
      data: {
        businessId: access.businessId,
        callbackId: current.id,
        eventType: "OUTCOME_RECORDED",
        fromStatus: "UNDER_REVIEW",
        toStatus: "OUTCOME_RECORDED",
        actorMembershipId: actorMembershipId(access),
        payload: eventPayload({
          outcome,
          notesLength: notes.length,
        }),
      },
    });
    return {
      callback: access.assertOwned(
        await tx.jobCallback.findFirst({
          where: { id: current.id, businessId: access.businessId },
        }),
      ),
      unchanged: false as const,
    };
  });
}

export function callbackIsOpen(status: string) {
  return isJobCallbackOpenStatus(status);
}

export type { JobCallbackReportedVia, JobCallbackOutcome };

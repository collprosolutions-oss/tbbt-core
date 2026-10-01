/**
 * OWNER mutations for job-specific aftercare on completed jobs.
 *
 * Save draft / publish / unpublish only. Never writes invoices, jobs,
 * payments, or customer messages. Drafts and owner notes stay off the
 * customer project token until an explicit publish.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { ForbiddenError, requireBusinessRole } from "@/lib/authorization";
import {
  JOB_AFTERCARE_COMPLETED_JOB_MESSAGE,
  JOB_AFTERCARE_INSTRUCTIONS_REQUIRED_MESSAGE,
  JOB_AFTERCARE_JOB_REQUIRED_MESSAGE,
  JOB_AFTERCARE_NOT_PUBLISHED_MESSAGE,
  JOB_AFTERCARE_NOTHING_TO_PUBLISH_MESSAGE,
  JOB_AFTERCARE_OWNER_ONLY_MESSAGE,
  JOB_AFTERCARE_UNAVAILABLE_MESSAGE,
  JOB_AFTERCARE_UNKNOWN_MESSAGE,
  completedSameBusinessJobEligible,
  jobAftercareWriteAllowed,
  missingJobAftercareSchema,
  parseJobAftercareInstructions,
  parseJobAftercareOwnerNotes,
} from "@/lib/job-aftercare";
import { lockTenantOwnedJob } from "@/lib/time-card-ops";

type Db = PrismaClient | Prisma.TransactionClient;

export class JobAftercareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobAftercareError";
  }
}

export function jobAftercareErrorMessage(error: unknown, fallback: string) {
  if (error instanceof JobAftercareError) return error.message;
  if (error instanceof ForbiddenError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  if (missingJobAftercareSchema(error)) return JOB_AFTERCARE_UNAVAILABLE_MESSAGE;
  return fallback;
}

/**
 * Test-only barriers. Production never sets these.
 * beforeJobLock runs inside the write transaction before lockTenantOwnedJob
 * so concurrent publishers can rendezvous, then contend for FOR UPDATE.
 * afterJobLock runs after the lock is taken.
 */
export const jobAftercareTestHooks: {
  beforeJobLock?: (input: { jobId: string; kind: string }) => Promise<void> | void;
  afterJobLock?: (input: { jobId: string; kind: string }) => Promise<void> | void;
} = {};

function rethrowAftercareWriteError(error: unknown): never {
  if (error instanceof JobAftercareError || error instanceof ForbiddenError) {
    throw error;
  }
  if (error instanceof Error && error.name === "ForbiddenError") {
    throw error;
  }
  if (missingJobAftercareSchema(error)) {
    throw new JobAftercareError(JOB_AFTERCARE_UNAVAILABLE_MESSAGE);
  }
  throw error;
}

function requireOwnerAftercareWrite(access: BusinessAccess) {
  if (!jobAftercareWriteAllowed(access.workspace.role)) {
    throw new ForbiddenError(JOB_AFTERCARE_OWNER_ONLY_MESSAGE);
  }
  requireBusinessRole(access, "OWNER");
}

function actorMembershipId(access: BusinessAccess) {
  return access.workspace.membership.id;
}

function eventPayload(input: Record<string, unknown>) {
  return JSON.stringify(input);
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

async function requireOwnedLockedJob(
  tx: Prisma.TransactionClient,
  access: BusinessAccess,
  jobId: string,
  kind: string,
) {
  await jobAftercareTestHooks.beforeJobLock?.({ jobId, kind });
  const locked = await lockTenantOwnedJob(tx, access.businessId, jobId);
  if (!locked) {
    throw new JobAftercareError(JOB_AFTERCARE_JOB_REQUIRED_MESSAGE);
  }
  access.assertOwned(locked);
  await jobAftercareTestHooks.afterJobLock?.({ jobId: locked.id, kind });
  return locked;
}

async function requireCompletedOwnedJob(
  tx: Prisma.TransactionClient,
  access: BusinessAccess,
  jobId: string,
  kind: string,
) {
  const locked = await requireOwnedLockedJob(tx, access, jobId, kind);
  if (!completedSameBusinessJobEligible(locked, access.businessId)) {
    throw new JobAftercareError(JOB_AFTERCARE_COMPLETED_JOB_MESSAGE);
  }
  return locked;
}

export async function saveJobAftercareDraft(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    jobId: string;
    instructions?: string | null;
    ownerNotes?: string | null;
  },
) {
  requireOwnerAftercareWrite(access);
  const jobId = input.jobId.trim();
  if (!jobId) {
    throw new JobAftercareError(JOB_AFTERCARE_JOB_REQUIRED_MESSAGE);
  }
  const instructions = parseJobAftercareInstructions(input.instructions);
  if (!instructions) {
    throw new JobAftercareError(JOB_AFTERCARE_INSTRUCTIONS_REQUIRED_MESSAGE);
  }
  const ownerNotes = parseJobAftercareOwnerNotes(input.ownerNotes);
  const actorId = actorMembershipId(access);

  try {
  return await db.$transaction(async (tx) => {
    const locked = await requireCompletedOwnedJob(tx, access, jobId, "draft");
    const existing = await tx.jobAftercareInstruction.findFirst({
      where: { jobId: locked.id, businessId: access.businessId },
    });

    if (!existing) {
      const created = await tx.jobAftercareInstruction.create({
        data: {
          businessId: access.businessId,
          jobId: locked.id,
          draftInstructions: instructions,
          ownerNotes,
          status: "DRAFT",
          createdByMembershipId: actorId,
          updatedByMembershipId: actorId,
        },
      });
      await tx.jobAftercareEvent.create({
        data: {
          businessId: access.businessId,
          jobId: locked.id,
          aftercareId: created.id,
          eventType: "DRAFTED",
          fromStatus: null,
          toStatus: "DRAFT",
          instructionsSnapshot: instructions,
          actorMembershipId: actorId,
          payload: eventPayload({
            instructionsLength: instructions.length,
            notesLength: ownerNotes.length,
          }),
        },
      });
      return { aftercare: created, unchanged: false as const };
    }

    const owned = access.assertOwned(existing);
    if (owned.draftInstructions === instructions && (owned.ownerNotes ?? "") === ownerNotes) {
      return { aftercare: owned, unchanged: true as const };
    }

    const write = await tx.jobAftercareInstruction.updateMany({
      where: { id: owned.id, businessId: access.businessId },
      data: {
        draftInstructions: instructions,
        ownerNotes,
        updatedByMembershipId: actorId,
      },
    });
    if (write.count !== 1) {
      throw new JobAftercareError(JOB_AFTERCARE_UNKNOWN_MESSAGE);
    }
    await tx.jobAftercareEvent.create({
      data: {
        businessId: access.businessId,
        jobId: locked.id,
        aftercareId: owned.id,
        eventType: "REVISED",
        fromStatus: owned.status,
        toStatus: owned.status,
        instructionsSnapshot: instructions,
        actorMembershipId: actorId,
        payload: eventPayload({
          instructionsLength: instructions.length,
          notesLength: ownerNotes.length,
        }),
      },
    });
    return {
      aftercare: access.assertOwned(
        await tx.jobAftercareInstruction.findFirst({
          where: { id: owned.id, businessId: access.businessId },
        }),
      ),
      unchanged: false as const,
    };
  });
  } catch (error) {
    rethrowAftercareWriteError(error);
  }
}

export async function publishJobAftercare(
  db: PrismaClient,
  access: BusinessAccess,
  input: { jobId: string },
) {
  requireOwnerAftercareWrite(access);
  const jobId = input.jobId.trim();
  if (!jobId) {
    throw new JobAftercareError(JOB_AFTERCARE_JOB_REQUIRED_MESSAGE);
  }

  try {
  return await db.$transaction(async (tx) => {
    const locked = await requireCompletedOwnedJob(tx, access, jobId, "publish");
    const current = await tx.jobAftercareInstruction.findFirst({
      where: { jobId: locked.id, businessId: access.businessId },
    });
    if (!current) {
      throw new JobAftercareError(JOB_AFTERCARE_NOTHING_TO_PUBLISH_MESSAGE);
    }
    const owned = access.assertOwned(current);
    const instructions = parseJobAftercareInstructions(owned.draftInstructions);
    if (!instructions) {
      throw new JobAftercareError(JOB_AFTERCARE_NOTHING_TO_PUBLISH_MESSAGE);
    }
    if (
      owned.status === "PUBLISHED" &&
      owned.publishedInstructions === instructions
    ) {
      return { aftercare: owned, unchanged: true as const };
    }

    const now = new Date();
    const write = await tx.jobAftercareInstruction.updateMany({
      where: { id: owned.id, businessId: access.businessId },
      data: {
        status: "PUBLISHED",
        publishedInstructions: instructions,
        publishedAt: now,
        publishedByMembershipId: actorMembershipId(access),
        unpublishedAt: null,
        unpublishedByMembershipId: null,
        updatedByMembershipId: actorMembershipId(access),
      },
    });
    if (write.count !== 1) {
      throw new JobAftercareError(JOB_AFTERCARE_UNKNOWN_MESSAGE);
    }
    await tx.jobAftercareEvent.create({
      data: {
        businessId: access.businessId,
        jobId: locked.id,
        aftercareId: owned.id,
        eventType: "PUBLISHED",
        fromStatus: owned.status,
        toStatus: "PUBLISHED",
        instructionsSnapshot: instructions,
        actorMembershipId: actorMembershipId(access),
        payload: eventPayload({ instructionsLength: instructions.length }),
      },
    });
    return {
      aftercare: access.assertOwned(
        await tx.jobAftercareInstruction.findFirst({
          where: { id: owned.id, businessId: access.businessId },
        }),
      ),
      unchanged: false as const,
    };
  });
  } catch (error) {
    rethrowAftercareWriteError(error);
  }
}

export async function unpublishJobAftercare(
  db: PrismaClient,
  access: BusinessAccess,
  input: { jobId: string },
) {
  requireOwnerAftercareWrite(access);
  const jobId = input.jobId.trim();
  if (!jobId) {
    throw new JobAftercareError(JOB_AFTERCARE_JOB_REQUIRED_MESSAGE);
  }

  try {
  return await db.$transaction(async (tx) => {
    // Unpublish must not require COMPLETED. If a job later leaves
    // COMPLETED, the owner must still be able to withdraw live text.
    const locked = await requireOwnedLockedJob(tx, access, jobId, "unpublish");
    const current = await tx.jobAftercareInstruction.findFirst({
      where: { jobId: locked.id, businessId: access.businessId },
    });
    if (!current) {
      throw new JobAftercareError(JOB_AFTERCARE_UNKNOWN_MESSAGE);
    }
    const owned = access.assertOwned(current);
    if (owned.status !== "PUBLISHED") {
      if (owned.status === "UNPUBLISHED") {
        return { aftercare: owned, unchanged: true as const };
      }
      throw new JobAftercareError(JOB_AFTERCARE_NOT_PUBLISHED_MESSAGE);
    }

    const revoked = owned.publishedInstructions ?? owned.draftInstructions;
    const now = new Date();
    const write = await tx.jobAftercareInstruction.updateMany({
      where: {
        id: owned.id,
        businessId: access.businessId,
        status: "PUBLISHED",
      },
      data: {
        status: "UNPUBLISHED",
        publishedInstructions: null,
        unpublishedAt: now,
        unpublishedByMembershipId: actorMembershipId(access),
        updatedByMembershipId: actorMembershipId(access),
      },
    });
    if (write.count !== 1) {
      const latest = access.assertOwned(
        await tx.jobAftercareInstruction.findFirst({
          where: { id: owned.id, businessId: access.businessId },
        }),
      );
      if (latest.status === "UNPUBLISHED") {
        return { aftercare: latest, unchanged: true as const };
      }
      throw new JobAftercareError(JOB_AFTERCARE_NOT_PUBLISHED_MESSAGE);
    }
    await tx.jobAftercareEvent.create({
      data: {
        businessId: access.businessId,
        jobId: locked.id,
        aftercareId: owned.id,
        eventType: "UNPUBLISHED",
        fromStatus: "PUBLISHED",
        toStatus: "UNPUBLISHED",
        instructionsSnapshot: revoked,
        actorMembershipId: actorMembershipId(access),
        payload: eventPayload({ instructionsLength: revoked.length }),
      },
    });
    return {
      aftercare: access.assertOwned(
        await tx.jobAftercareInstruction.findFirst({
          where: { id: owned.id, businessId: access.businessId },
        }),
      ),
      unchanged: false as const,
    };
  });
  } catch (error) {
    rethrowAftercareWriteError(error);
  }
}

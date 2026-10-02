/**
 * OWNER mutations for rotating or revoking a Job's customer project link.
 *
 * Replaces Job.projectToken inside a locked transaction so every
 * /p/[token] lookup of the old token fails immediately. Writes an
 * append-only audit event. Never sends email or SMS, never creates an
 * invoice or payment, and never remaps historical Job rows.
 */
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { ForbiddenError, requireBusinessRole } from "@/lib/authorization";
import {
  JOB_PROJECT_LINK_CONFLICT_MESSAGE,
  JOB_PROJECT_LINK_JOB_REQUIRED_MESSAGE,
  JOB_PROJECT_LINK_NOT_ACTIVE_MESSAGE,
  JOB_PROJECT_LINK_OWNER_ONLY_MESSAGE,
  JOB_PROJECT_LINK_UNAVAILABLE_MESSAGE,
  jobProjectLinkWriteAllowed,
  missingJobProjectLinkSchema,
  projectLinkTokenAuditValue,
} from "@/lib/project-link";
import { lockTenantOwnedJob } from "@/lib/time-card-ops";

type Db = PrismaClient | Prisma.TransactionClient;

export class JobProjectLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobProjectLinkError";
  }
}

export function jobProjectLinkErrorMessage(error: unknown, fallback: string) {
  if (error instanceof JobProjectLinkError) return error.message;
  if (error instanceof ForbiddenError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  if (missingJobProjectLinkSchema(error)) return JOB_PROJECT_LINK_UNAVAILABLE_MESSAGE;
  return fallback;
}

/**
 * Test-only barriers. Production never sets these.
 * beforeJobLock runs inside the write transaction before lockTenantOwnedJob
 * so concurrent rotators can rendezvous, then contend for FOR UPDATE.
 */
export const jobProjectLinkTestHooks: {
  beforeJobLock?: (input: { jobId: string; kind: "rotate" | "revoke" }) => Promise<void> | void;
  afterJobLock?: (input: {
    jobId: string;
    kind: "rotate" | "revoke";
    projectToken: string;
  }) => Promise<void> | void;
} = {};

function rethrowProjectLinkWriteError(error: unknown): never {
  if (error instanceof JobProjectLinkError || error instanceof ForbiddenError) {
    throw error;
  }
  if (error instanceof Error && error.name === "ForbiddenError") {
    throw error;
  }
  if (missingJobProjectLinkSchema(error)) {
    throw new JobProjectLinkError(JOB_PROJECT_LINK_UNAVAILABLE_MESSAGE);
  }
  throw error;
}

function requireOwnerProjectLinkWrite(access: BusinessAccess) {
  if (!jobProjectLinkWriteAllowed(access.workspace.role)) {
    throw new ForbiddenError(JOB_PROJECT_LINK_OWNER_ONLY_MESSAGE);
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
  kind: "rotate" | "revoke",
) {
  await jobProjectLinkTestHooks.beforeJobLock?.({ jobId, kind });
  const locked = await lockTenantOwnedJob(tx, access.businessId, jobId);
  if (!locked) {
    throw new JobProjectLinkError(JOB_PROJECT_LINK_JOB_REQUIRED_MESSAGE);
  }
  access.assertOwned(locked);
  const current = await tx.job.findFirst({
    where: { id: locked.id, businessId: access.businessId },
    select: { id: true, businessId: true, projectToken: true },
  });
  if (!current) {
    throw new JobProjectLinkError(JOB_PROJECT_LINK_JOB_REQUIRED_MESSAGE);
  }
  access.assertOwned(current);
  await jobProjectLinkTestHooks.afterJobLock?.({
    jobId: current.id,
    kind,
    projectToken: current.projectToken,
  });
  return current;
}

async function loadOwnedLink(
  tx: Prisma.TransactionClient,
  access: BusinessAccess,
  jobId: string,
) {
  const link = await tx.jobProjectLink.findFirst({
    where: { jobId, businessId: access.businessId },
  });
  return link ? access.assertOwned(link) : null;
}

async function ensureLinkRow(
  tx: Prisma.TransactionClient,
  access: BusinessAccess,
  jobId: string,
) {
  const existing = await loadOwnedLink(tx, access, jobId);
  if (existing) return existing;
  try {
    return access.assertOwned(
      await tx.jobProjectLink.create({
        data: {
          businessId: access.businessId,
          jobId,
          status: "ACTIVE",
          updatedByMembershipId: actorMembershipId(access),
        },
      }),
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await loadOwnedLink(tx, access, jobId);
      if (raced) return raced;
    }
    throw error;
  }
}

async function replaceLiveProjectToken(
  tx: Prisma.TransactionClient,
  input: {
    jobId: string;
    businessId: string;
    expectedToken: string;
    nextToken: string;
  },
) {
  const written = await tx.job.updateMany({
    where: {
      id: input.jobId,
      businessId: input.businessId,
      projectToken: input.expectedToken,
    },
    data: { projectToken: input.nextToken },
  });
  if (written.count !== 1) {
    throw new JobProjectLinkError(JOB_PROJECT_LINK_CONFLICT_MESSAGE);
  }
}

export type RotatedProjectLink = {
  jobId: string;
  businessId: string;
  previousToken: string;
  projectToken: string;
  projectPath: string;
};

export async function rotateJobProjectLink(
  db: PrismaClient,
  access: BusinessAccess,
  input: { jobId: string },
): Promise<RotatedProjectLink> {
  requireOwnerProjectLinkWrite(access);
  const jobId = input.jobId.trim();
  if (!jobId) {
    throw new JobProjectLinkError(JOB_PROJECT_LINK_JOB_REQUIRED_MESSAGE);
  }

  try {
    return await db.$transaction(async (tx) => {
      const locked = await requireOwnedLockedJob(tx, access, jobId, "rotate");
      const link = await ensureLinkRow(tx, access, locked.id);
      const previousToken = locked.projectToken;
      const nextToken = randomUUID();
      const now = new Date();

      await replaceLiveProjectToken(tx, {
        jobId: locked.id,
        businessId: access.businessId,
        expectedToken: previousToken,
        nextToken,
      });

      const written = await tx.jobProjectLink.updateMany({
        where: { id: link.id, businessId: access.businessId },
        data: {
          status: "ACTIVE",
          rotatedAt: now,
          revokedAt: null,
          updatedByMembershipId: actorMembershipId(access),
        },
      });
      if (written.count !== 1) {
        throw new JobProjectLinkError(JOB_PROJECT_LINK_CONFLICT_MESSAGE);
      }

      await tx.jobProjectLinkEvent.create({
        data: {
          businessId: access.businessId,
          jobId: locked.id,
          linkId: link.id,
          eventType: "ROTATED",
          fromStatus: link.status,
          toStatus: "ACTIVE",
          previousToken,
          nextToken: projectLinkTokenAuditValue(nextToken),
          actorMembershipId: actorMembershipId(access),
          payload: eventPayload({ action: "ROTATED" }),
        },
      });

      return {
        jobId: locked.id,
        businessId: access.businessId,
        previousToken,
        projectToken: nextToken,
        projectPath: `/p/${nextToken}`,
      };
    });
  } catch (error) {
    rethrowProjectLinkWriteError(error);
  }
}

export type RevokedProjectLink = {
  jobId: string;
  businessId: string;
  previousToken: string;
  unchanged: boolean;
};

export async function revokeJobProjectLink(
  db: PrismaClient,
  access: BusinessAccess,
  input: { jobId: string },
): Promise<RevokedProjectLink> {
  requireOwnerProjectLinkWrite(access);
  const jobId = input.jobId.trim();
  if (!jobId) {
    throw new JobProjectLinkError(JOB_PROJECT_LINK_JOB_REQUIRED_MESSAGE);
  }

  try {
    return await db.$transaction(async (tx) => {
      const locked = await requireOwnedLockedJob(tx, access, jobId, "revoke");
      const link = await ensureLinkRow(tx, access, locked.id);
      if (link.status === "REVOKED") {
        return {
          jobId: locked.id,
          businessId: access.businessId,
          previousToken: locked.projectToken,
          unchanged: true,
        };
      }

      const previousToken = locked.projectToken;
      const burnedToken = randomUUID();
      const now = new Date();

      await replaceLiveProjectToken(tx, {
        jobId: locked.id,
        businessId: access.businessId,
        expectedToken: previousToken,
        nextToken: burnedToken,
      });

      const written = await tx.jobProjectLink.updateMany({
        where: {
          id: link.id,
          businessId: access.businessId,
          status: "ACTIVE",
        },
        data: {
          status: "REVOKED",
          revokedAt: now,
          updatedByMembershipId: actorMembershipId(access),
        },
      });
      if (written.count !== 1) {
        const latest = await loadOwnedLink(tx, access, locked.id);
        if (latest?.status === "REVOKED") {
          return {
            jobId: locked.id,
            businessId: access.businessId,
            previousToken,
            unchanged: true,
          };
        }
        throw new JobProjectLinkError(JOB_PROJECT_LINK_NOT_ACTIVE_MESSAGE);
      }

      await tx.jobProjectLinkEvent.create({
        data: {
          businessId: access.businessId,
          jobId: locked.id,
          linkId: link.id,
          eventType: "REVOKED",
          fromStatus: "ACTIVE",
          toStatus: "REVOKED",
          previousToken,
          nextToken: null,
          actorMembershipId: actorMembershipId(access),
          payload: eventPayload({ action: "REVOKED" }),
        },
      });

      return {
        jobId: locked.id,
        businessId: access.businessId,
        previousToken,
        unchanged: false,
      };
    });
  } catch (error) {
    rethrowProjectLinkWriteError(error);
  }
}

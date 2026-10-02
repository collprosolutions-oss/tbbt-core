/**
 * Customer Project Portal callback request.
 *
 * Resolves the completed Job from projectToken only. Creates a
 * JobCallback in RECORDED so the existing OWNER review path can act.
 * Never creates a Job, invoice, payment, or customer message, and never
 * promises warranty coverage.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  JOB_CALLBACK_OPEN_STATUSES,
  JOB_CALLBACK_PORTAL_COMPLETED_JOB_MESSAGE,
  JOB_CALLBACK_PORTAL_CONTACT_REQUIRED_MESSAGE,
  JOB_CALLBACK_PORTAL_COOLDOWN_MESSAGE,
  JOB_CALLBACK_PORTAL_DESCRIPTION_REQUIRED_MESSAGE,
  JOB_CALLBACK_PORTAL_UNAVAILABLE_MESSAGE,
  completedSameBusinessJobEligible,
  formatPortalCallbackDescription,
  isPortalJobCallbackCoolingDown,
  parsePortalJobCallbackDescription,
  parsePortalJobCallbackPreferredContact,
  parsePortalProjectToken,
} from "@/lib/job-callback";
import {
  countBusinessCommunications,
  countBusinessInvoices,
  countBusinessJobs,
  countBusinessPayments,
} from "@/lib/job-callback-ops";
import {
  findLatestResolvedJobCallback,
  resolvedJobCallbackAt,
} from "@/lib/portal-job-callback-data";
import {
  assertLiveLockedProjectToken,
  findLiveJobByProjectToken,
} from "@/lib/project-link-data";
import { lockTenantOwnedJob } from "@/lib/time-card-ops";

export type PortalJobCallbackSubmitInput = {
  token: string;
  description?: string | null;
  preferredContact?: string | null;
};

export type PortalJobCallbackSubmitResult =
  | { ok: true; callbackId: string; jobId: string; alreadyExists: boolean }
  | { ok: false; error: string };

/**
 * Test-only barrier. Production never sets this.
 * afterJobLock runs inside the write transaction after lockTenantOwnedJob
 * and before the post-lock live-token re-check. Reverting that re-check
 * lets an in-flight old-token callback land after rotate commits.
 */
export const portalJobCallbackTestHooks: {
  afterJobLock?: (input: { jobId: string; token: string }) => Promise<void> | void;
} = {};

const PORTAL_JOB_SELECT = {
  id: true,
  businessId: true,
  customerId: true,
  status: true,
} as const;

async function findOpenPortalCallback(
  db: PrismaClient | Prisma.TransactionClient,
  businessId: string,
  jobId: string,
) {
  return db.jobCallback.findFirst({
    where: {
      businessId,
      jobId,
      status: { in: [...JOB_CALLBACK_OPEN_STATUSES] },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 1,
    select: { id: true },
  });
}

async function findActiveOwnerMembership(
  db: PrismaClient | Prisma.TransactionClient,
  businessId: string,
) {
  return db.membership.findFirst({
    where: { businessId, role: "OWNER", active: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 1,
    select: { id: true },
  });
}

export async function submitPortalJobCallback(
  db: PrismaClient,
  input: PortalJobCallbackSubmitInput,
): Promise<PortalJobCallbackSubmitResult> {
  const token = parsePortalProjectToken(input.token);
  if (!token) {
    return { ok: false, error: JOB_CALLBACK_PORTAL_UNAVAILABLE_MESSAGE };
  }
  const description = parsePortalJobCallbackDescription(input.description);
  if (!description) {
    return { ok: false, error: JOB_CALLBACK_PORTAL_DESCRIPTION_REQUIRED_MESSAGE };
  }
  const preferredContact = parsePortalJobCallbackPreferredContact(input.preferredContact);
  if (!preferredContact) {
    return { ok: false, error: JOB_CALLBACK_PORTAL_CONTACT_REQUIRED_MESSAGE };
  }
  const storedDescription = formatPortalCallbackDescription(description, preferredContact);

  try {
    return await db.$transaction(async (tx) => {
      const job = await findLiveJobByProjectToken(tx, token, PORTAL_JOB_SELECT);
      if (!job) {
        return { ok: false, error: JOB_CALLBACK_PORTAL_UNAVAILABLE_MESSAGE };
      }

      const locked = await lockTenantOwnedJob(tx, job.businessId, job.id);
      if (!locked || locked.businessId !== job.businessId) {
        return { ok: false, error: JOB_CALLBACK_PORTAL_UNAVAILABLE_MESSAGE };
      }
      await portalJobCallbackTestHooks.afterJobLock?.({ jobId: locked.id, token });
      if (
        !(await assertLiveLockedProjectToken(tx, {
          jobId: locked.id,
          businessId: locked.businessId,
          token,
        }))
      ) {
        return { ok: false, error: JOB_CALLBACK_PORTAL_UNAVAILABLE_MESSAGE };
      }
      if (!completedSameBusinessJobEligible(locked, job.businessId)) {
        return { ok: false, error: JOB_CALLBACK_PORTAL_COMPLETED_JOB_MESSAGE };
      }

      const existing = await findOpenPortalCallback(tx, locked.businessId, locked.id);
      if (existing) {
        return {
          ok: true,
          callbackId: existing.id,
          jobId: locked.id,
          alreadyExists: true,
        };
      }

      const resolved = await findLatestResolvedJobCallback(tx, locked.businessId, locked.id);
      if (isPortalJobCallbackCoolingDown(resolvedJobCallbackAt(resolved))) {
        return { ok: false, error: JOB_CALLBACK_PORTAL_COOLDOWN_MESSAGE };
      }

      const owner = await findActiveOwnerMembership(tx, locked.businessId);
      if (!owner) {
        return { ok: false, error: JOB_CALLBACK_PORTAL_UNAVAILABLE_MESSAGE };
      }

      const created = await tx.jobCallback.create({
        data: {
          businessId: locked.businessId,
          jobId: locked.id,
          customerId: locked.customerId,
          description: storedDescription,
          reportedVia: "PORTAL",
          status: "RECORDED",
          recordedByMembershipId: owner.id,
        },
      });
      await tx.jobCallbackEvent.create({
        data: {
          businessId: locked.businessId,
          callbackId: created.id,
          eventType: "RECORDED",
          fromStatus: null,
          toStatus: "RECORDED",
          actorMembershipId: owner.id,
          payload: JSON.stringify({
            source: "PORTAL",
            preferredContact,
            descriptionLength: storedDescription.length,
          }),
        },
      });
      return {
        ok: true,
        callbackId: created.id,
        jobId: locked.id,
        alreadyExists: false,
      };
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const job = await findLiveJobByProjectToken(db, token, {
        id: true,
        businessId: true,
      });
      if (!job) {
        return { ok: false, error: JOB_CALLBACK_PORTAL_UNAVAILABLE_MESSAGE };
      }
      const existing = await findOpenPortalCallback(db, job.businessId, job.id);
      if (existing) {
        return {
          ok: true,
          callbackId: existing.id,
          jobId: job.id,
          alreadyExists: true,
        };
      }
    }
    throw error;
  }
}

export {
  countBusinessCommunications,
  countBusinessInvoices,
  countBusinessJobs,
  countBusinessPayments,
};

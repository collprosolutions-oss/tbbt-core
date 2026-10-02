/**
 * Customer Project Portal callback request.
 *
 * Resolves the completed Job from projectToken only. Creates a
 * JobCallback in RECORDED so the existing OWNER review path can act.
 * Never creates a Job, invoice, payment, or customer message, and never
 * promises warranty coverage.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { PROJECT_DOCUMENT_PURPOSE } from "@/lib/business-storage/project-documents";
import {
  JOB_CALLBACK_OPEN_STATUSES,
  JOB_CALLBACK_PORTAL_CLOSED_MESSAGE,
  JOB_CALLBACK_PORTAL_COMPLETED_JOB_MESSAGE,
  JOB_CALLBACK_PORTAL_CONTACT_REQUIRED_MESSAGE,
  JOB_CALLBACK_PORTAL_COOLDOWN_MESSAGE,
  JOB_CALLBACK_PORTAL_DESCRIPTION_REQUIRED_MESSAGE,
  JOB_CALLBACK_PORTAL_UNAVAILABLE_MESSAGE,
  JOB_CALLBACK_UNAVAILABLE_MESSAGE,
  MAX_JOB_CALLBACK_ATTACHMENTS,
  completedSameBusinessJobEligible,
  formatPortalCallbackDescription,
  isPortalJobCallbackClosed,
  isPortalJobCallbackCoolingDown,
  missingJobCallbackIssueSchema,
  parseJobCallbackAttachmentIds,
  parseJobCallbackCategory,
  parsePortalJobCallbackDescription,
  parsePortalJobCallbackPreferredContact,
  parsePortalProjectToken,
} from "@/lib/job-callback";
import {
  countBusinessCommunications,
  countBusinessInvoices,
  countBusinessJobs,
  countBusinessPayments,
  jobCallbackTestHooks,
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
  category?: string | null;
  storedAssetIds?: readonly string[] | null;
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
  const category = parseJobCallbackCategory(input.category);
  const storedAssetIds = parseJobCallbackAttachmentIds(input.storedAssetIds);
  const storedDescription = formatPortalCallbackDescription(description, preferredContact);

  try {
    return await db.$transaction(async (tx) => {
      const job = await findLiveJobByProjectToken(tx, token, PORTAL_JOB_SELECT);
      if (!job) {
        return { ok: false, error: JOB_CALLBACK_PORTAL_UNAVAILABLE_MESSAGE };
      }

      await jobCallbackTestHooks.beforeJobLock?.({ jobId: job.id, kind: "portal" });
      const locked = await lockTenantOwnedJob(tx, job.businessId, job.id);
      if (!locked || locked.businessId !== job.businessId) {
        return { ok: false, error: JOB_CALLBACK_PORTAL_UNAVAILABLE_MESSAGE };
      }
      await portalJobCallbackTestHooks.afterJobLock?.({ jobId: locked.id, token });
      await jobCallbackTestHooks.afterJobLock?.({ jobId: locked.id, kind: "portal" });
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
      if (isPortalJobCallbackClosed(resolved?.outcome)) {
        return { ok: false, error: JOB_CALLBACK_PORTAL_CLOSED_MESSAGE };
      }
      if (isPortalJobCallbackCoolingDown(resolvedJobCallbackAt(resolved))) {
        return { ok: false, error: JOB_CALLBACK_PORTAL_COOLDOWN_MESSAGE };
      }

      const owner = await findActiveOwnerMembership(tx, locked.businessId);
      if (!owner) {
        return { ok: false, error: JOB_CALLBACK_PORTAL_UNAVAILABLE_MESSAGE };
      }

      const documents =
        storedAssetIds.length === 0
          ? []
          : await tx.$queryRaw<Array<{ id: string; originalFilename: string }>>`
              SELECT id, "originalFilename"
              FROM "StoredAsset"
              WHERE id IN (${Prisma.join(storedAssetIds)})
                AND "businessId" = ${locked.businessId}
                AND "jobId" = ${locked.id}
                AND category = 'DOCUMENT'
                AND purpose = ${PROJECT_DOCUMENT_PURPOSE}
                AND visibility = 'PRIVATE'
                AND status = 'READY'
                AND "deletedAt" IS NULL
                AND "publicPath" IS NULL
              FOR UPDATE
            `;
      if (storedAssetIds.length > MAX_JOB_CALLBACK_ATTACHMENTS || documents.length !== storedAssetIds.length) {
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
      if (category) {
        try {
          await tx.jobCallback.update({
            where: { id: created.id },
            data: { category },
          });
        } catch (error) {
          if (!missingJobCallbackIssueSchema(error)) throw error;
        }
      }
      if (documents.length > 0) {
        try {
          const byId = new Map(documents.map((row) => [row.id, row]));
          await tx.jobCallbackAttachment.createMany({
            data: storedAssetIds.map((id) => {
              const document = byId.get(id);
              return {
                businessId: locked.businessId,
                jobId: locked.id,
                callbackId: created.id,
                storedAssetId: id,
                originalFilename: document?.originalFilename ?? "document",
              };
            }),
          });
        } catch (error) {
          if (!missingJobCallbackIssueSchema(error)) throw error;
        }
      }
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
            category: category ?? null,
            descriptionLength: storedDescription.length,
            attachmentCount: documents.length,
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
    if (missingJobCallbackIssueSchema(error)) {
      return { ok: false, error: JOB_CALLBACK_UNAVAILABLE_MESSAGE };
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

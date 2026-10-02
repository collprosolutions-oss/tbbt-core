/**
 * Customer Project Portal structured issue request.
 *
 * Resolves the completed Job from projectToken only. Creates a
 * JobCustomerIssue in RECEIVED so the OWNER review path can act.
 * Never creates a JobCallback, Job, invoice, payment, or customer
 * message, and never promises warranty coverage.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { parsePortalProjectToken } from "@/lib/job-callback";
import {
  JOB_CUSTOMER_ISSUE_OPEN_STATUSES,
  JOB_CUSTOMER_ISSUE_PORTAL_CATEGORY_REQUIRED_MESSAGE,
  JOB_CUSTOMER_ISSUE_PORTAL_COMPLETED_JOB_MESSAGE,
  JOB_CUSTOMER_ISSUE_PORTAL_CONTACT_REQUIRED_MESSAGE,
  JOB_CUSTOMER_ISSUE_PORTAL_DESCRIPTION_REQUIRED_MESSAGE,
  JOB_CUSTOMER_ISSUE_PORTAL_UNAVAILABLE_MESSAGE,
  JOB_CUSTOMER_ISSUE_UNAVAILABLE_MESSAGE,
  completedSameBusinessJobEligible,
  missingJobCustomerIssueSchema,
  parseJobCustomerIssueAttachmentIds,
  parseJobCustomerIssueCategory,
  parseJobCustomerIssuePreferredContact,
  parsePortalJobCustomerIssueDescription,
} from "@/lib/job-customer-issue";
import {
  countBusinessCallbacks,
  countBusinessCommunications,
  countBusinessInvoices,
  countBusinessJobs,
  countBusinessPayments,
  jobCustomerIssueTestHooks,
} from "@/lib/job-customer-issue-ops";
import {
  assertLiveLockedProjectToken,
  findLiveJobByProjectToken,
} from "@/lib/project-link-data";
import { PROJECT_DOCUMENT_PURPOSE } from "@/lib/business-storage/project-documents";
import { lockTenantOwnedJob } from "@/lib/time-card-ops";

export {
  countBusinessCallbacks,
  countBusinessCommunications,
  countBusinessInvoices,
  countBusinessJobs,
  countBusinessPayments,
};

export type PortalJobCustomerIssueSubmitInput = {
  token: string;
  category?: string | null;
  description?: string | null;
  preferredContact?: string | null;
  storedAssetIds?: readonly string[] | null;
};

export type PortalJobCustomerIssueSubmitResult =
  | { ok: true; issueId: string; jobId: string; alreadyExists: boolean }
  | { ok: false; error: string };

/**
 * Test-only barrier. Production never sets this.
 * afterJobLock runs inside the write transaction after lockTenantOwnedJob
 * and before the post-lock live-token re-check.
 */
export const portalJobCustomerIssueTestHooks: {
  afterJobLock?: (input: { jobId: string; token: string }) => Promise<void> | void;
} = {};

const PORTAL_JOB_SELECT = {
  id: true,
  businessId: true,
  customerId: true,
  status: true,
} as const;

async function findOpenPortalIssue(
  db: PrismaClient | Prisma.TransactionClient,
  businessId: string,
  jobId: string,
) {
  return db.jobCustomerIssue.findFirst({
    where: {
      businessId,
      jobId,
      customerVisibleStatus: { in: [...JOB_CUSTOMER_ISSUE_OPEN_STATUSES] },
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

export async function submitPortalJobCustomerIssue(
  db: PrismaClient,
  input: PortalJobCustomerIssueSubmitInput,
): Promise<PortalJobCustomerIssueSubmitResult> {
  const token = parsePortalProjectToken(input.token);
  if (!token) {
    return { ok: false, error: JOB_CUSTOMER_ISSUE_PORTAL_UNAVAILABLE_MESSAGE };
  }
  const category = parseJobCustomerIssueCategory(input.category);
  if (!category) {
    return { ok: false, error: JOB_CUSTOMER_ISSUE_PORTAL_CATEGORY_REQUIRED_MESSAGE };
  }
  const description = parsePortalJobCustomerIssueDescription(input.description);
  if (!description) {
    return { ok: false, error: JOB_CUSTOMER_ISSUE_PORTAL_DESCRIPTION_REQUIRED_MESSAGE };
  }
  const preferredContact = parseJobCustomerIssuePreferredContact(input.preferredContact);
  if (!preferredContact) {
    return { ok: false, error: JOB_CUSTOMER_ISSUE_PORTAL_CONTACT_REQUIRED_MESSAGE };
  }
  const storedAssetIds = parseJobCustomerIssueAttachmentIds(input.storedAssetIds);

  try {
    return await db.$transaction(async (tx) => {
      const job = await findLiveJobByProjectToken(tx, token, PORTAL_JOB_SELECT);
      if (!job) {
        return { ok: false, error: JOB_CUSTOMER_ISSUE_PORTAL_UNAVAILABLE_MESSAGE };
      }

      await jobCustomerIssueTestHooks.beforeJobLock?.({ jobId: job.id, kind: "portal" });
      const locked = await lockTenantOwnedJob(tx, job.businessId, job.id);
      if (!locked || locked.businessId !== job.businessId) {
        return { ok: false, error: JOB_CUSTOMER_ISSUE_PORTAL_UNAVAILABLE_MESSAGE };
      }
      await portalJobCustomerIssueTestHooks.afterJobLock?.({ jobId: locked.id, token });
      await jobCustomerIssueTestHooks.afterJobLock?.({ jobId: locked.id, kind: "portal" });
      if (
        !(await assertLiveLockedProjectToken(tx, {
          jobId: locked.id,
          businessId: locked.businessId,
          token,
        }))
      ) {
        return { ok: false, error: JOB_CUSTOMER_ISSUE_PORTAL_UNAVAILABLE_MESSAGE };
      }
      if (!completedSameBusinessJobEligible(locked, job.businessId)) {
        return { ok: false, error: JOB_CUSTOMER_ISSUE_PORTAL_COMPLETED_JOB_MESSAGE };
      }

      const existing = await findOpenPortalIssue(tx, locked.businessId, locked.id);
      if (existing) {
        return {
          ok: true,
          issueId: existing.id,
          jobId: locked.id,
          alreadyExists: true,
        };
      }

      const owner = await findActiveOwnerMembership(tx, locked.businessId);
      if (!owner) {
        return { ok: false, error: JOB_CUSTOMER_ISSUE_PORTAL_UNAVAILABLE_MESSAGE };
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
      if (documents.length !== storedAssetIds.length) {
        return { ok: false, error: JOB_CUSTOMER_ISSUE_PORTAL_UNAVAILABLE_MESSAGE };
      }

      const created = await tx.jobCustomerIssue.create({
        data: {
          businessId: locked.businessId,
          jobId: locked.id,
          customerId: locked.customerId,
          category,
          description,
          reportedVia: "PORTAL",
          preferredContact,
          customerVisibleStatus: "RECEIVED",
          recordedByMembershipId: owner.id,
        },
      });
      if (documents.length > 0) {
        const byId = new Map(documents.map((row) => [row.id, row]));
        await tx.jobCustomerIssueAttachment.createMany({
          data: storedAssetIds.map((id) => {
            const document = byId.get(id);
            return {
              businessId: locked.businessId,
              jobId: locked.id,
              issueId: created.id,
              storedAssetId: id,
              originalFilename: document?.originalFilename ?? "document",
            };
          }),
        });
      }
      await tx.jobCustomerIssueEvent.create({
        data: {
          businessId: locked.businessId,
          jobId: locked.id,
          issueId: created.id,
          eventType: "RECORDED",
          fromCustomerVisibleStatus: null,
          toCustomerVisibleStatus: "RECEIVED",
          actorMembershipId: owner.id,
          payload: JSON.stringify({
            source: "PORTAL",
            category,
            preferredContact,
            descriptionLength: description.length,
            attachmentCount: documents.length,
          }),
        },
      });
      return {
        ok: true,
        issueId: created.id,
        jobId: locked.id,
        alreadyExists: false,
      };
    });
  } catch (error) {
    if (missingJobCustomerIssueSchema(error)) {
      return { ok: false, error: JOB_CUSTOMER_ISSUE_UNAVAILABLE_MESSAGE };
    }
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const job = await findLiveJobByProjectToken(db, token, {
        id: true,
        businessId: true,
      });
      if (!job) {
        return { ok: false, error: JOB_CUSTOMER_ISSUE_PORTAL_UNAVAILABLE_MESSAGE };
      }
      const existing = await findOpenPortalIssue(db, job.businessId, job.id);
      if (existing) {
        return {
          ok: true,
          issueId: existing.id,
          jobId: job.id,
          alreadyExists: true,
        };
      }
    }
    return { ok: false, error: JOB_CUSTOMER_ISSUE_PORTAL_UNAVAILABLE_MESSAGE };
  }
}

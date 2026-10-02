/**
 * OWNER mutations for structured customer-reported issues on completed jobs.
 *
 * Record / review / decision only. Never writes invoices, jobs, payments,
 * customer messages, or JobCallback rows. Coverage and legal
 * determinations are refused. Owner notes stay off the project token.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { ForbiddenError, requireBusinessRole } from "@/lib/authorization";
import { PROJECT_DOCUMENT_PURPOSE } from "@/lib/business-storage/project-documents";
import {
  JOB_CUSTOMER_ISSUE_ALREADY_OPEN_MESSAGE,
  JOB_CUSTOMER_ISSUE_ATTACHMENT_INVALID_MESSAGE,
  JOB_CUSTOMER_ISSUE_ATTACHMENT_LIMIT_MESSAGE,
  JOB_CUSTOMER_ISSUE_CATEGORY_REQUIRED_MESSAGE,
  JOB_CUSTOMER_ISSUE_COMPLETED_JOB_MESSAGE,
  JOB_CUSTOMER_ISSUE_COVERAGE_REFUSED_MESSAGE,
  JOB_CUSTOMER_ISSUE_DECISION_ALREADY_RECORDED_MESSAGE,
  JOB_CUSTOMER_ISSUE_DECISION_REQUIRED_MESSAGE,
  JOB_CUSTOMER_ISSUE_DESCRIPTION_REQUIRED_MESSAGE,
  JOB_CUSTOMER_ISSUE_JOB_REQUIRED_MESSAGE,
  JOB_CUSTOMER_ISSUE_NOT_REVIEWABLE_MESSAGE,
  JOB_CUSTOMER_ISSUE_OWNER_ONLY_MESSAGE,
  JOB_CUSTOMER_ISSUE_REPORTED_VIA_REQUIRED_MESSAGE,
  JOB_CUSTOMER_ISSUE_UNAVAILABLE_MESSAGE,
  JOB_CUSTOMER_ISSUE_UNKNOWN_MESSAGE,
  JOB_CUSTOMER_ISSUE_OPEN_STATUSES,
  MAX_JOB_CUSTOMER_ISSUE_ATTACHMENTS,
  completedSameBusinessJobEligible,
  isForbiddenIssueCoverageDecision,
  isJobCustomerIssueOpenStatus,
  jobCustomerIssueWriteAllowed,
  missingJobCustomerIssueSchema,
  parseJobCustomerIssueAttachmentIds,
  parseJobCustomerIssueCategory,
  parseJobCustomerIssueDecision,
  parseJobCustomerIssueDescription,
  parseJobCustomerIssueOwnerNotes,
  parseJobCustomerIssuePreferredContact,
  parseJobCustomerIssueReportedVia,
  type JobCustomerIssueDecision,
  type JobCustomerIssueReportedVia,
} from "@/lib/job-customer-issue";
import { lockTenantOwnedJob } from "@/lib/time-card-ops";

type Db = PrismaClient | Prisma.TransactionClient;

export class JobCustomerIssueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobCustomerIssueError";
  }
}

export function jobCustomerIssueErrorMessage(error: unknown, fallback: string) {
  if (error instanceof JobCustomerIssueError) return error.message;
  if (error instanceof ForbiddenError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  if (missingJobCustomerIssueSchema(error)) return JOB_CUSTOMER_ISSUE_UNAVAILABLE_MESSAGE;
  return fallback;
}

/**
 * Test-only barriers. Production never sets these.
 * beforeJobLock runs inside the write transaction before lockTenantOwnedJob
 * so concurrent writers can rendezvous, then contend for FOR UPDATE.
 * afterJobLock runs after the lock is taken.
 */
export const jobCustomerIssueTestHooks: {
  beforeJobLock?: (input: { jobId: string; kind: string }) => Promise<void> | void;
  afterJobLock?: (input: { jobId: string; kind: string }) => Promise<void> | void;
} = {};

function rethrowIssueWriteError(error: unknown): never {
  if (error instanceof JobCustomerIssueError || error instanceof ForbiddenError) {
    throw error;
  }
  if (error instanceof Error && error.name === "ForbiddenError") {
    throw error;
  }
  if (missingJobCustomerIssueSchema(error)) {
    throw new JobCustomerIssueError(JOB_CUSTOMER_ISSUE_UNAVAILABLE_MESSAGE);
  }
  throw error;
}

function requireOwnerIssueWrite(access: BusinessAccess) {
  if (!jobCustomerIssueWriteAllowed(access.workspace.role)) {
    throw new ForbiddenError(JOB_CUSTOMER_ISSUE_OWNER_ONLY_MESSAGE);
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

export async function countBusinessCallbacks(db: Db, businessId: string) {
  return db.jobCallback.count({ where: { businessId } });
}

async function findOpenIssue(db: Db, businessId: string, jobId: string) {
  return db.jobCustomerIssue.findFirst({
    where: {
      businessId,
      jobId,
      customerVisibleStatus: { in: [...JOB_CUSTOMER_ISSUE_OPEN_STATUSES] },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

async function loadOwnedIssue(db: Db, access: BusinessAccess, issueId: string) {
  if (!issueId) {
    throw new JobCustomerIssueError(JOB_CUSTOMER_ISSUE_UNKNOWN_MESSAGE);
  }
  return access.assertOwned(
    await db.jobCustomerIssue.findFirst({
      where: { id: issueId, ...access.scope },
    }),
  );
}

async function requireOwnedLockedJob(
  tx: Prisma.TransactionClient,
  access: BusinessAccess,
  jobId: string,
  kind: string,
) {
  await jobCustomerIssueTestHooks.beforeJobLock?.({ jobId, kind });
  const locked = await lockTenantOwnedJob(tx, access.businessId, jobId);
  if (!locked) {
    throw new JobCustomerIssueError(JOB_CUSTOMER_ISSUE_JOB_REQUIRED_MESSAGE);
  }
  access.assertOwned(locked);
  await jobCustomerIssueTestHooks.afterJobLock?.({ jobId: locked.id, kind });
  return locked;
}

type AttachablePrivateDocument = {
  id: string;
  originalFilename: string;
};

export async function loadAttachablePrivateDocuments(
  db: Db,
  input: { businessId: string; jobId: string },
): Promise<AttachablePrivateDocument[]> {
  return db.storedAsset.findMany({
    where: {
      businessId: input.businessId,
      jobId: input.jobId,
      category: "DOCUMENT",
      purpose: PROJECT_DOCUMENT_PURPOSE,
      visibility: "PRIVATE",
      status: "READY",
      deletedAt: null,
      publicPath: null,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: MAX_JOB_CUSTOMER_ISSUE_ATTACHMENTS,
    select: { id: true, originalFilename: true },
  });
}

async function lockAttachablePrivateDocuments(
  tx: Prisma.TransactionClient,
  input: { businessId: string; jobId: string; storedAssetIds: string[] },
): Promise<AttachablePrivateDocument[]> {
  const ids = parseJobCustomerIssueAttachmentIds(input.storedAssetIds);
  if (ids.length === 0) return [];
  if (ids.length > MAX_JOB_CUSTOMER_ISSUE_ATTACHMENTS) {
    throw new JobCustomerIssueError(JOB_CUSTOMER_ISSUE_ATTACHMENT_LIMIT_MESSAGE);
  }

  const locked = await tx.$queryRaw<AttachablePrivateDocument[]>`
    SELECT id, "originalFilename"
    FROM "StoredAsset"
    WHERE id IN (${Prisma.join(ids)})
      AND "businessId" = ${input.businessId}
      AND "jobId" = ${input.jobId}
      AND category = 'DOCUMENT'
      AND purpose = ${PROJECT_DOCUMENT_PURPOSE}
      AND visibility = 'PRIVATE'
      AND status = 'READY'
      AND "deletedAt" IS NULL
      AND "publicPath" IS NULL
    FOR UPDATE
  `;
  if (locked.length !== ids.length) {
    throw new JobCustomerIssueError(JOB_CUSTOMER_ISSUE_ATTACHMENT_INVALID_MESSAGE);
  }
  const byId = new Map(locked.map((row) => [row.id, row]));
  return ids.map((id) => {
    const row = byId.get(id);
    if (!row) {
      throw new JobCustomerIssueError(JOB_CUSTOMER_ISSUE_ATTACHMENT_INVALID_MESSAGE);
    }
    return row;
  });
}

async function writeIssueAttachments(
  tx: Prisma.TransactionClient,
  input: {
    businessId: string;
    jobId: string;
    issueId: string;
    documents: AttachablePrivateDocument[];
  },
) {
  if (input.documents.length === 0) return;
  await tx.jobCustomerIssueAttachment.createMany({
    data: input.documents.map((document) => ({
      businessId: input.businessId,
      jobId: input.jobId,
      issueId: input.issueId,
      storedAssetId: document.id,
      originalFilename: document.originalFilename,
    })),
  });
}

export async function recordCustomerReportedIssue(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    jobId: string;
    category?: string | null;
    description?: string | null;
    reportedVia?: string | null;
    preferredContact?: string | null;
    storedAssetIds?: readonly string[] | null;
  },
) {
  requireOwnerIssueWrite(access);
  const jobId = input.jobId.trim();
  if (!jobId) {
    throw new JobCustomerIssueError(JOB_CUSTOMER_ISSUE_JOB_REQUIRED_MESSAGE);
  }
  const category = parseJobCustomerIssueCategory(input.category);
  if (!category) {
    throw new JobCustomerIssueError(JOB_CUSTOMER_ISSUE_CATEGORY_REQUIRED_MESSAGE);
  }
  const description = parseJobCustomerIssueDescription(input.description);
  if (!description) {
    throw new JobCustomerIssueError(JOB_CUSTOMER_ISSUE_DESCRIPTION_REQUIRED_MESSAGE);
  }
  const reportedVia = parseJobCustomerIssueReportedVia(input.reportedVia);
  if (!reportedVia) {
    throw new JobCustomerIssueError(JOB_CUSTOMER_ISSUE_REPORTED_VIA_REQUIRED_MESSAGE);
  }
  const preferredContact = parseJobCustomerIssuePreferredContact(input.preferredContact);
  const storedAssetIds = parseJobCustomerIssueAttachmentIds(input.storedAssetIds);
  const actorId = actorMembershipId(access);

  try {
    return await db.$transaction(async (tx) => {
      const locked = await requireOwnedLockedJob(tx, access, jobId, "record");
      if (!completedSameBusinessJobEligible(locked, access.businessId)) {
        throw new JobCustomerIssueError(JOB_CUSTOMER_ISSUE_COMPLETED_JOB_MESSAGE);
      }

      const existing = await findOpenIssue(tx, access.businessId, locked.id);
      if (existing) {
        throw new JobCustomerIssueError(JOB_CUSTOMER_ISSUE_ALREADY_OPEN_MESSAGE);
      }

      const documents = await lockAttachablePrivateDocuments(tx, {
        businessId: access.businessId,
        jobId: locked.id,
        storedAssetIds,
      });

      const created = await tx.jobCustomerIssue.create({
        data: {
          businessId: access.businessId,
          jobId: locked.id,
          customerId: locked.customerId,
          category,
          description,
          reportedVia,
          preferredContact,
          customerVisibleStatus: "RECEIVED",
          recordedByMembershipId: actorId,
        },
      });
      await writeIssueAttachments(tx, {
        businessId: access.businessId,
        jobId: locked.id,
        issueId: created.id,
        documents,
      });
      await tx.jobCustomerIssueEvent.create({
        data: {
          businessId: access.businessId,
          jobId: locked.id,
          issueId: created.id,
          eventType: "RECORDED",
          fromCustomerVisibleStatus: null,
          toCustomerVisibleStatus: "RECEIVED",
          actorMembershipId: actorId,
          payload: eventPayload({
            category,
            reportedVia,
            descriptionLength: description.length,
            attachmentCount: documents.length,
          }),
        },
      });
      return { issue: created, unchanged: false as const };
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new JobCustomerIssueError(JOB_CUSTOMER_ISSUE_ALREADY_OPEN_MESSAGE);
    }
    rethrowIssueWriteError(error);
  }
}

export async function reviewCustomerReportedIssue(
  db: PrismaClient,
  access: BusinessAccess,
  input: { issueId: string; ownerNotes?: string | null },
) {
  requireOwnerIssueWrite(access);
  const ownerNotes = parseJobCustomerIssueOwnerNotes(input.ownerNotes);
  const issue = await loadOwnedIssue(db, access, input.issueId.trim());

  if (issue.customerVisibleStatus === "CLOSED") {
    throw new JobCustomerIssueError(JOB_CUSTOMER_ISSUE_NOT_REVIEWABLE_MESSAGE);
  }
  if (issue.customerVisibleStatus === "IN_REVIEW" && issue.ownerNotes === ownerNotes) {
    return { issue, unchanged: true as const };
  }
  if (
    issue.customerVisibleStatus !== "RECEIVED" &&
    issue.customerVisibleStatus !== "IN_REVIEW"
  ) {
    throw new JobCustomerIssueError(JOB_CUSTOMER_ISSUE_NOT_REVIEWABLE_MESSAGE);
  }

  try {
    return await db.$transaction(async (tx) => {
      const locked = await requireOwnedLockedJob(tx, access, issue.jobId, "review");
      const current = access.assertOwned(
        await tx.jobCustomerIssue.findFirst({
          where: { id: issue.id, businessId: access.businessId },
        }),
      );
      if (current.customerVisibleStatus === "CLOSED") {
        throw new JobCustomerIssueError(JOB_CUSTOMER_ISSUE_NOT_REVIEWABLE_MESSAGE);
      }
      if (
        current.customerVisibleStatus === "IN_REVIEW" &&
        current.ownerNotes === ownerNotes
      ) {
        return { issue: current, unchanged: true as const };
      }
      if (!isJobCustomerIssueOpenStatus(current.customerVisibleStatus)) {
        throw new JobCustomerIssueError(JOB_CUSTOMER_ISSUE_NOT_REVIEWABLE_MESSAGE);
      }

      const now = new Date();
      const fromStatus = current.customerVisibleStatus;
      const write = await tx.jobCustomerIssue.updateMany({
        where: {
          id: current.id,
          businessId: access.businessId,
          customerVisibleStatus: { in: [...JOB_CUSTOMER_ISSUE_OPEN_STATUSES] },
        },
        data: {
          customerVisibleStatus: "IN_REVIEW",
          ownerNotes,
          reviewedAt: current.reviewedAt ?? now,
          reviewedByMembershipId: current.reviewedByMembershipId ?? actorMembershipId(access),
        },
      });
      if (write.count !== 1) {
        throw new JobCustomerIssueError(JOB_CUSTOMER_ISSUE_NOT_REVIEWABLE_MESSAGE);
      }
      if (fromStatus === "RECEIVED") {
        await tx.jobCustomerIssueEvent.create({
          data: {
            businessId: access.businessId,
            jobId: locked.id,
            issueId: current.id,
            eventType: "REVIEWED",
            fromCustomerVisibleStatus: fromStatus,
            toCustomerVisibleStatus: "IN_REVIEW",
            actorMembershipId: actorMembershipId(access),
            payload: eventPayload({ notesLength: ownerNotes.length }),
          },
        });
      }
      return {
        issue: access.assertOwned(
          await tx.jobCustomerIssue.findFirst({
            where: { id: current.id, businessId: access.businessId },
          }),
        ),
        unchanged: false as const,
      };
    });
  } catch (error) {
    rethrowIssueWriteError(error);
  }
}

function sameRecordedDecision(
  issue: { decision: string | null; ownerNotes: string },
  decision: JobCustomerIssueDecision,
  notes: string,
) {
  return issue.decision === decision && issue.ownerNotes === notes;
}

export async function recordCustomerReportedIssueDecision(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    issueId: string;
    decision?: string | null;
    ownerNotes?: string | null;
  },
) {
  requireOwnerIssueWrite(access);
  if (input.decision && isForbiddenIssueCoverageDecision(input.decision)) {
    throw new JobCustomerIssueError(JOB_CUSTOMER_ISSUE_COVERAGE_REFUSED_MESSAGE);
  }
  const decision = parseJobCustomerIssueDecision(input.decision);
  if (!decision) {
    throw new JobCustomerIssueError(JOB_CUSTOMER_ISSUE_DECISION_REQUIRED_MESSAGE);
  }
  const ownerNotes = parseJobCustomerIssueOwnerNotes(input.ownerNotes);
  const issue = await loadOwnedIssue(db, access, input.issueId.trim());

  if (issue.customerVisibleStatus === "CLOSED") {
    if (sameRecordedDecision(issue, decision, ownerNotes)) {
      return { issue, unchanged: true as const };
    }
    throw new JobCustomerIssueError(JOB_CUSTOMER_ISSUE_DECISION_ALREADY_RECORDED_MESSAGE);
  }
  if (!isJobCustomerIssueOpenStatus(issue.customerVisibleStatus)) {
    throw new JobCustomerIssueError(JOB_CUSTOMER_ISSUE_DECISION_ALREADY_RECORDED_MESSAGE);
  }

  try {
    return await db.$transaction(async (tx) => {
      const locked = await requireOwnedLockedJob(tx, access, issue.jobId, "decide");
      const current = access.assertOwned(
        await tx.jobCustomerIssue.findFirst({
          where: { id: issue.id, businessId: access.businessId },
        }),
      );
      if (current.customerVisibleStatus === "CLOSED") {
        if (sameRecordedDecision(current, decision, ownerNotes)) {
          return { issue: current, unchanged: true as const };
        }
        throw new JobCustomerIssueError(JOB_CUSTOMER_ISSUE_DECISION_ALREADY_RECORDED_MESSAGE);
      }
      if (!isJobCustomerIssueOpenStatus(current.customerVisibleStatus)) {
        throw new JobCustomerIssueError(JOB_CUSTOMER_ISSUE_DECISION_ALREADY_RECORDED_MESSAGE);
      }

      const now = new Date();
      const fromStatus = current.customerVisibleStatus;
      const write = await tx.jobCustomerIssue.updateMany({
        where: {
          id: current.id,
          businessId: access.businessId,
          customerVisibleStatus: { in: [...JOB_CUSTOMER_ISSUE_OPEN_STATUSES] },
        },
        data: {
          customerVisibleStatus: "CLOSED",
          decision,
          ownerNotes,
          decidedAt: now,
          decidedByMembershipId: actorMembershipId(access),
          reviewedAt: current.reviewedAt ?? now,
          reviewedByMembershipId:
            current.reviewedByMembershipId ?? actorMembershipId(access),
        },
      });
      if (write.count !== 1) {
        const latest = access.assertOwned(
          await tx.jobCustomerIssue.findFirst({
            where: { id: current.id, businessId: access.businessId },
          }),
        );
        if (
          latest.customerVisibleStatus === "CLOSED" &&
          sameRecordedDecision(latest, decision, ownerNotes)
        ) {
          return { issue: latest, unchanged: true as const };
        }
        throw new JobCustomerIssueError(JOB_CUSTOMER_ISSUE_DECISION_ALREADY_RECORDED_MESSAGE);
      }
      await tx.jobCustomerIssueEvent.create({
        data: {
          businessId: access.businessId,
          jobId: locked.id,
          issueId: current.id,
          eventType: "DECIDED",
          fromCustomerVisibleStatus: fromStatus,
          toCustomerVisibleStatus: "CLOSED",
          actorMembershipId: actorMembershipId(access),
          payload: eventPayload({
            decision,
            notesLength: ownerNotes.length,
          }),
        },
      });
      return {
        issue: access.assertOwned(
          await tx.jobCustomerIssue.findFirst({
            where: { id: current.id, businessId: access.businessId },
          }),
        ),
        unchanged: false as const,
      };
    });
  } catch (error) {
    rethrowIssueWriteError(error);
  }
}

export function issueIsOpen(status: string) {
  return isJobCustomerIssueOpenStatus(status);
}

export type { JobCustomerIssueReportedVia };

/**
 * OWNER mutations for customer-reported callbacks on completed jobs.
 *
 * Record / review / outcome only. Never writes invoices, jobs, payments,
 * or customer messages. Coverage and legal determinations are refused.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { ForbiddenError, requireBusinessRole } from "@/lib/authorization";
import { PROJECT_DOCUMENT_PURPOSE } from "@/lib/business-storage/project-documents";
import {
  JOB_CALLBACK_ALREADY_OPEN_MESSAGE,
  JOB_CALLBACK_ATTACHMENT_INVALID_MESSAGE,
  JOB_CALLBACK_ATTACHMENT_LIMIT_MESSAGE,
  JOB_CALLBACK_CATEGORY_INVALID_MESSAGE,
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
  JOB_CALLBACK_UNAVAILABLE_MESSAGE,
  JOB_CALLBACK_UNKNOWN_MESSAGE,
  MAX_JOB_CALLBACK_ATTACHMENTS,
  completedSameBusinessJobEligible,
  isForbiddenCoverageOutcome,
  isJobCallbackOpenStatus,
  jobCallbackWriteAllowed,
  missingJobCallbackIssueSchema,
  parseJobCallbackAttachmentIds,
  parseJobCallbackCategory,
  parseJobCallbackDescription,
  parseJobCallbackOutcome,
  parseJobCallbackOutcomeNotes,
  parseJobCallbackOwnerNotes,
  parseJobCallbackReportedVia,
  type JobCallbackCategory,
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
  if (missingJobCallbackIssueSchema(error)) return JOB_CALLBACK_UNAVAILABLE_MESSAGE;
  return fallback;
}

/**
 * Test-only barriers. Production never sets these.
 * beforeJobLock runs inside the write transaction before lockTenantOwnedJob
 * so concurrent writers can rendezvous, then contend for FOR UPDATE.
 * afterJobLock runs after the lock is taken.
 */
export const jobCallbackTestHooks: {
  beforeJobLock?: (input: { jobId: string; kind: string }) => Promise<void> | void;
  afterJobLock?: (input: { jobId: string; kind: string }) => Promise<void> | void;
} = {};

function rethrowCallbackWriteError(
  error: unknown,
  usedIssueExtensions = false,
): never {
  if (error instanceof JobCallbackError || error instanceof ForbiddenError) {
    throw error;
  }
  if (error instanceof Error && error.name === "ForbiddenError") {
    throw error;
  }
  if (usedIssueExtensions && missingJobCallbackIssueSchema(error)) {
    throw new JobCallbackError(JOB_CALLBACK_UNAVAILABLE_MESSAGE);
  }
  throw error;
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

export const JOB_CALLBACK_CORE_SELECT = {
  id: true,
  businessId: true,
  jobId: true,
  customerId: true,
  description: true,
  reportedVia: true,
  status: true,
  outcome: true,
  outcomeNotes: true,
  recordedByMembershipId: true,
  reviewedByMembershipId: true,
  outcomeByMembershipId: true,
  recordedAt: true,
  reviewedAt: true,
  outcomeAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

async function findOpenCallback(db: Db, businessId: string, jobId: string) {
  return db.jobCallback.findFirst({
    where: {
      businessId,
      jobId,
      status: { in: ["RECORDED", "UNDER_REVIEW"] },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: JOB_CALLBACK_CORE_SELECT,
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
  const row = await db.jobCallback.findFirst({
    where: { id: callbackId, ...access.scope },
    select: JOB_CALLBACK_CORE_SELECT,
  });
  if (!row) {
    throw new JobCallbackError(JOB_CALLBACK_UNKNOWN_MESSAGE);
  }
  return access.assertOwned(row);
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
    take: MAX_JOB_CALLBACK_ATTACHMENTS,
    select: { id: true, originalFilename: true },
  });
}

async function lockAttachablePrivateDocuments(
  tx: Prisma.TransactionClient,
  input: { businessId: string; jobId: string; storedAssetIds: string[] },
): Promise<AttachablePrivateDocument[]> {
  const ids = parseJobCallbackAttachmentIds(input.storedAssetIds);
  if (ids.length === 0) return [];
  if (ids.length > MAX_JOB_CALLBACK_ATTACHMENTS) {
    throw new JobCallbackError(JOB_CALLBACK_ATTACHMENT_LIMIT_MESSAGE);
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
    throw new JobCallbackError(JOB_CALLBACK_ATTACHMENT_INVALID_MESSAGE);
  }
  const byId = new Map(locked.map((row) => [row.id, row]));
  return ids.map((id) => {
    const row = byId.get(id);
    if (!row) {
      throw new JobCallbackError(JOB_CALLBACK_ATTACHMENT_INVALID_MESSAGE);
    }
    return row;
  });
}

async function writeCallbackAttachments(
  tx: Prisma.TransactionClient,
  input: {
    businessId: string;
    jobId: string;
    callbackId: string;
    documents: AttachablePrivateDocument[];
  },
) {
  if (input.documents.length === 0) return;
  await tx.jobCallbackAttachment.createMany({
    data: input.documents.map((document) => ({
      businessId: input.businessId,
      jobId: input.jobId,
      callbackId: input.callbackId,
      storedAssetId: document.id,
      originalFilename: document.originalFilename,
    })),
  });
}

async function applyCallbackIssueFields(
  tx: Prisma.TransactionClient,
  callbackId: string,
  fields: { category?: JobCallbackCategory | null; ownerNotes?: string },
) {
  const data: { category?: string; ownerNotes?: string } = {};
  if (fields.category) data.category = fields.category;
  if (fields.ownerNotes) data.ownerNotes = fields.ownerNotes;
  if (Object.keys(data).length === 0) return;
  await tx.jobCallback.update({
    where: { id: callbackId },
    data,
    select: JOB_CALLBACK_CORE_SELECT,
  });
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
    category?: string | null;
    ownerNotes?: string | null;
    storedAssetIds?: readonly string[] | null;
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
  const category = parseJobCallbackCategory(input.category);
  if (input.category?.trim() && !category) {
    throw new JobCallbackError(JOB_CALLBACK_CATEGORY_INVALID_MESSAGE);
  }
  const ownerNotes = parseJobCallbackOwnerNotes(input.ownerNotes);
  const storedAssetIds = parseJobCallbackAttachmentIds(input.storedAssetIds);
  const usedIssueExtensions = Boolean(category || ownerNotes || storedAssetIds.length);

  try {
    return await db.$transaction(async (tx) => {
      await jobCallbackTestHooks.beforeJobLock?.({ jobId, kind: "record" });
      const locked = await lockTenantOwnedJob(tx, access.businessId, jobId);
      if (!locked) {
        throw new JobCallbackError(JOB_CALLBACK_JOB_REQUIRED_MESSAGE);
      }
      access.assertOwned(locked);
      await jobCallbackTestHooks.afterJobLock?.({ jobId: locked.id, kind: "record" });
      if (!completedSameBusinessJobEligible(locked, access.businessId)) {
        throw new JobCallbackError(JOB_CALLBACK_COMPLETED_JOB_MESSAGE);
      }

      const existing = await findOpenCallback(tx, access.businessId, locked.id);
      if (existing) {
        throw new JobCallbackError(JOB_CALLBACK_ALREADY_OPEN_MESSAGE);
      }

      const documents = await lockAttachablePrivateDocuments(tx, {
        businessId: access.businessId,
        jobId: locked.id,
        storedAssetIds,
      });

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
        select: JOB_CALLBACK_CORE_SELECT,
      });
      if (category || ownerNotes) {
        await applyCallbackIssueFields(tx, created.id, { category, ownerNotes });
      }
      if (documents.length > 0) {
        await writeCallbackAttachments(tx, {
          businessId: access.businessId,
          jobId: locked.id,
          callbackId: created.id,
          documents,
        });
      }
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
            ...(category ? { category } : {}),
            ...(documents.length > 0 ? { attachmentCount: documents.length } : {}),
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
    rethrowCallbackWriteError(error, usedIssueExtensions);
  }
}

export async function reviewCustomerReportedCallback(
  db: PrismaClient,
  access: BusinessAccess,
  input: { callbackId: string; ownerNotes?: string | null },
) {
  requireOwnerCallbackWrite(access);
  const ownerNotes = parseJobCallbackOwnerNotes(input.ownerNotes);
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

  try {
    return await db.$transaction(async (tx) => {
      await jobCallbackTestHooks.beforeJobLock?.({ jobId: callback.jobId, kind: "review" });
      const locked = await lockTenantOwnedJob(tx, access.businessId, callback.jobId);
      if (!locked || locked.businessId !== access.businessId) {
        throw new JobCallbackError(JOB_CALLBACK_JOB_REQUIRED_MESSAGE);
      }
      await jobCallbackTestHooks.afterJobLock?.({ jobId: locked.id, kind: "review" });
      const current = access.assertOwned(
        await tx.jobCallback.findFirst({
          where: { id: callback.id, businessId: access.businessId },
          select: JOB_CALLBACK_CORE_SELECT,
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
            select: JOB_CALLBACK_CORE_SELECT,
          }),
        );
        if (latest.status === "UNDER_REVIEW") {
          return { callback: latest, unchanged: true as const };
        }
        throw new JobCallbackError(JOB_CALLBACK_NOT_REVIEWABLE_MESSAGE);
      }
      if (ownerNotes) {
        await applyCallbackIssueFields(tx, current.id, { ownerNotes });
      }
      await tx.jobCallbackEvent.create({
        data: {
          businessId: access.businessId,
          callbackId: current.id,
          eventType: "REVIEWED",
          fromStatus: "RECORDED",
          toStatus: "UNDER_REVIEW",
          actorMembershipId: actorMembershipId(access),
          ...(ownerNotes
            ? { payload: eventPayload({ notesLength: ownerNotes.length }) }
            : {}),
        },
      });
      return {
        callback: access.assertOwned(
          await tx.jobCallback.findFirst({
            where: { id: current.id, businessId: access.businessId },
            select: JOB_CALLBACK_CORE_SELECT,
          }),
        ),
        unchanged: false as const,
      };
    });
  } catch (error) {
    rethrowCallbackWriteError(error, Boolean(ownerNotes));
  }
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
    ownerNotes?: string | null;
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
  const ownerNotes = parseJobCallbackOwnerNotes(input.ownerNotes);
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

  try {
    return await db.$transaction(async (tx) => {
      await jobCallbackTestHooks.beforeJobLock?.({ jobId: callback.jobId, kind: "outcome" });
      const locked = await lockTenantOwnedJob(tx, access.businessId, callback.jobId);
      if (!locked || locked.businessId !== access.businessId) {
        throw new JobCallbackError(JOB_CALLBACK_JOB_REQUIRED_MESSAGE);
      }
      await jobCallbackTestHooks.afterJobLock?.({ jobId: locked.id, kind: "outcome" });
      const current = access.assertOwned(
        await tx.jobCallback.findFirst({
          where: { id: callback.id, businessId: access.businessId },
          select: JOB_CALLBACK_CORE_SELECT,
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
            select: JOB_CALLBACK_CORE_SELECT,
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
      if (ownerNotes) {
        await applyCallbackIssueFields(tx, current.id, { ownerNotes });
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
            ...(ownerNotes ? { ownerNotesLength: ownerNotes.length } : {}),
          }),
        },
      });
      return {
        callback: access.assertOwned(
          await tx.jobCallback.findFirst({
            where: { id: current.id, businessId: access.businessId },
            select: JOB_CALLBACK_CORE_SELECT,
          }),
        ),
        unchanged: false as const,
      };
    });
  } catch (error) {
    rethrowCallbackWriteError(error, Boolean(ownerNotes));
  }
}

export function callbackIsOpen(status: string) {
  return isJobCallbackOpenStatus(status);
}

export type { JobCallbackReportedVia, JobCallbackOutcome };

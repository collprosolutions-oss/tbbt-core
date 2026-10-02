/**
 * OWNER mutations for private project-document review.
 *
 * Locks the StoredAsset row, then conditionally claims the decision so
 * simultaneous reviews cannot overwrite each other. Never writes
 * invoices, payments, publicPath, visibility, or customer messages.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { ForbiddenError, requireBusinessRole } from "@/lib/authorization";
import { PROJECT_DOCUMENT_PURPOSE } from "@/lib/business-storage/project-documents";
import {
  PROJECT_DOCUMENT_REVIEW_CONFLICT_MESSAGE,
  PROJECT_DOCUMENT_REVIEW_NOT_PRIVATE_MESSAGE,
  PROJECT_DOCUMENT_REVIEW_OWNER_ONLY_MESSAGE,
  PROJECT_DOCUMENT_REVIEW_STATUS_REQUIRED_MESSAGE,
  PROJECT_DOCUMENT_REVIEW_UNAVAILABLE_MESSAGE,
  PROJECT_DOCUMENT_REVIEW_UNKNOWN_MESSAGE,
  isProjectDocumentReviewStatus,
  missingProjectDocumentReviewSchema,
  normalizeExpectedProjectDocumentReviewStatus,
  parseProjectDocumentReviewReason,
  projectDocumentReviewWriteAllowed,
  recordedProjectDocumentReviewLabel,
  type ProjectDocumentReviewStatus,
  type RecordedProjectDocumentReview,
} from "@/lib/project-document-review";

type Db = PrismaClient | Prisma.TransactionClient;

export class ProjectDocumentReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectDocumentReviewError";
  }
}

export function projectDocumentReviewErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ProjectDocumentReviewError) return error.message;
  if (error instanceof ForbiddenError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  if (missingProjectDocumentReviewSchema(error)) {
    return PROJECT_DOCUMENT_REVIEW_UNAVAILABLE_MESSAGE;
  }
  return fallback;
}

/**
 * Test-only barriers. Production never sets these.
 * afterAssetLock runs inside the write transaction immediately after
 * the StoredAsset FOR UPDATE lock and before the decision claim.
 */
export const projectDocumentReviewTestHooks: {
  afterAssetLock?: (input: { storedAssetId: string }) => Promise<void> | void;
} = {};

function requireOwnerReviewWrite(access: BusinessAccess) {
  if (!projectDocumentReviewWriteAllowed(access.workspace.role)) {
    throw new ForbiddenError(PROJECT_DOCUMENT_REVIEW_OWNER_ONLY_MESSAGE);
  }
  requireBusinessRole(access, "OWNER");
}

function actorMembershipId(access: BusinessAccess) {
  return access.workspace.membership.id;
}

function rethrowReviewWriteError(error: unknown): never {
  if (
    error instanceof ProjectDocumentReviewError ||
    error instanceof ForbiddenError
  ) {
    throw error;
  }
  if (error instanceof Error && error.name === "ForbiddenError") {
    throw error;
  }
  if (missingProjectDocumentReviewSchema(error)) {
    throw new ProjectDocumentReviewError(PROJECT_DOCUMENT_REVIEW_UNAVAILABLE_MESSAGE);
  }
  throw error;
}

function asRecorded(
  row: {
    storedAssetId: string;
    status: string;
    reason: string | null;
    decidedAt: Date;
  },
): RecordedProjectDocumentReview {
  const status = row.status as ProjectDocumentReviewStatus;
  return {
    storedAssetId: row.storedAssetId,
    status,
    statusLabel: recordedProjectDocumentReviewLabel(status),
    reason: row.reason,
    decidedAt: row.decidedAt,
  };
}

function sameDecision(
  existing: { status: string; reason: string | null },
  status: ProjectDocumentReviewStatus,
  reason: string | null,
) {
  return existing.status === status && (existing.reason ?? null) === reason;
}

type LockedProjectDocument = {
  id: string;
  businessId: string;
  jobId: string | null;
  category: string;
  purpose: string | null;
  visibility: string;
  publicPath: string | null;
  status: string;
  deletedAt: Date | null;
};

async function lockOwnedPrivateProjectDocument(
  tx: Prisma.TransactionClient,
  access: BusinessAccess,
  input: { storedAssetId: string; jobId: string },
) {
  const rows = await tx.$queryRaw<LockedProjectDocument[]>`
    SELECT id, "businessId", "jobId", category, purpose, visibility,
           "publicPath", status, "deletedAt"
    FROM "StoredAsset"
    WHERE id = ${input.storedAssetId}
      AND "businessId" = ${access.businessId}
      AND "jobId" = ${input.jobId}
    FOR UPDATE
  `;
  const asset = rows[0];
  if (!asset) {
    throw new ProjectDocumentReviewError(PROJECT_DOCUMENT_REVIEW_UNKNOWN_MESSAGE);
  }
  access.assertOwned(asset);
  await projectDocumentReviewTestHooks.afterAssetLock?.({
    storedAssetId: asset.id,
  });
  if (
    asset.deletedAt != null ||
    asset.status !== "READY" ||
    asset.category !== "DOCUMENT" ||
    asset.purpose !== PROJECT_DOCUMENT_PURPOSE ||
    asset.visibility !== "PRIVATE" ||
    asset.publicPath ||
    asset.jobId !== input.jobId
  ) {
    throw new ProjectDocumentReviewError(PROJECT_DOCUMENT_REVIEW_NOT_PRIVATE_MESSAGE);
  }
  return asset;
}

export async function countBusinessInvoices(db: Db, businessId: string) {
  return db.invoice.count({ where: { businessId } });
}

export async function countBusinessJobs(db: Db, businessId: string) {
  return db.job.count({ where: { businessId } });
}

export async function countBusinessCommunications(db: Db, businessId: string) {
  return db.customerCommunication.count({ where: { businessId } });
}

export async function recordProjectDocumentReview(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    jobId: string;
    storedAssetId: string;
    status: string;
    reason?: string | null;
    expectedStatus?: string | null;
  },
) {
  requireOwnerReviewWrite(access);
  const jobId = input.jobId.trim();
  const storedAssetId = input.storedAssetId.trim();
  if (!jobId || !storedAssetId) {
    throw new ProjectDocumentReviewError(PROJECT_DOCUMENT_REVIEW_UNKNOWN_MESSAGE);
  }
  if (!isProjectDocumentReviewStatus(input.status)) {
    throw new ProjectDocumentReviewError(
      PROJECT_DOCUMENT_REVIEW_STATUS_REQUIRED_MESSAGE,
    );
  }
  const status = input.status;
  const reason = parseProjectDocumentReviewReason(input.reason);
  const expectedStatus = normalizeExpectedProjectDocumentReviewStatus(
    input.expectedStatus,
  );
  const actorId = actorMembershipId(access);

  try {
    return await db.$transaction(async (tx) => {
      const asset = await lockOwnedPrivateProjectDocument(tx, access, {
        storedAssetId,
        jobId,
      });
      const existing = await tx.projectDocumentReview.findFirst({
        where: {
          storedAssetId: asset.id,
          businessId: access.businessId,
          jobId: asset.jobId ?? jobId,
        },
      });

      if (existing && sameDecision(existing, status, reason)) {
        return { review: asRecorded(existing), unchanged: true as const };
      }

      if (expectedStatus !== undefined) {
        const current = existing?.status ?? "";
        if (expectedStatus !== current) {
          throw new ProjectDocumentReviewError(
            PROJECT_DOCUMENT_REVIEW_CONFLICT_MESSAGE,
          );
        }
      } else if (existing) {
        throw new ProjectDocumentReviewError(
          PROJECT_DOCUMENT_REVIEW_CONFLICT_MESSAGE,
        );
      }

      const now = new Date();
      if (!existing) {
        try {
          const created = await tx.projectDocumentReview.create({
            data: {
              businessId: access.businessId,
              jobId,
              storedAssetId: asset.id,
              status,
              reason,
              decidedByMembershipId: actorId,
              decidedAt: now,
            },
          });
          return { review: asRecorded(created), unchanged: false as const };
        } catch (error) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002"
          ) {
            const raced = await tx.projectDocumentReview.findFirst({
              where: {
                storedAssetId: asset.id,
                businessId: access.businessId,
              },
            });
            if (raced && sameDecision(raced, status, reason)) {
              return { review: asRecorded(raced), unchanged: true as const };
            }
            throw new ProjectDocumentReviewError(
              PROJECT_DOCUMENT_REVIEW_CONFLICT_MESSAGE,
            );
          }
          throw error;
        }
      }

      const owned = access.assertOwned(existing);
      const claimed = await tx.projectDocumentReview.updateMany({
        where: {
          id: owned.id,
          businessId: access.businessId,
          storedAssetId: asset.id,
          status: owned.status,
          decidedAt: owned.decidedAt,
        },
        data: {
          status,
          reason,
          decidedByMembershipId: actorId,
          decidedAt: now,
        },
      });
      if (claimed.count !== 1) {
        throw new ProjectDocumentReviewError(
          PROJECT_DOCUMENT_REVIEW_CONFLICT_MESSAGE,
        );
      }
      const updated = await tx.projectDocumentReview.findFirst({
        where: { id: owned.id, businessId: access.businessId },
      });
      if (!updated) {
        throw new ProjectDocumentReviewError(PROJECT_DOCUMENT_REVIEW_UNKNOWN_MESSAGE);
      }
      return {
        review: asRecorded(access.assertOwned(updated)),
        unchanged: false as const,
      };
    });
  } catch (error) {
    rethrowReviewWriteError(error);
  }
}

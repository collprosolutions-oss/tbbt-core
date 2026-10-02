/**
 * Customer Project Portal documents on the existing private R2
 * authorize → PUT → finalize path. Authorization is the Job's own
 * unguessable projectToken — never a client-supplied businessId or jobId.
 *
 * Retired or revoked project tokens are refused by the live-token
 * resolver. Authorize and finalize both lock the Job and re-check the
 * live token before writing. Upload stores a PRIVATE DOCUMENT. It does
 * not approve, publish, message, invoice, or change Job status.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  abortManagedUpload,
  authorizeManagedUpload,
  finalizeManagedUpload,
  resolveStorageProvider,
  type StorageServiceDeps,
} from "@/lib/business-storage/service";
import {
  inspectProjectDocumentUpload,
  PROJECT_DOCUMENT_TYPE_MISMATCH,
  projectDocumentBytesMatchMime,
} from "@/lib/business-storage/project-document-rules";
import { privateAssetPath } from "@/lib/business-storage/keys";
import {
  PROJECT_DOCUMENT_MAX_COUNT,
  PROJECT_DOCUMENT_MAX_BYTES,
  StorageAccessError,
  StorageError,
} from "@/lib/business-storage/types";
import {
  missingProjectDocumentReviewSchema,
  recordedProjectDocumentReviewLabel,
} from "@/lib/project-document-review";
import {
  assertLiveLockedProjectToken,
  findLiveJobByProjectToken,
} from "@/lib/project-link-data";

export const PROJECT_DOCUMENT_PURPOSE = "project-portal-document";
export const PROJECT_DOCUMENT_RECEIVED_COPY = "Received. Private to the business.";
export { PROJECT_DOCUMENT_MAX_BYTES, PROJECT_DOCUMENT_MAX_COUNT };

export {
  inspectProjectDocumentUpload,
  isProjectDocumentMimeType,
  projectDocumentMaxBytesLabel,
  resolveProjectDocumentMimeType,
  sanitizeProjectDocumentFilename,
  projectDocumentBytesMatchMime,
  PROJECT_DOCUMENT_TYPE_MISMATCH,
} from "@/lib/business-storage/project-document-rules";

const PROJECT_LINK_UNAVAILABLE = "This project link is not available.";
const PROJECT_CLOSED = "This project is closed and is not accepting documents.";
const NOT_PRIVATE_PROJECT_DOCUMENT = "That file is not a private project document.";
const DOCUMENT_CANNOT_BE_PUBLISHED = "Project documents cannot be published.";
const DOCUMENT_LIMIT_REACHED = `You can add up to ${PROJECT_DOCUMENT_MAX_COUNT} documents for this project.`;

const CLOSED_OR_CANCELLED_JOB_STATUSES = new Set(["CANCELLED", "CLOSED", "COMPLETED"]);

/**
 * Test-only barriers. Production never sets these.
 * afterJobLock runs inside authorize's beforeCreate and finalize's
 * beforeClaim immediately after lockJobForProjectDocument (Job FOR UPDATE)
 * and before the live-token re-check. The default is undefined, so
 * production is a no-op.
 */
export const projectDocumentTestHooks: {
  afterJobLock?: (input?: { phase?: "authorize" | "finalize" }) => Promise<void> | void;
} = {};

type Db = PrismaClient | Prisma.TransactionClient;

type ProjectTokenJob = {
  id: string;
  businessId: string;
  customerId: string | null;
  propertyId: string | null;
  status: string;
  projectToken: string;
};

function isClosedOrCancelledJobStatus(status: string) {
  return CLOSED_OR_CANCELLED_JOB_STATUSES.has(status.trim().toUpperCase());
}

export function isProjectDocumentUploadOpen(status: string) {
  return !isClosedOrCancelledJobStatus(status);
}

/**
 * Completed / closed jobs still show already-received private document
 * receipts. Upload stays closed. Missing storage still lists receipts.
 */
export function shouldShowProjectDocumentsCard(
  status: string,
  documentCount: number,
  storageConfigured = true,
) {
  const recorded = Number.isFinite(documentCount)
    ? Math.max(0, Math.floor(documentCount))
    : 0;
  if (recorded > 0) return true;
  return storageConfigured && isProjectDocumentUploadOpen(status);
}

function isPrivateUnpublishedProjectDocument(asset: {
  category: string;
  purpose: string | null;
  visibility: string;
  publicPath: string | null;
  deletedAt: Date | null;
  status: string;
  jobId: string | null;
}) {
  return (
    asset.deletedAt == null &&
    asset.status !== "DELETED" &&
    asset.category === "DOCUMENT" &&
    asset.purpose === PROJECT_DOCUMENT_PURPOSE &&
    asset.visibility === "PRIVATE" &&
    !asset.publicPath &&
    Boolean(asset.jobId)
  );
}

async function findJobByProjectToken(db: Db, token: string) {
  return findLiveJobByProjectToken(db, token, {
    id: true,
    businessId: true,
    customerId: true,
    propertyId: true,
    status: true,
    projectToken: true,
  });
}

async function requireJobByProjectToken(db: Db, token: string): Promise<ProjectTokenJob> {
  const job = await findJobByProjectToken(db, token);
  if (!job) {
    throw new StorageAccessError(PROJECT_LINK_UNAVAILABLE);
  }
  if (isClosedOrCancelledJobStatus(job.status)) {
    throw new StorageAccessError(PROJECT_CLOSED);
  }
  return job;
}

async function lockJobForProjectDocument(
  tx: Prisma.TransactionClient,
  job: ProjectTokenJob,
) {
  const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
    SELECT id, status
    FROM "Job"
    WHERE id = ${job.id}
      AND "businessId" = ${job.businessId}
      AND "projectToken" = ${job.projectToken}
    FOR UPDATE
  `;
  const row = locked[0];
  if (!row) {
    throw new StorageAccessError(PROJECT_LINK_UNAVAILABLE);
  }
  if (isClosedOrCancelledJobStatus(row.status)) {
    throw new StorageAccessError(PROJECT_CLOSED);
  }
  return row;
}

async function projectDocumentIdsNeedingReplacement(
  db: Db,
  input: { businessId: string; jobId: string },
) {
  // Presence probe only. A Prisma findMany P2021 aborts an open Postgres
  // transaction (25P02), so authorize's beforeCreate cannot recover.
  const probe = await db.$queryRaw<Array<{ present: boolean }>>`SELECT to_regclass('"ProjectDocumentReview"') IS NOT NULL AS present`;
  if (!probe[0]?.present) return [];
  try {
    const rows = await db.projectDocumentReview.findMany({
      where: {
        businessId: input.businessId,
        jobId: input.jobId,
        status: "NEEDS_REPLACEMENT",
      },
      select: { storedAssetId: true },
    });
    return rows.map((row) => row.storedAssetId);
  } catch (error) {
    if (missingProjectDocumentReviewSchema(error)) return [];
    throw error;
  }
}

export async function countActiveProjectDocuments(
  db: Db,
  input: { businessId: string; jobId: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const needingReplacement = await projectDocumentIdsNeedingReplacement(db, input);
  return db.storedAsset.count({
    where: {
      businessId: input.businessId,
      jobId: input.jobId,
      category: "DOCUMENT",
      purpose: PROJECT_DOCUMENT_PURPOSE,
      visibility: "PRIVATE",
      deletedAt: null,
      ...(needingReplacement.length > 0
        ? { id: { notIn: needingReplacement } }
        : {}),
      OR: [
        { status: "READY" },
        {
          status: "PENDING",
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
      ],
    },
  });
}

export function remainingProjectDocumentSlots(activeCount: number) {
  const recorded = Number.isFinite(activeCount) ? Math.max(0, Math.floor(activeCount)) : 0;
  return Math.max(0, PROJECT_DOCUMENT_MAX_COUNT - recorded);
}

export async function authorizeProjectTokenDocument(
  deps: StorageServiceDeps,
  token: string,
  input: { originalFilename: string; mimeType: string; fileSizeBytes: number },
) {
  const job = await requireJobByProjectToken(deps.db, token);
  const inspection = inspectProjectDocumentUpload({
    type: input.mimeType,
    name: input.originalFilename,
    size: input.fileSizeBytes,
  });
  if (!inspection.ok) {
    throw new StorageError(inspection.error);
  }

  const now = deps.now?.() ?? new Date();
  return authorizeManagedUpload(
    deps,
    job.businessId,
    {
      category: "DOCUMENT",
      purpose: PROJECT_DOCUMENT_PURPOSE,
      originalFilename: inspection.fileName,
      mimeType: inspection.mimeType,
      fileSizeBytes: inspection.fileSizeBytes,
      visibility: "PRIVATE",
      jobId: job.id,
      customerId: job.customerId,
      propertyId: job.propertyId,
    },
    {
      async beforeCreate(tx) {
        await lockJobForProjectDocument(tx, job);
        await projectDocumentTestHooks.afterJobLock?.({ phase: "authorize" });
        if (
          !(await assertLiveLockedProjectToken(tx, {
            jobId: job.id,
            businessId: job.businessId,
            token: job.projectToken,
          }))
        ) {
          throw new StorageAccessError(PROJECT_LINK_UNAVAILABLE);
        }
        const active = await countActiveProjectDocuments(tx, {
          businessId: job.businessId,
          jobId: job.id,
          now,
        });
        if (remainingProjectDocumentSlots(active) <= 0) {
          throw new StorageError(DOCUMENT_LIMIT_REACHED);
        }
      },
    },
  );
}

export async function finalizeProjectTokenDocument(
  deps: StorageServiceDeps,
  token: string,
  assetId: string,
) {
  const job = await requireJobByProjectToken(deps.db, token);
  const candidate = await deps.db.storedAsset.findFirst({
    where: {
      id: assetId,
      businessId: job.businessId,
      jobId: job.id,
    },
  });
  if (!candidate) {
    throw new StorageAccessError(NOT_PRIVATE_PROJECT_DOCUMENT);
  }
  if (candidate.publicPath) {
    throw new StorageError(DOCUMENT_CANNOT_BE_PUBLISHED);
  }
  if (!isPrivateUnpublishedProjectDocument(candidate)) {
    throw new StorageError(NOT_PRIVATE_PROJECT_DOCUMENT);
  }
  if (candidate.status === "READY") {
    return candidate;
  }

  const now = deps.now?.() ?? new Date();
  if (
    candidate.status !== "PENDING" ||
    (candidate.expiresAt != null && candidate.expiresAt.getTime() <= now.getTime())
  ) {
    throw new StorageError(NOT_PRIVATE_PROJECT_DOCUMENT);
  }

  const account = await deps.db.businessStorageAccount.findUniqueOrThrow({
    where: { id: candidate.storageAccountId },
  });
  const provider = await resolveStorageProvider(deps);
  const object = await provider.getObject({
    bucket: account.bucketName,
    key: candidate.storageKey,
  });
  if (!object || object.body.byteLength <= 0) {
    throw new StorageError("The file was not found in storage. Upload it again.");
  }
  if (!projectDocumentBytesMatchMime(candidate.mimeType, object.body)) {
    await abortManagedUpload(deps, job.businessId, candidate.id);
    throw new StorageError(PROJECT_DOCUMENT_TYPE_MISMATCH);
  }

  const asset = await finalizeManagedUpload(deps, job.businessId, assetId, {
    async beforeClaim(tx) {
      await lockJobForProjectDocument(tx, job);
      await projectDocumentTestHooks.afterJobLock?.({ phase: "finalize" });
      if (
        !(await assertLiveLockedProjectToken(tx, {
          jobId: job.id,
          businessId: job.businessId,
          token,
        }))
      ) {
        throw new StorageAccessError(PROJECT_LINK_UNAVAILABLE);
      }
    },
  });
  if (
    !isPrivateUnpublishedProjectDocument(asset) ||
    asset.jobId !== job.id ||
    asset.businessId !== job.businessId
  ) {
    throw new StorageError(NOT_PRIVATE_PROJECT_DOCUMENT);
  }
  return asset;
}

export async function abortProjectTokenDocument(
  deps: StorageServiceDeps,
  token: string,
  assetId: string,
) {
  const job = await requireJobByProjectToken(deps.db, token);
  const pending = await deps.db.storedAsset.findFirst({
    where: {
      id: assetId,
      businessId: job.businessId,
      jobId: job.id,
      category: "DOCUMENT",
      purpose: PROJECT_DOCUMENT_PURPOSE,
      visibility: "PRIVATE",
      status: "PENDING",
    },
    select: { id: true },
  });
  if (!pending) {
    throw new StorageAccessError(NOT_PRIVATE_PROJECT_DOCUMENT);
  }
  return abortManagedUpload(deps, job.businessId, pending.id);
}

export async function putProjectTokenDocumentFromBytes(
  deps: StorageServiceDeps,
  token: string,
  input: {
    originalFilename: string;
    mimeType: string;
    body: Buffer | Uint8Array;
  },
) {
  const authorized = await authorizeProjectTokenDocument(deps, token, {
    originalFilename: input.originalFilename,
    mimeType: input.mimeType,
    fileSizeBytes: input.body.byteLength,
  });
  const provider = await resolveStorageProvider(deps);
  try {
    await provider.putObject({
      bucket: authorized.account.bucketName,
      key: authorized.asset.storageKey,
      body: input.body,
      contentType: input.mimeType,
    });
    return finalizeProjectTokenDocument(deps, token, authorized.asset.id);
  } catch (error) {
    await abortProjectTokenDocument(deps, token, authorized.asset.id).catch(() => undefined);
    throw error;
  }
}

const PROJECT_DOCUMENT_SELECT = {
  id: true,
  originalFilename: true,
  mimeType: true,
  fileSizeBytes: true,
  createdAt: true,
  visibility: true,
  publicPath: true,
  status: true,
  jobId: true,
  businessId: true,
} as const;

export type ProjectDocumentReviewFields = {
  reviewStatus: string | null;
  reviewStatusLabel: string;
  reviewReason: string | null;
  decidedAt: Date | null;
};

export type ProjectDocumentReviewItem = {
  id: string;
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
  createdAt: Date;
  reviewHref: string;
} & ProjectDocumentReviewFields;

function emptyReviewFields(): ProjectDocumentReviewFields {
  return {
    reviewStatus: null,
    reviewStatusLabel: recordedProjectDocumentReviewLabel(null),
    reviewReason: null,
    decidedAt: null,
  };
}

function toReviewFields(review?: {
  status: string;
  reason: string | null;
  decidedAt: Date;
} | null): ProjectDocumentReviewFields {
  if (!review) return emptyReviewFields();
  return {
    reviewStatus: review.status,
    reviewStatusLabel: recordedProjectDocumentReviewLabel(review.status),
    reviewReason: review.reason,
    decidedAt: review.decidedAt,
  };
}

function toReviewItem(
  asset: {
    id: string;
    originalFilename: string;
    mimeType: string;
    fileSizeBytes: number;
    createdAt: Date;
  },
  review?: {
    status: string;
    reason: string | null;
    decidedAt: Date;
  } | null,
): ProjectDocumentReviewItem {
  return {
    id: asset.id,
    originalFilename: asset.originalFilename,
    mimeType: asset.mimeType,
    fileSizeBytes: asset.fileSizeBytes,
    createdAt: asset.createdAt,
    reviewHref: privateAssetPath(asset.id),
    ...toReviewFields(review),
  };
}

export type ProjectDocumentReceiptItem = {
  id: string;
  originalFilename: string;
  fileSizeBytes: number;
  createdAt: Date;
} & ProjectDocumentReviewFields;

async function loadProjectDocumentReviewsByAssetId(
  db: Db,
  input: { businessId: string; jobId: string; storedAssetIds: string[] },
) {
  if (input.storedAssetIds.length === 0) {
    return new Map<
      string,
      { status: string; reason: string | null; decidedAt: Date }
    >();
  }
  // Stale Prisma clients (next-dev started before generate) have no
  // projectDocumentReview delegate. Receipts still list; review status
  // is omitted instead of 500ing the completed-job portal.
  const reviewDelegate = (db as { projectDocumentReview?: typeof db.projectDocumentReview })
    .projectDocumentReview;
  if (!reviewDelegate) {
    return new Map<
      string,
      { status: string; reason: string | null; decidedAt: Date }
    >();
  }
  try {
    const rows = await reviewDelegate.findMany({
      where: {
        businessId: input.businessId,
        jobId: input.jobId,
        storedAssetId: { in: input.storedAssetIds },
      },
      select: {
        storedAssetId: true,
        status: true,
        reason: true,
        decidedAt: true,
      },
    });
    return new Map(rows.map((row) => [row.storedAssetId, row]));
  } catch (error) {
    if (missingProjectDocumentReviewSchema(error)) {
      return new Map<
        string,
        { status: string; reason: string | null; decidedAt: Date }
      >();
    }
    throw error;
  }
}

async function listReadyPrivateProjectDocuments(
  db: Db,
  input: { businessId: string; jobId: string },
) {
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
    orderBy: { createdAt: "asc" },
    select: PROJECT_DOCUMENT_SELECT,
  });
}

/**
 * Customer-visible receipts for this project token. Filenames only —
 * private bytes stay on the authenticated owner/admin download path.
 */
export async function listProjectDocumentsForPortal(db: Db, token: string) {
  const job = await findJobByProjectToken(db, token);
  if (!job) return [];
  const rows = await listReadyPrivateProjectDocuments(db, {
    businessId: job.businessId,
    jobId: job.id,
  });
  const reviews = await loadProjectDocumentReviewsByAssetId(db, {
    businessId: job.businessId,
    jobId: job.id,
    storedAssetIds: rows.map((row) => row.id),
  });
  return rows.map((row): ProjectDocumentReceiptItem => {
    const review = reviews.get(row.id);
    return {
      id: row.id,
      originalFilename: row.originalFilename,
      fileSizeBytes: row.fileSizeBytes,
      createdAt: row.createdAt,
      ...toReviewFields(review),
    };
  });
}

/**
 * Same-business OWNER/ADMIN review list. The caller must already have
 * resolved the workspace business; this never reads a browser businessId.
 */
export async function listProjectDocumentsForOwnerReview(
  db: Db,
  input: { businessId: string; jobId: string },
) {
  const job = await db.job.findFirst({
    where: { id: input.jobId, businessId: input.businessId },
    select: { id: true, businessId: true },
  });
  if (!job) return [];
  const rows = await listReadyPrivateProjectDocuments(db, {
    businessId: job.businessId,
    jobId: job.id,
  });
  const reviews = await loadProjectDocumentReviewsByAssetId(db, {
    businessId: job.businessId,
    jobId: job.id,
    storedAssetIds: rows.map((row) => row.id),
  });
  return rows.map((row) => toReviewItem(row, reviews.get(row.id)));
}

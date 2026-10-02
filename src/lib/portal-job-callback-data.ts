/**
 * Customer Project Portal read model for a callback request.
 *
 * Token lookup only. Mutation-free. Bounded reads. Never returns other
 * jobs, costs, warranty determinations, owner notes, outcomes, member
 * ids, storage keys, or other owner-only fields.
 */
import type { PrismaClient, Prisma } from "@prisma/client";
import { PROJECT_DOCUMENT_PURPOSE } from "@/lib/business-storage/project-documents";
import {
  JOB_CALLBACK_OPEN_STATUSES,
  MAX_JOB_CALLBACK_ATTACHMENTS,
  customerVisibleCallbackStatus,
  customerVisibleCallbackStatusLabel,
  isPortalJobCallbackClosed,
  isPortalJobCallbackCoolingDown,
  missingJobCallbackIssueSchema,
  parsePortalProjectToken,
  portalJobCallbackCooldownAvailableAt,
  recordedCallbackCategoryLabel,
  type CustomerVisibleCallbackAttachment,
  type JobCallbackCustomerStatus,
} from "@/lib/job-callback";
import { findLiveJobByProjectToken } from "@/lib/project-link-data";

type Db = PrismaClient | Prisma.TransactionClient;

export type PortalJobCallbackView =
  | { status: "hidden" }
  | {
      status: "ready";
      jobId: string;
      attachableDocuments: Array<{ id: string; originalFilename: string }>;
    }
  | {
      status: "already_requested";
      jobId: string;
      customerVisibleStatus: JobCallbackCustomerStatus;
      customerVisibleStatusLabel: string;
      categoryLabel: string | null;
      description: string;
      attachments: CustomerVisibleCallbackAttachment[];
    }
  | { status: "cooldown"; jobId: string; availableAt: Date }
  | { status: "closed"; jobId: string };

const PORTAL_JOB_SELECT = {
  id: true,
  businessId: true,
  status: true,
} as const;

export async function loadPortalJobCallbackView(
  db: Db,
  token: string,
): Promise<PortalJobCallbackView> {
  const projectToken = parsePortalProjectToken(token);
  if (!projectToken) return { status: "hidden" };

  const job = await findLiveJobByProjectToken(db, projectToken, PORTAL_JOB_SELECT);
  if (!job || job.status !== "COMPLETED") {
    return { status: "hidden" };
  }

  const open = await db.jobCallback.findFirst({
    where: {
      businessId: job.businessId,
      jobId: job.id,
      status: { in: [...JOB_CALLBACK_OPEN_STATUSES] },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 1,
    select: { id: true, status: true, description: true },
  });

  if (open) {
    const extras = await loadPortalCallbackExtras(db, job.businessId, open.id);
    return {
      status: "already_requested",
      jobId: job.id,
      customerVisibleStatus: customerVisibleCallbackStatus(open.status),
      customerVisibleStatusLabel: customerVisibleCallbackStatusLabel(open.status),
      categoryLabel: extras.categoryLabel,
      description: open.description,
      attachments: extras.attachments,
    };
  }

  const resolved = await findLatestResolvedJobCallback(db, job.businessId, job.id);
  if (isPortalJobCallbackClosed(resolved?.outcome)) {
    return { status: "closed", jobId: job.id };
  }
  const resolvedAt = resolvedJobCallbackAt(resolved);
  if (resolvedAt && isPortalJobCallbackCoolingDown(resolvedAt)) {
    return {
      status: "cooldown",
      jobId: job.id,
      availableAt: portalJobCallbackCooldownAvailableAt(resolvedAt),
    };
  }

  let attachableDocuments: Array<{ id: string; originalFilename: string }> = [];
  try {
    attachableDocuments = await db.storedAsset.findMany({
      where: {
        businessId: job.businessId,
        jobId: job.id,
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
  } catch (error) {
    if (!missingJobCallbackIssueSchema(error)) throw error;
  }

  return { status: "ready", jobId: job.id, attachableDocuments };
}

async function loadPortalCallbackExtras(
  db: Db,
  businessId: string,
  callbackId: string,
): Promise<{
  categoryLabel: string | null;
  attachments: CustomerVisibleCallbackAttachment[];
}> {
  try {
    const row = await db.jobCallback.findFirst({
      where: { id: callbackId, businessId },
      select: {
        category: true,
        attachments: {
          orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
          select: { originalFilename: true },
        },
      },
    });
    return {
      categoryLabel: recordedCallbackCategoryLabel(row?.category),
      attachments: (row?.attachments ?? []).map((attachment) => ({
        originalFilename: attachment.originalFilename,
      })),
    };
  } catch (error) {
    if (missingJobCallbackIssueSchema(error)) {
      return { categoryLabel: null, attachments: [] };
    }
    throw error;
  }
}

export async function findLatestResolvedJobCallback(
  db: Db,
  businessId: string,
  jobId: string,
) {
  return db.jobCallback.findFirst({
    where: {
      businessId,
      jobId,
      status: "OUTCOME_RECORDED",
    },
    orderBy: [
      { outcomeAt: { sort: "desc", nulls: "last" } },
      { createdAt: "desc" },
      { id: "desc" },
    ],
    take: 1,
    select: { id: true, outcome: true, outcomeAt: true, updatedAt: true },
  });
}

export function resolvedJobCallbackAt(
  row: { outcomeAt: Date | null; updatedAt: Date } | null,
): Date | null {
  if (!row) return null;
  return row.outcomeAt ?? row.updatedAt;
}

/**
 * Customer Project Portal read model for a structured reported issue.
 *
 * Token lookup only. Mutation-free. Bounded reads. Never returns other
 * jobs, owner notes, decisions, storage keys, warranty determinations,
 * or owner-only fields.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { findLiveJobByProjectToken } from "@/lib/project-link-data";
import { PROJECT_DOCUMENT_PURPOSE } from "@/lib/business-storage/project-documents";
import { parsePortalProjectToken } from "@/lib/job-callback";
import {
  JOB_CUSTOMER_ISSUE_OPEN_STATUSES,
  MAX_JOB_CUSTOMER_ISSUE_ATTACHMENTS,
  missingJobCustomerIssueSchema,
  recordedIssueCategoryLabel,
  recordedIssueCustomerStatusLabel,
  type CustomerVisibleIssue,
  type JobCustomerIssueCustomerStatus,
} from "@/lib/job-customer-issue";

type Db = PrismaClient | Prisma.TransactionClient;

export type PortalJobCustomerIssueView =
  | { status: "hidden" }
  | {
      status: "ready" | "already_reported";
      jobId: string;
      issues: CustomerVisibleIssue[];
      attachableDocuments: Array<{ id: string; originalFilename: string }>;
    };

const PORTAL_JOB_SELECT = {
  id: true,
  businessId: true,
  status: true,
} as const;

const PORTAL_ISSUE_SELECT = {
  id: true,
  jobId: true,
  businessId: true,
  category: true,
  description: true,
  customerVisibleStatus: true,
  preferredContact: true,
  recordedAt: true,
  attachments: {
    orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
    select: { originalFilename: true },
  },
} satisfies Prisma.JobCustomerIssueSelect;

function asCustomerIssue(
  row: Prisma.JobCustomerIssueGetPayload<{ select: typeof PORTAL_ISSUE_SELECT }>,
): CustomerVisibleIssue {
  return {
    id: row.id,
    jobId: row.jobId,
    businessId: row.businessId,
    category: row.category,
    categoryLabel: recordedIssueCategoryLabel(row.category),
    description: row.description,
    customerVisibleStatus: row.customerVisibleStatus as JobCustomerIssueCustomerStatus,
    customerVisibleStatusLabel: recordedIssueCustomerStatusLabel(row.customerVisibleStatus),
    preferredContact: row.preferredContact,
    recordedAt: row.recordedAt,
    attachments: row.attachments.map((attachment) => ({
      originalFilename: attachment.originalFilename,
    })),
  };
}

export async function loadPortalJobCustomerIssueView(
  db: Db,
  token: string,
): Promise<PortalJobCustomerIssueView> {
  const projectToken = parsePortalProjectToken(token);
  if (!projectToken) return { status: "hidden" };

  const job = await findLiveJobByProjectToken(db, projectToken, PORTAL_JOB_SELECT);
  if (!job || job.status !== "COMPLETED") {
    return { status: "hidden" };
  }

  try {
    const [rows, attachableDocuments] = await Promise.all([
      db.jobCustomerIssue.findMany({
        where: { businessId: job.businessId, jobId: job.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: PORTAL_ISSUE_SELECT,
      }),
      db.storedAsset.findMany({
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
        take: MAX_JOB_CUSTOMER_ISSUE_ATTACHMENTS,
        select: { id: true, originalFilename: true },
      }),
    ]);
    const issues = rows.map(asCustomerIssue);
    const open = issues.some((issue) =>
      (JOB_CUSTOMER_ISSUE_OPEN_STATUSES as readonly string[]).includes(
        issue.customerVisibleStatus,
      ),
    );
    return {
      status: open ? "already_reported" : "ready",
      jobId: job.id,
      issues,
      attachableDocuments,
    };
  } catch (error) {
    if (missingJobCustomerIssueSchema(error)) return { status: "hidden" };
    throw error;
  }
}

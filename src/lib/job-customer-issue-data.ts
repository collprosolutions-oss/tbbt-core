/**
 * Read-only issue loaders. Mutation-free.
 *
 * OWNER review includes private notes, decisions, attachments, history,
 * and recorded warranty terms as stored. The customer project token may
 * read only customer-visible status, category, description, and
 * attachment filenames for that token-scoped Job.
 *
 * Preview shares production and skips migrate. A missing issue table
 * (Prisma P2021/P2022) returns null so /p/[token] and /jobs/[jobId]
 * still render.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  JOB_CUSTOMER_ISSUE_HISTORY_BOUND,
  JOB_CUSTOMER_ISSUE_OWNER_WORKFLOW_MESSAGE,
  jobCustomerIssueWriteAllowed,
  missingJobCustomerIssueSchema,
  recordedIssueCategoryLabel,
  recordedIssueCustomerStatusLabel,
  recordedIssueDecisionLabel,
  recordedIssueEventLabel,
  recordedIssueReportedViaLabel,
  type JobCustomerIssueCustomerStatus,
  type OwnerJobCustomerIssue,
} from "@/lib/job-customer-issue";
import { loadAttachablePrivateDocuments } from "@/lib/job-customer-issue-ops";
import {
  JOB_CALLBACK_NO_WARRANTY_TERMS_MESSAGE,
  JOB_CALLBACK_WARRANTY_DISCLAIMER,
  completedSameBusinessJobEligible,
  type RecordedWarrantyTerm,
} from "@/lib/job-callback";
import { loadRecordedWarrantyTerms } from "@/lib/job-callback-data";

type Db = PrismaClient | Prisma.TransactionClient;

const ISSUE_SELECT = {
  id: true,
  businessId: true,
  jobId: true,
  category: true,
  description: true,
  reportedVia: true,
  preferredContact: true,
  customerVisibleStatus: true,
  decision: true,
  ownerNotes: true,
  recordedAt: true,
  reviewedAt: true,
  decidedAt: true,
  recordedBy: { select: { user: { select: { name: true } } } },
  attachments: {
    orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
    select: {
      id: true,
      storedAssetId: true,
      originalFilename: true,
    },
  },
  events: {
    orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
    take: JOB_CUSTOMER_ISSUE_HISTORY_BOUND,
    select: {
      id: true,
      eventType: true,
      fromCustomerVisibleStatus: true,
      toCustomerVisibleStatus: true,
      createdAt: true,
      actor: { select: { user: { select: { name: true } } } },
    },
  },
} satisfies Prisma.JobCustomerIssueSelect;

export type JobCustomerIssueReview = {
  jobId: string;
  jobStatus: string;
  eligible: boolean;
  canRecord: boolean;
  canWrite: boolean;
  openIssueId: string | null;
  issues: OwnerJobCustomerIssue[];
  attachableDocuments: Array<{ id: string; originalFilename: string }>;
  warrantyTerms: RecordedWarrantyTerm[];
  warrantyDisclaimer: string;
  noWarrantyTermsMessage: string;
  workflowMessage: string;
};

function asOwnerIssue(
  row: Prisma.JobCustomerIssueGetPayload<{ select: typeof ISSUE_SELECT }>,
): OwnerJobCustomerIssue {
  return {
    id: row.id,
    jobId: row.jobId,
    category: row.category,
    categoryLabel: recordedIssueCategoryLabel(row.category),
    description: row.description,
    reportedVia: row.reportedVia,
    reportedViaLabel: recordedIssueReportedViaLabel(row.reportedVia),
    preferredContact: row.preferredContact,
    customerVisibleStatus: row.customerVisibleStatus as JobCustomerIssueCustomerStatus,
    customerVisibleStatusLabel: recordedIssueCustomerStatusLabel(row.customerVisibleStatus),
    decision: row.decision,
    decisionLabel: recordedIssueDecisionLabel(row.decision),
    ownerNotes: row.ownerNotes,
    recordedAt: row.recordedAt,
    reviewedAt: row.reviewedAt,
    decidedAt: row.decidedAt,
    recordedByName: row.recordedBy.user.name,
    attachments: row.attachments.map((attachment) => ({
      id: attachment.id,
      storedAssetId: attachment.storedAssetId,
      originalFilename: attachment.originalFilename,
    })),
    history: row.events.map((event) => ({
      id: event.id,
      eventType: event.eventType,
      eventLabel: recordedIssueEventLabel(event.eventType),
      fromCustomerVisibleStatus: event.fromCustomerVisibleStatus,
      toCustomerVisibleStatus: event.toCustomerVisibleStatus,
      createdAt: event.createdAt,
      actorName: event.actor.user.name,
    })),
  };
}

export async function loadJobCustomerIssueReview(
  db: Db,
  access: BusinessAccess,
  jobId: string,
): Promise<JobCustomerIssueReview | null> {
  const job = await db.job.findFirst({
    where: { id: jobId, ...access.scope },
    select: {
      id: true,
      businessId: true,
      status: true,
      approvedEstimateVersionId: true,
      estimateId: true,
    },
  });
  if (!job) return null;
  access.assertOwned(job);

  try {
    const [rows, warrantyTerms, attachableDocuments] = await Promise.all([
      db.jobCustomerIssue.findMany({
        where: { jobId: job.id, businessId: access.businessId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: ISSUE_SELECT,
      }),
      loadRecordedWarrantyTerms(db, access, job),
      loadAttachablePrivateDocuments(db, {
        businessId: access.businessId,
        jobId: job.id,
      }),
    ]);
    const issues = rows.map((row) => asOwnerIssue(access.assertOwned(row)));
    const open = issues.find((issue) =>
      issue.customerVisibleStatus === "RECEIVED" || issue.customerVisibleStatus === "IN_REVIEW",
    );
    const canWrite = jobCustomerIssueWriteAllowed(access.workspace.role);
    const eligible = completedSameBusinessJobEligible(job, access.businessId);

    return {
      jobId: job.id,
      jobStatus: job.status,
      eligible,
      canRecord: eligible && canWrite && !open,
      canWrite,
      openIssueId: open?.id ?? null,
      issues,
      attachableDocuments,
      warrantyTerms,
      warrantyDisclaimer: JOB_CALLBACK_WARRANTY_DISCLAIMER,
      noWarrantyTermsMessage: JOB_CALLBACK_NO_WARRANTY_TERMS_MESSAGE,
      workflowMessage: JOB_CUSTOMER_ISSUE_OWNER_WORKFLOW_MESSAGE,
    };
  } catch (error) {
    if (missingJobCustomerIssueSchema(error)) return null;
    throw error;
  }
}

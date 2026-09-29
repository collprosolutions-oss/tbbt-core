/**
 * Read-only OWNER review of customer-reported callbacks and any recorded
 * warranty terms. Mutation-free. Tenant-scoped. Never invents coverage.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { parseAgreementAnswers } from "@/lib/business-protection-agreements";
import { lineCustomerPolicies } from "@/lib/estimate-line-scope";
import {
  JOB_CALLBACK_NO_WARRANTY_TERMS_MESSAGE,
  JOB_CALLBACK_OWNER_WORKFLOW_MESSAGE,
  JOB_CALLBACK_WARRANTY_DISCLAIMER,
  completedSameBusinessJobEligible,
  jobCallbackWriteAllowed,
  warrantyTermLooksRecorded,
  type RecordedWarrantyTerm,
} from "@/lib/job-callback";

type Db = PrismaClient | Prisma.TransactionClient;

const CALLBACK_SELECT = {
  id: true,
  businessId: true,
  jobId: true,
  customerId: true,
  description: true,
  reportedVia: true,
  status: true,
  outcome: true,
  outcomeNotes: true,
  recordedAt: true,
  reviewedAt: true,
  outcomeAt: true,
  recordedBy: { select: { user: { select: { name: true } } } },
  reviewedBy: { select: { user: { select: { name: true } } } },
  outcomeBy: { select: { user: { select: { name: true } } } },
  events: {
    orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
    select: {
      id: true,
      eventType: true,
      fromStatus: true,
      toStatus: true,
      createdAt: true,
      actor: { select: { user: { select: { name: true } } } },
    },
  },
} satisfies Prisma.JobCallbackSelect;

export type JobCallbackHistoryItem = Prisma.JobCallbackGetPayload<{
  select: typeof CALLBACK_SELECT;
}>;

export type JobCallbackReview = {
  jobId: string;
  jobStatus: string;
  eligible: boolean;
  canRecord: boolean;
  canWrite: boolean;
  openCallbackId: string | null;
  callbacks: JobCallbackHistoryItem[];
  warrantyTerms: RecordedWarrantyTerm[];
  warrantyDisclaimer: string;
  noWarrantyTermsMessage: string;
  workflowMessage: string;
};

function uniqueTerms(terms: RecordedWarrantyTerm[]): RecordedWarrantyTerm[] {
  const seen = new Set<string>();
  const out: RecordedWarrantyTerm[] = [];
  for (const term of terms) {
    const key = `${term.source}:${term.sourceId}:${term.title}:${term.body ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

export async function loadRecordedWarrantyTerms(
  db: Db,
  access: BusinessAccess,
  job: {
    id: string;
    businessId: string;
    approvedEstimateVersionId: string | null;
    estimateId: string | null;
  },
): Promise<RecordedWarrantyTerm[]> {
  access.assertOwned(job);

  const [vaultRows, agreements, approvedVersion, liveEstimate] = await Promise.all([
    db.businessVaultRecord.findMany({
      where: {
        ...access.scope,
        category: "WARRANTY",
        recordStatus: "ACTIVE",
      },
      select: {
        id: true,
        title: true,
        notes: true,
        effectiveOn: true,
        expiresOn: true,
        recordStatus: true,
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 25,
    }),
    db.businessAgreement.findMany({
      where: {
        ...access.scope,
        agreementType: "CUSTOMER_AGREEMENT",
        lifecycleStatus: { in: ["SIGNED", "COMPLETE", "EXTERNAL_COMPLETE"] },
      },
      select: {
        id: true,
        title: true,
        effectiveOn: true,
        expiresOn: true,
        lifecycleStatus: true,
        signedVersion: { select: { id: true, answersJson: true } },
        currentDraft: { select: { id: true, answersJson: true } },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 25,
    }),
    job.approvedEstimateVersionId
      ? db.estimateVersion.findFirst({
          where: { id: job.approvedEstimateVersionId, ...access.scope },
          select: {
            id: true,
            businessId: true,
            lineItems: {
              orderBy: { createdAt: "asc" },
              select: { id: true, description: true },
            },
          },
        })
      : Promise.resolve(null),
    !job.approvedEstimateVersionId && job.estimateId
      ? db.estimate.findFirst({
          where: { id: job.estimateId, ...access.scope },
          select: {
            id: true,
            businessId: true,
            lineItems: {
              orderBy: { createdAt: "asc" },
              select: { id: true, description: true },
            },
          },
        })
      : Promise.resolve(null),
  ]);

  const terms: RecordedWarrantyTerm[] = vaultRows.map((row) => ({
    source: "VAULT" as const,
    sourceId: row.id,
    title: row.title,
    body: row.notes?.trim() || null,
    effectiveOn: row.effectiveOn,
    expiresOn: row.expiresOn,
    recordStatus: row.recordStatus,
  }));

  for (const agreement of agreements) {
    const answers = parseAgreementAnswers(
      agreement.signedVersion?.answersJson ?? agreement.currentDraft?.answersJson,
    );
    const warranty = answers.warranty?.trim();
    if (!warranty) continue;
    terms.push({
      source: "AGREEMENT",
      sourceId: agreement.id,
      title: agreement.title,
      body: warranty,
      effectiveOn: agreement.effectiveOn,
      expiresOn: agreement.expiresOn,
      recordStatus: agreement.lifecycleStatus,
    });
  }

  const estimateLines =
    approvedVersion && access.assertOwned(approvedVersion)
      ? approvedVersion.lineItems
      : liveEstimate && access.assertOwned(liveEstimate)
        ? liveEstimate.lineItems
        : [];
  for (const line of estimateLines) {
    for (const policy of lineCustomerPolicies(line.description)) {
      if (policy.disabled) continue;
      if (!warrantyTermLooksRecorded(policy)) continue;
      terms.push({
        source: "ESTIMATE",
        sourceId: `${line.id}:${policy.id}`,
        title: policy.title,
        body: policy.body,
        effectiveOn: null,
        expiresOn: null,
        recordStatus: "RECORDED",
      });
    }
  }

  return uniqueTerms(terms);
}

export async function loadJobCallbackReview(
  db: Db,
  access: BusinessAccess,
  jobId: string,
): Promise<JobCallbackReview | null> {
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

  const [callbacks, warrantyTerms] = await Promise.all([
    db.jobCallback.findMany({
      where: { businessId: access.businessId, jobId: job.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: CALLBACK_SELECT,
    }),
    loadRecordedWarrantyTerms(db, access, job),
  ]);

  const ownedCallbacks = callbacks.map((row) => access.assertOwned(row));
  const open = ownedCallbacks.find((row) =>
    row.status === "RECORDED" || row.status === "UNDER_REVIEW",
  );
  const canWrite = jobCallbackWriteAllowed(access.workspace.role);
  const eligible = completedSameBusinessJobEligible(job, access.businessId);

  return {
    jobId: job.id,
    jobStatus: job.status,
    eligible,
    canRecord: canWrite && eligible && !open,
    canWrite,
    openCallbackId: open?.id ?? null,
    callbacks: ownedCallbacks,
    warrantyTerms,
    warrantyDisclaimer: JOB_CALLBACK_WARRANTY_DISCLAIMER,
    noWarrantyTermsMessage: JOB_CALLBACK_NO_WARRANTY_TERMS_MESSAGE,
    workflowMessage: JOB_CALLBACK_OWNER_WORKFLOW_MESSAGE,
  };
}

"use server";

import { revalidatePath } from "next/cache";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  JOB_CUSTOMER_ISSUE_DECISION_RECORDED_MESSAGE,
  JOB_CUSTOMER_ISSUE_RECORDED_MESSAGE,
  JOB_CUSTOMER_ISSUE_REVIEWED_MESSAGE,
  JOB_CUSTOMER_ISSUE_STATUS_UNCHANGED_MESSAGE,
} from "@/lib/job-customer-issue";
import {
  jobCustomerIssueErrorMessage,
  recordCustomerReportedIssue,
  recordCustomerReportedIssueDecision,
  reviewCustomerReportedIssue,
} from "@/lib/job-customer-issue-ops";
import { prisma } from "@/lib/prisma";
import { requireOperatingBusinessAccessForForm } from "@/lib/saas-billing/enforce";

export type JobCustomerIssueActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function readStringList(formData: FormData, key: string) {
  return formData
    .getAll(key)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
}

async function requireOwnerJobCustomerIssueAccess() {
  const operating = await requireOperatingBusinessAccessForForm();
  if (!operating.ok) return operating;
  requireBusinessCapability(operating.access, CAPABILITIES.MANAGE_JOBS);
  return operating;
}

function revalidateIssue(jobId: string, projectToken?: string | null) {
  revalidatePath("/jobs");
  revalidatePath(`/jobs/${jobId}`);
  if (projectToken) {
    revalidatePath(`/p/${projectToken}`);
  }
}

async function projectTokenForJob(jobId: string, businessId: string) {
  const job = await prisma.job.findFirst({
    where: { id: jobId, businessId },
    select: { projectToken: true },
  });
  return job?.projectToken ?? null;
}

export async function recordJobCustomerIssueAction(
  _prev: JobCustomerIssueActionState,
  formData: FormData,
): Promise<JobCustomerIssueActionState> {
  const operating = await requireOwnerJobCustomerIssueAccess();
  if (!operating.ok) return { error: operating.error };
  const jobId = readString(formData, "jobId");
  if (!jobId) return { error: "That job could not be found." };

  try {
    const result = await recordCustomerReportedIssue(prisma, operating.access, {
      jobId,
      category: readString(formData, "category"),
      description: readString(formData, "description"),
      reportedVia: readString(formData, "reportedVia"),
      preferredContact: readString(formData, "preferredContact"),
      storedAssetIds: readStringList(formData, "storedAssetIds"),
    });
    revalidateIssue(
      result.issue.jobId,
      await projectTokenForJob(result.issue.jobId, operating.access.businessId),
    );
  } catch (error) {
    return {
      error: jobCustomerIssueErrorMessage(
        error,
        "That customer-reported issue could not be recorded.",
      ),
    };
  }

  return { message: JOB_CUSTOMER_ISSUE_RECORDED_MESSAGE };
}

export async function reviewJobCustomerIssueAction(
  _prev: JobCustomerIssueActionState,
  formData: FormData,
): Promise<JobCustomerIssueActionState> {
  const operating = await requireOwnerJobCustomerIssueAccess();
  if (!operating.ok) return { error: operating.error };

  try {
    const result = await reviewCustomerReportedIssue(prisma, operating.access, {
      issueId: readString(formData, "issueId"),
      ownerNotes: readString(formData, "ownerNotes"),
    });
    revalidateIssue(
      result.issue.jobId,
      await projectTokenForJob(result.issue.jobId, operating.access.businessId),
    );
    return {
      message: result.unchanged
        ? JOB_CUSTOMER_ISSUE_STATUS_UNCHANGED_MESSAGE
        : JOB_CUSTOMER_ISSUE_REVIEWED_MESSAGE,
    };
  } catch (error) {
    return {
      error: jobCustomerIssueErrorMessage(
        error,
        "That issue could not be reviewed.",
      ),
    };
  }
}

export async function recordJobCustomerIssueDecisionAction(
  _prev: JobCustomerIssueActionState,
  formData: FormData,
): Promise<JobCustomerIssueActionState> {
  const operating = await requireOwnerJobCustomerIssueAccess();
  if (!operating.ok) return { error: operating.error };

  try {
    const result = await recordCustomerReportedIssueDecision(
      prisma,
      operating.access,
      {
        issueId: readString(formData, "issueId"),
        decision: readString(formData, "decision"),
        ownerNotes: readString(formData, "ownerNotes"),
      },
    );
    revalidateIssue(
      result.issue.jobId,
      await projectTokenForJob(result.issue.jobId, operating.access.businessId),
    );
    return {
      message: result.unchanged
        ? JOB_CUSTOMER_ISSUE_STATUS_UNCHANGED_MESSAGE
        : JOB_CUSTOMER_ISSUE_DECISION_RECORDED_MESSAGE,
    };
  } catch (error) {
    return {
      error: jobCustomerIssueErrorMessage(
        error,
        "That issue decision could not be recorded.",
      ),
    };
  }
}

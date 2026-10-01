"use server";

import { revalidatePath } from "next/cache";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { requireOperatingProductAccessForForm } from "@/lib/saas-billing/enforce";
import { parseExpectedUpdatedAt } from "@/lib/workforce";
import {
  JOB_REASSIGNMENT_REQUEST_DECISIONS,
  type JobReassignmentRequestDecision,
} from "@/lib/job-reassignment-request";
import {
  decideJobReassignmentRequestOp,
  jobReassignmentRequestErrorMessage,
  requestJobReassignmentOp,
} from "@/lib/job-reassignment-request-ops";
import { prisma } from "@/lib/prisma";

export type JobReassignmentRequestActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function revalidateJobReassignmentRequest(jobId?: string) {
  revalidatePath("/field");
  revalidatePath("/team");
  revalidatePath("/jobs");
  if (jobId) {
    revalidatePath(`/field/jobs/${jobId}`);
    revalidatePath(`/jobs/${jobId}`);
  }
}

export async function requestJobReassignment(
  _prev: JobReassignmentRequestActionState,
  formData: FormData,
): Promise<JobReassignmentRequestActionState> {
  const operating = await requireOperatingProductAccessForForm(PRODUCT_CAPABILITIES.JOBS_TASKS);
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  const jobId = readString(formData, "jobId");
  if (!jobId) return { error: "Choose one assigned upcoming job." };

  try {
    await requestJobReassignmentOp(prisma, access, {
      jobId,
      reason: readString(formData, "reason"),
    });
  } catch (error) {
    return {
      error: jobReassignmentRequestErrorMessage(error, "That request could not be submitted."),
    };
  }

  revalidateJobReassignmentRequest(jobId);
  return {
    message:
      "Request sent to the owner. The job assignment and schedule stay unchanged until they accept. No customer message was sent.",
  };
}

export async function decideJobReassignmentRequest(
  _prev: JobReassignmentRequestActionState,
  formData: FormData,
): Promise<JobReassignmentRequestActionState> {
  const operating = await requireOperatingProductAccessForForm(PRODUCT_CAPABILITIES.JOBS_TASKS);
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;

  const requestId = readString(formData, "requestId");
  const expectedUpdatedAt = parseExpectedUpdatedAt(readString(formData, "expectedUpdatedAt"));
  const decisionRaw = readString(formData, "decision");
  const decision = (JOB_REASSIGNMENT_REQUEST_DECISIONS as readonly string[]).includes(decisionRaw)
    ? (decisionRaw as JobReassignmentRequestDecision)
    : null;
  if (!requestId || !expectedUpdatedAt || !decision) {
    return { error: "Choose a pending request to accept or decline." };
  }

  try {
    const result = await decideJobReassignmentRequestOp(prisma, access, {
      requestId,
      decision,
      expectedUpdatedAt,
    });
    revalidateJobReassignmentRequest(result.request.jobId);
    return {
      message:
        result.decision === "ACCEPT"
          ? "Accepted. The job is unassigned through the canonical assignment write. No customer message was sent."
          : "Declined. The job assignment and schedule are unchanged. No customer message was sent.",
    };
  } catch (error) {
    return {
      error: jobReassignmentRequestErrorMessage(error, "That request could not be decided."),
    };
  }
}

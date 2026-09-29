"use server";

import { revalidatePath } from "next/cache";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  JOB_CALLBACK_OUTCOME_RECORDED_MESSAGE,
  JOB_CALLBACK_RECORDED_MESSAGE,
  JOB_CALLBACK_REVIEWED_MESSAGE,
  JOB_CALLBACK_STATUS_UNCHANGED_MESSAGE,
} from "@/lib/job-callback";
import {
  jobCallbackErrorMessage,
  recordCustomerReportedCallback,
  recordCustomerReportedCallbackOutcome,
  reviewCustomerReportedCallback,
} from "@/lib/job-callback-ops";
import { prisma } from "@/lib/prisma";
import { requireOperatingBusinessAccessForForm } from "@/lib/saas-billing/enforce";

export type JobCallbackActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

async function requireOwnerJobCallbackAccess() {
  const operating = await requireOperatingBusinessAccessForForm();
  if (!operating.ok) return operating;
  requireBusinessCapability(operating.access, CAPABILITIES.MANAGE_JOBS);
  return operating;
}

function revalidateJob(jobId: string) {
  revalidatePath("/jobs");
  revalidatePath(`/jobs/${jobId}`);
}

export async function recordJobCallbackAction(
  _prev: JobCallbackActionState,
  formData: FormData,
): Promise<JobCallbackActionState> {
  const operating = await requireOwnerJobCallbackAccess();
  if (!operating.ok) return { error: operating.error };
  const jobId = readString(formData, "jobId");
  if (!jobId) return { error: "That job could not be found." };

  try {
    await recordCustomerReportedCallback(prisma, operating.access, {
      jobId,
      description: readString(formData, "description"),
      reportedVia: readString(formData, "reportedVia"),
    });
  } catch (error) {
    return {
      error: jobCallbackErrorMessage(
        error,
        "That customer-reported callback could not be recorded.",
      ),
    };
  }

  revalidateJob(jobId);
  return { message: JOB_CALLBACK_RECORDED_MESSAGE };
}

export async function reviewJobCallbackAction(
  _prev: JobCallbackActionState,
  formData: FormData,
): Promise<JobCallbackActionState> {
  const operating = await requireOwnerJobCallbackAccess();
  if (!operating.ok) return { error: operating.error };

  try {
    const result = await reviewCustomerReportedCallback(prisma, operating.access, {
      callbackId: readString(formData, "callbackId"),
    });
    revalidateJob(result.callback.jobId);
    return {
      message: result.unchanged
        ? JOB_CALLBACK_STATUS_UNCHANGED_MESSAGE
        : JOB_CALLBACK_REVIEWED_MESSAGE,
    };
  } catch (error) {
    return {
      error: jobCallbackErrorMessage(
        error,
        "That callback could not be reviewed.",
      ),
    };
  }
}

export async function recordJobCallbackOutcomeAction(
  _prev: JobCallbackActionState,
  formData: FormData,
): Promise<JobCallbackActionState> {
  const operating = await requireOwnerJobCallbackAccess();
  if (!operating.ok) return { error: operating.error };

  try {
    const result = await recordCustomerReportedCallbackOutcome(
      prisma,
      operating.access,
      {
        callbackId: readString(formData, "callbackId"),
        outcome: readString(formData, "outcome"),
        outcomeNotes: readString(formData, "outcomeNotes"),
      },
    );
    revalidateJob(result.callback.jobId);
    return {
      message: result.unchanged
        ? JOB_CALLBACK_STATUS_UNCHANGED_MESSAGE
        : JOB_CALLBACK_OUTCOME_RECORDED_MESSAGE,
    };
  } catch (error) {
    return {
      error: jobCallbackErrorMessage(
        error,
        "That callback outcome could not be recorded.",
      ),
    };
  }
}

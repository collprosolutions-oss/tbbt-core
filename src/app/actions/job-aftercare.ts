"use server";

import { revalidatePath } from "next/cache";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  JOB_AFTERCARE_DRAFT_SAVED_MESSAGE,
  JOB_AFTERCARE_PUBLISHED_MESSAGE,
  JOB_AFTERCARE_UNCHANGED_MESSAGE,
  JOB_AFTERCARE_UNPUBLISHED_MESSAGE,
} from "@/lib/job-aftercare";
import {
  jobAftercareErrorMessage,
  publishJobAftercare,
  saveJobAftercareDraft,
  unpublishJobAftercare,
} from "@/lib/job-aftercare-ops";
import { prisma } from "@/lib/prisma";
import { requireOperatingBusinessAccessForForm } from "@/lib/saas-billing/enforce";

export type JobAftercareActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

async function requireOwnerJobAftercareAccess() {
  const operating = await requireOperatingBusinessAccessForForm();
  if (!operating.ok) return operating;
  requireBusinessCapability(operating.access, CAPABILITIES.MANAGE_JOBS);
  return operating;
}

function revalidateAftercare(jobId: string, projectToken?: string | null) {
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

export async function saveJobAftercareDraftAction(
  _prev: JobAftercareActionState,
  formData: FormData,
): Promise<JobAftercareActionState> {
  const operating = await requireOwnerJobAftercareAccess();
  if (!operating.ok) return { error: operating.error };
  const jobId = readString(formData, "jobId");
  if (!jobId) return { error: "That job could not be found." };

  try {
    const result = await saveJobAftercareDraft(prisma, operating.access, {
      jobId,
      instructions: readString(formData, "instructions"),
      ownerNotes: readString(formData, "ownerNotes"),
    });
    revalidateAftercare(
      result.aftercare.jobId,
      await projectTokenForJob(result.aftercare.jobId, operating.access.businessId),
    );
    return {
      message: result.unchanged
        ? JOB_AFTERCARE_UNCHANGED_MESSAGE
        : JOB_AFTERCARE_DRAFT_SAVED_MESSAGE,
    };
  } catch (error) {
    return {
      error: jobAftercareErrorMessage(
        error,
        "Those aftercare instructions could not be saved.",
      ),
    };
  }
}

export async function publishJobAftercareAction(
  _prev: JobAftercareActionState,
  formData: FormData,
): Promise<JobAftercareActionState> {
  const operating = await requireOwnerJobAftercareAccess();
  if (!operating.ok) return { error: operating.error };
  const jobId = readString(formData, "jobId");
  if (!jobId) return { error: "That job could not be found." };

  try {
    const result = await publishJobAftercare(prisma, operating.access, { jobId });
    revalidateAftercare(
      result.aftercare.jobId,
      await projectTokenForJob(result.aftercare.jobId, operating.access.businessId),
    );
    return {
      message: result.unchanged
        ? JOB_AFTERCARE_UNCHANGED_MESSAGE
        : JOB_AFTERCARE_PUBLISHED_MESSAGE,
    };
  } catch (error) {
    return {
      error: jobAftercareErrorMessage(
        error,
        "Those aftercare instructions could not be published.",
      ),
    };
  }
}

export async function unpublishJobAftercareAction(
  _prev: JobAftercareActionState,
  formData: FormData,
): Promise<JobAftercareActionState> {
  const operating = await requireOwnerJobAftercareAccess();
  if (!operating.ok) return { error: operating.error };
  const jobId = readString(formData, "jobId");
  if (!jobId) return { error: "That job could not be found." };

  try {
    const result = await unpublishJobAftercare(prisma, operating.access, { jobId });
    revalidateAftercare(
      result.aftercare.jobId,
      await projectTokenForJob(result.aftercare.jobId, operating.access.businessId),
    );
    return {
      message: result.unchanged
        ? JOB_AFTERCARE_UNCHANGED_MESSAGE
        : JOB_AFTERCARE_UNPUBLISHED_MESSAGE,
    };
  } catch (error) {
    return {
      error: jobAftercareErrorMessage(
        error,
        "Those aftercare instructions could not be unpublished.",
      ),
    };
  }
}

"use server";

import { revalidatePath } from "next/cache";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  PROJECT_DOCUMENT_REVIEW_RECORDED_MESSAGE,
  PROJECT_DOCUMENT_REVIEW_UNCHANGED_MESSAGE,
} from "@/lib/project-document-review";
import {
  projectDocumentReviewErrorMessage,
  recordProjectDocumentReview,
} from "@/lib/project-document-review-ops";
import { prisma } from "@/lib/prisma";
import { requireOperatingBusinessAccessForForm } from "@/lib/saas-billing/enforce";

export type ProjectDocumentReviewActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

async function requireOwnerProjectDocumentReviewAccess() {
  const operating = await requireOperatingBusinessAccessForForm();
  if (!operating.ok) return operating;
  requireBusinessCapability(operating.access, CAPABILITIES.MANAGE_JOBS);
  return operating;
}

function revalidateReview(jobId: string, projectToken?: string | null) {
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

export async function recordProjectDocumentReviewAction(
  _prev: ProjectDocumentReviewActionState,
  formData: FormData,
): Promise<ProjectDocumentReviewActionState> {
  const operating = await requireOwnerProjectDocumentReviewAccess();
  if (!operating.ok) return { error: operating.error };
  const jobId = readString(formData, "jobId");
  const storedAssetId = readString(formData, "storedAssetId");
  if (!jobId || !storedAssetId) {
    return { error: "That project document could not be found." };
  }

  try {
    const result = await recordProjectDocumentReview(prisma, operating.access, {
      jobId,
      storedAssetId,
      status: readString(formData, "status"),
      reason: readString(formData, "reason"),
      expectedStatus: readString(formData, "expectedStatus"),
    });
    revalidateReview(
      jobId,
      await projectTokenForJob(jobId, operating.access.businessId),
    );
    return {
      message: result.unchanged
        ? PROJECT_DOCUMENT_REVIEW_UNCHANGED_MESSAGE
        : PROJECT_DOCUMENT_REVIEW_RECORDED_MESSAGE,
    };
  } catch (error) {
    return {
      error: projectDocumentReviewErrorMessage(
        error,
        "That project document review could not be recorded.",
      ),
    };
  }
}

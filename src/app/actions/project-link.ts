"use server";

import { revalidatePath } from "next/cache";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  JOB_PROJECT_LINK_ALREADY_REVOKED_MESSAGE,
  JOB_PROJECT_LINK_REVOKED_MESSAGE,
  JOB_PROJECT_LINK_ROTATED_MESSAGE,
} from "@/lib/project-link";
import {
  jobProjectLinkErrorMessage,
  revokeJobProjectLink,
  rotateJobProjectLink,
} from "@/lib/project-link-ops";
import { prisma } from "@/lib/prisma";
import { requireOperatingBusinessAccessForForm } from "@/lib/saas-billing/enforce";

export type JobProjectLinkActionState = {
  error?: string;
  message?: string;
  projectToken?: string;
  projectPath?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

async function requireOwnerProjectLinkAccess() {
  const operating = await requireOperatingBusinessAccessForForm();
  if (!operating.ok) return operating;
  requireBusinessCapability(operating.access, CAPABILITIES.MANAGE_JOBS);
  return operating;
}

function revalidateProjectLink(jobId: string, tokens: Array<string | null | undefined>) {
  revalidatePath("/jobs");
  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/invoices");
  revalidatePath("/today");
  revalidatePath("/dashboard");
  for (const token of tokens) {
    if (token) {
      revalidatePath(`/p/${token}`);
      revalidatePath(`/p/${token}/invoice`);
      revalidatePath(`/p/${token}/request-visit`);
    }
  }
}

export async function rotateJobProjectLinkAction(
  _prev: JobProjectLinkActionState,
  formData: FormData,
): Promise<JobProjectLinkActionState> {
  const operating = await requireOwnerProjectLinkAccess();
  if (!operating.ok) return { error: operating.error };
  const jobId = readString(formData, "jobId");
  if (!jobId) return { error: "That job could not be found." };

  try {
    const result = await rotateJobProjectLink(prisma, operating.access, { jobId });
    revalidateProjectLink(result.jobId, [result.previousToken, result.projectToken]);
    return {
      message: JOB_PROJECT_LINK_ROTATED_MESSAGE,
      projectToken: result.projectToken,
      projectPath: result.projectPath,
    };
  } catch (error) {
    return {
      error: jobProjectLinkErrorMessage(error, "That project link could not be rotated."),
    };
  }
}

export async function revokeJobProjectLinkAction(
  _prev: JobProjectLinkActionState,
  formData: FormData,
): Promise<JobProjectLinkActionState> {
  const operating = await requireOwnerProjectLinkAccess();
  if (!operating.ok) return { error: operating.error };
  const jobId = readString(formData, "jobId");
  if (!jobId) return { error: "That job could not be found." };

  try {
    const result = await revokeJobProjectLink(prisma, operating.access, { jobId });
    revalidateProjectLink(result.jobId, [result.previousToken]);
    return {
      message: result.unchanged
        ? JOB_PROJECT_LINK_ALREADY_REVOKED_MESSAGE
        : JOB_PROJECT_LINK_REVOKED_MESSAGE,
    };
  } catch (error) {
    return {
      error: jobProjectLinkErrorMessage(error, "That project link could not be revoked."),
    };
  }
}

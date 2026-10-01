"use server";

import { revalidatePath } from "next/cache";
import {
  JOB_CALLBACK_PORTAL_RECEIVED_MESSAGE,
  JOB_CALLBACK_PORTAL_UNAVAILABLE_MESSAGE,
} from "@/lib/job-callback";
import { submitPortalJobCallback } from "@/lib/portal-job-callback-ops";
import { prisma } from "@/lib/prisma";

export type PortalJobCallbackActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Customer Project Portal callback request. Authorization is the Job's
 * unguessable projectToken only — never a browser-supplied
 * businessId, customerId, or jobId.
 */
export async function requestPortalJobCallback(
  _prev: PortalJobCallbackActionState,
  formData: FormData,
): Promise<PortalJobCallbackActionState> {
  const token = readString(formData, "projectToken");

  try {
    const created = await submitPortalJobCallback(prisma, {
      token,
      description: readString(formData, "description"),
      preferredContact: readString(formData, "preferredContact"),
    });
    if (!created.ok) {
      return { error: created.error };
    }

    revalidatePath(`/p/${token}`);
    revalidatePath(`/jobs/${created.jobId}`);
    return { message: JOB_CALLBACK_PORTAL_RECEIVED_MESSAGE };
  } catch {
    return { error: JOB_CALLBACK_PORTAL_UNAVAILABLE_MESSAGE };
  }
}

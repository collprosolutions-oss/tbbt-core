"use server";

import { revalidatePath } from "next/cache";
import {
  JOB_CUSTOMER_ISSUE_PORTAL_RECEIVED_MESSAGE,
  JOB_CUSTOMER_ISSUE_PORTAL_UNAVAILABLE_MESSAGE,
} from "@/lib/job-customer-issue";
import { submitPortalJobCustomerIssue } from "@/lib/portal-job-customer-issue-ops";
import { prisma } from "@/lib/prisma";

export type PortalJobCustomerIssueActionState = {
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

/**
 * Customer Project Portal structured issue. Authorization is the Job's
 * unguessable projectToken only — never a browser-supplied
 * businessId, customerId, or jobId.
 */
export async function requestPortalJobCustomerIssue(
  _prev: PortalJobCustomerIssueActionState,
  formData: FormData,
): Promise<PortalJobCustomerIssueActionState> {
  const token = readString(formData, "projectToken");

  try {
    const created = await submitPortalJobCustomerIssue(prisma, {
      token,
      category: readString(formData, "category"),
      description: readString(formData, "description"),
      preferredContact: readString(formData, "preferredContact"),
      storedAssetIds: readStringList(formData, "storedAssetIds"),
    });
    if (!created.ok) {
      return { error: created.error };
    }

    revalidatePath(`/p/${token}`);
    revalidatePath(`/jobs/${created.jobId}`);
    return { message: JOB_CUSTOMER_ISSUE_PORTAL_RECEIVED_MESSAGE };
  } catch {
    return { error: JOB_CUSTOMER_ISSUE_PORTAL_UNAVAILABLE_MESSAGE };
  }
}

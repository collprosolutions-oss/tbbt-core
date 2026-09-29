"use server";

import { revalidatePath } from "next/cache";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { requireOperatingProductAccessForForm } from "@/lib/saas-billing/enforce";
import {
  assignJobBusinessLocation,
  jobLocationErrorMessage,
} from "@/lib/job-location-ops";
import { JOB_LOCATION_ADDITIVE_MESSAGE } from "@/lib/job-location";
import { prisma } from "@/lib/prisma";

export type JobLocationActionState = { error?: string; message?: string };

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function assignJobLocationAction(
  _prev: JobLocationActionState,
  formData: FormData,
): Promise<JobLocationActionState> {
  const operating = await requireOperatingProductAccessForForm(PRODUCT_CAPABILITIES.JOBS_TASKS);
  if (!operating.ok) return { error: operating.error };

  try {
    const updated = await assignJobBusinessLocation(prisma, operating.access, {
      jobId: readString(formData, "jobId"),
      locationId: readString(formData, "locationId") || null,
      expectedUpdatedAt: readString(formData, "expectedUpdatedAt"),
    });
    revalidatePath("/jobs");
    revalidatePath(`/jobs/${updated.id}`);
    return {
      message: updated.businessLocationId
        ? `Location saved. ${JOB_LOCATION_ADDITIVE_MESSAGE}`
        : `Location cleared. ${JOB_LOCATION_ADDITIVE_MESSAGE}`,
    };
  } catch (error) {
    return {
      error: jobLocationErrorMessage(error, "That location could not be assigned."),
    };
  }
}

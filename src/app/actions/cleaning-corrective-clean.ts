"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  CLEANING_CORRECTIVE_CLEAN_ALREADY_EXISTS_MESSAGE,
  CLEANING_CORRECTIVE_CLEAN_CREATED_MESSAGE,
} from "@/lib/cleaning-corrective-clean";
import {
  cleaningCorrectiveCleanErrorMessage,
  scheduleCorrectiveCleanFromReCleanRequestedJob,
} from "@/lib/cleaning-corrective-clean-ops";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { prisma } from "@/lib/prisma";
import { requireOperatingProductAccessForForm } from "@/lib/saas-billing/enforce";

export type CleaningCorrectiveCleanActionState = {
  error?: string;
  message?: string;
  nextJobId?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function scheduleCleaningCorrectiveCleanAction(
  _prev: CleaningCorrectiveCleanActionState,
  formData: FormData,
): Promise<CleaningCorrectiveCleanActionState> {
  const operating = await requireOperatingProductAccessForForm(PRODUCT_CAPABILITIES.JOBS_TASKS);
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  requireBusinessCapability(access, CAPABILITIES.MANAGE_JOBS);

  const jobId = readString(formData, "jobId");
  if (!jobId) return { error: "That job could not be found." };

  let created;
  try {
    created = await scheduleCorrectiveCleanFromReCleanRequestedJob(prisma, access, {
      jobId,
      date: readString(formData, "date"),
      time: readString(formData, "time"),
      confirmCreate: readString(formData, "confirmCreate"),
    });
  } catch (error) {
    return {
      error: cleaningCorrectiveCleanErrorMessage(
        error,
        "That corrective clean could not be scheduled.",
      ),
    };
  }

  revalidatePath("/jobs");
  revalidatePath("/dashboard");
  revalidatePath(`/jobs/${jobId}`);
  revalidatePath(`/jobs/${created.id}`);
  redirect(`/jobs/${created.id}`);
}

export const CLEANING_CORRECTIVE_CLEAN_ACTION_COPY = {
  created: CLEANING_CORRECTIVE_CLEAN_CREATED_MESSAGE,
  alreadyExists: CLEANING_CORRECTIVE_CLEAN_ALREADY_EXISTS_MESSAGE,
};

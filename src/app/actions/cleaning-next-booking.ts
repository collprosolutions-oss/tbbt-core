"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  CLEANING_NEXT_BOOKING_ALREADY_EXISTS_MESSAGE,
  CLEANING_NEXT_BOOKING_CREATED_MESSAGE,
} from "@/lib/cleaning-next-booking";
import {
  cleaningNextBookingErrorMessage,
  createNextBookingFromCompletedCleaningJob,
} from "@/lib/cleaning-next-booking-ops";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { prisma } from "@/lib/prisma";
import { requireOperatingProductAccessForForm } from "@/lib/saas-billing/enforce";

export type CleaningNextBookingActionState = {
  error?: string;
  message?: string;
  nextJobId?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function createCleaningNextBookingAction(
  _prev: CleaningNextBookingActionState,
  formData: FormData,
): Promise<CleaningNextBookingActionState> {
  const operating = await requireOperatingProductAccessForForm(PRODUCT_CAPABILITIES.JOBS_TASKS);
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  requireBusinessCapability(access, CAPABILITIES.MANAGE_JOBS);

  const jobId = readString(formData, "jobId");
  if (!jobId) return { error: "That job could not be found." };

  let created;
  try {
    created = await createNextBookingFromCompletedCleaningJob(prisma, access, {
      jobId,
      date: readString(formData, "date"),
      time: readString(formData, "time"),
      confirmCreate: readString(formData, "confirmCreate"),
    });
  } catch (error) {
    return {
      error: cleaningNextBookingErrorMessage(error, "That next booking could not be created."),
    };
  }

  revalidatePath("/jobs");
  revalidatePath("/dashboard");
  revalidatePath(`/jobs/${jobId}`);
  revalidatePath(`/jobs/${created.id}`);
  redirect(`/jobs/${created.id}`);
}

export const CLEANING_NEXT_BOOKING_ACTION_COPY = {
  created: CLEANING_NEXT_BOOKING_CREATED_MESSAGE,
  alreadyExists: CLEANING_NEXT_BOOKING_ALREADY_EXISTS_MESSAGE,
};

"use server";

import { revalidatePath } from "next/cache";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  CLEANING_RECURRING_ALREADY_EXISTS_MESSAGE,
  CLEANING_RECURRING_CREATED_MESSAGE,
  CLEANING_RECURRING_FILLED_MESSAGE,
  CLEANING_RECURRING_RESUMED_MESSAGE,
  CLEANING_RECURRING_STOPPED_MESSAGE,
} from "@/lib/cleaning-recurring-booking";
import {
  cleaningRecurringBookingErrorMessage,
  fillCleaningRecurringBookings,
  resumeCleaningRecurringBookings,
  setupCleaningRecurringBookings,
  stopCleaningRecurringBookings,
} from "@/lib/cleaning-recurring-booking-ops";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { prisma } from "@/lib/prisma";
import { requireOperatingProductAccessForForm } from "@/lib/saas-billing/enforce";

export type CleaningRecurringBookingActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function revalidateRecurring(jobId: string, occurrenceIds: string[] = []) {
  revalidatePath("/jobs");
  revalidatePath("/dashboard");
  revalidatePath(`/jobs/${jobId}`);
  for (const id of occurrenceIds) {
    revalidatePath(`/jobs/${id}`);
  }
}

export async function setupCleaningRecurringBookingsAction(
  _prev: CleaningRecurringBookingActionState,
  formData: FormData,
): Promise<CleaningRecurringBookingActionState> {
  const operating = await requireOperatingProductAccessForForm(PRODUCT_CAPABILITIES.JOBS_TASKS);
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  requireBusinessCapability(access, CAPABILITIES.MANAGE_JOBS);

  const jobId = readString(formData, "jobId");
  if (!jobId) return { error: "That job could not be found." };

  try {
    const result = await setupCleaningRecurringBookings(prisma, access, {
      jobId,
      cadence: readString(formData, "cadence"),
      date: readString(formData, "date"),
      time: readString(formData, "time"),
      confirmCreate: readString(formData, "confirmCreate"),
    });
    revalidateRecurring(jobId, result.occurrences.map((row) => row.id));
    return {
      message: result.alreadyExists
        ? CLEANING_RECURRING_ALREADY_EXISTS_MESSAGE
        : CLEANING_RECURRING_CREATED_MESSAGE,
    };
  } catch (error) {
    return {
      error: cleaningRecurringBookingErrorMessage(
        error,
        "Those recurring bookings could not be created.",
      ),
    };
  }
}

export async function fillCleaningRecurringBookingsAction(
  _prev: CleaningRecurringBookingActionState,
  formData: FormData,
): Promise<CleaningRecurringBookingActionState> {
  const operating = await requireOperatingProductAccessForForm(PRODUCT_CAPABILITIES.JOBS_TASKS);
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  requireBusinessCapability(access, CAPABILITIES.MANAGE_JOBS);

  const jobId = readString(formData, "jobId");
  if (!jobId) return { error: "That job could not be found." };

  try {
    const result = await fillCleaningRecurringBookings(prisma, access, { jobId });
    revalidateRecurring(jobId, result.occurrences.map((row) => row.id));
    return { message: CLEANING_RECURRING_FILLED_MESSAGE };
  } catch (error) {
    return {
      error: cleaningRecurringBookingErrorMessage(
        error,
        "Upcoming recurring bookings could not be updated.",
      ),
    };
  }
}

export async function stopCleaningRecurringBookingsAction(
  _prev: CleaningRecurringBookingActionState,
  formData: FormData,
): Promise<CleaningRecurringBookingActionState> {
  const operating = await requireOperatingProductAccessForForm(PRODUCT_CAPABILITIES.JOBS_TASKS);
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  requireBusinessCapability(access, CAPABILITIES.MANAGE_JOBS);

  const jobId = readString(formData, "jobId");
  if (!jobId) return { error: "That job could not be found." };

  try {
    const result = await stopCleaningRecurringBookings(prisma, access, {
      jobId,
      confirmStop: readString(formData, "confirmStop"),
    });
    revalidateRecurring(jobId, result.occurrences.map((row) => row.id));
    return { message: CLEANING_RECURRING_STOPPED_MESSAGE };
  } catch (error) {
    return {
      error: cleaningRecurringBookingErrorMessage(
        error,
        "That recurring schedule could not be stopped.",
      ),
    };
  }
}

export async function resumeCleaningRecurringBookingsAction(
  _prev: CleaningRecurringBookingActionState,
  formData: FormData,
): Promise<CleaningRecurringBookingActionState> {
  const operating = await requireOperatingProductAccessForForm(PRODUCT_CAPABILITIES.JOBS_TASKS);
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  requireBusinessCapability(access, CAPABILITIES.MANAGE_JOBS);

  const jobId = readString(formData, "jobId");
  if (!jobId) return { error: "That job could not be found." };

  try {
    const result = await resumeCleaningRecurringBookings(prisma, access, {
      jobId,
      confirmResume: readString(formData, "confirmResume"),
    });
    revalidateRecurring(jobId, result.occurrences.map((row) => row.id));
    return { message: CLEANING_RECURRING_RESUMED_MESSAGE };
  } catch (error) {
    return {
      error: cleaningRecurringBookingErrorMessage(
        error,
        "That recurring schedule could not be resumed.",
      ),
    };
  }
}

export const CLEANING_RECURRING_BOOKING_ACTION_COPY = {
  created: CLEANING_RECURRING_CREATED_MESSAGE,
  alreadyExists: CLEANING_RECURRING_ALREADY_EXISTS_MESSAGE,
  stopped: CLEANING_RECURRING_STOPPED_MESSAGE,
  resumed: CLEANING_RECURRING_RESUMED_MESSAGE,
  filled: CLEANING_RECURRING_FILLED_MESSAGE,
};

"use server";

import { revalidatePath } from "next/cache";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { requireOperatingProductAccess } from "@/lib/saas-billing/enforce";
import {
  OWNER_DAY_ROUTE_CHANGE_OWNER_ONLY_MESSAGE,
  OWNER_DAY_ROUTE_PATH,
  changeOwnerDayRouteAppointment,
  ownerDayRouteChangeErrorMessage,
} from "@/lib/owner-day-route";
import { prisma } from "@/lib/prisma";

export type OwnerDayRouteChangeState = {
  error?: string;
  warning?: string;
  conflictAck?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function changeOwnerDayRouteAppointmentAction(
  _prev: OwnerDayRouteChangeState,
  formData: FormData,
): Promise<OwnerDayRouteChangeState> {
  try {
    const access = await requireOperatingProductAccess(PRODUCT_CAPABILITIES.JOBS_TASKS);
    if (access.workspace.role !== "OWNER") {
      return { error: OWNER_DAY_ROUTE_CHANGE_OWNER_ONLY_MESSAGE };
    }
    const dateIso = readString(formData, "dateIso");
    const result = await changeOwnerDayRouteAppointment(prisma, access, {
      jobId: readString(formData, "jobId"),
      date: readString(formData, "date"),
      time: readString(formData, "time"),
      durationPreset: readString(formData, "durationPreset") || undefined,
      customHours: readString(formData, "customHours") || undefined,
      pickupDurationMinutes: readString(formData, "pickupDurationMinutes"),
      expectedScheduledAt: readString(formData, "expectedScheduledAt"),
      confirmOverlapAck: readString(formData, "confirmOverlapAck"),
    });
    if (!result.ok) {
      return {
        error: result.error,
        warning: result.warning,
        conflictAck: result.conflictAck,
      };
    }
    revalidatePath(OWNER_DAY_ROUTE_PATH);
    if (dateIso) revalidatePath(`${OWNER_DAY_ROUTE_PATH}?date=${dateIso}`);
    revalidatePath("/jobs");
    revalidatePath("/dashboard");
    if (result.jobId) revalidatePath(`/jobs/${result.jobId}`);
    return { message: result.message };
  } catch (error) {
    return {
      error: ownerDayRouteChangeErrorMessage(
        error,
        "That appointment could not be changed from the day-route page.",
      ),
    };
  }
}

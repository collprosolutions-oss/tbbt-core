"use server";

import { revalidatePath } from "next/cache";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  DAY_ROUTE_APPOINTMENT_CHANGED_MESSAGE,
  DAY_ROUTE_APPOINTMENT_MISSING_JOB_MESSAGE,
} from "@/lib/owner-day-route-appointment";
import {
  changeOwnerDayRouteAppointment,
  dayRouteAppointmentErrorMessage,
} from "@/lib/owner-day-route-appointment-ops";
import {
  DAY_ROUTE_APPOINTMENT_NOTICE_MISSING_JOB_MESSAGE,
  DAY_ROUTE_APPOINTMENT_NOTICE_SENT_MESSAGE,
} from "@/lib/owner-day-route-appointment-notice";
import {
  dayRouteAppointmentNoticeErrorMessage,
  sendOwnerDayRouteAppointmentNotice,
} from "@/lib/owner-day-route-appointment-notice-ops";
import { OWNER_DAY_ROUTE_PATH } from "@/lib/owner-day-route/constants";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { prisma } from "@/lib/prisma";
import { requireOperatingProductAccessForForm } from "@/lib/saas-billing/enforce";

export type OwnerDayRouteAppointmentActionState = {
  error?: string;
  message?: string;
  ok?: boolean;
};

export type OwnerDayRouteAppointmentNoticeActionState = {
  error?: string;
  message?: string;
  ok?: boolean;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function revalidateDayRouteSurfaces(jobId: string) {
  revalidatePath(OWNER_DAY_ROUTE_PATH);
  revalidatePath("/today");
  revalidatePath("/jobs");
  revalidatePath("/dashboard");
  revalidatePath(`/jobs/${jobId}`);
}

export async function changeOwnerDayRouteAppointmentAction(
  _prev: OwnerDayRouteAppointmentActionState,
  formData: FormData,
): Promise<OwnerDayRouteAppointmentActionState> {
  const operating = await requireOperatingProductAccessForForm(PRODUCT_CAPABILITIES.JOBS_TASKS);
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  requireBusinessCapability(access, CAPABILITIES.MANAGE_JOBS);

  const jobId = readString(formData, "jobId");
  if (!jobId) return { error: DAY_ROUTE_APPOINTMENT_MISSING_JOB_MESSAGE };

  let changed;
  try {
    changed = await changeOwnerDayRouteAppointment(prisma, access, {
      jobId,
      date: readString(formData, "date"),
      time: readString(formData, "time"),
      snapshot: readString(formData, "scheduleSnapshot"),
    });
  } catch (error) {
    return {
      error: dayRouteAppointmentErrorMessage(
        error,
        DAY_ROUTE_APPOINTMENT_MISSING_JOB_MESSAGE,
      ),
    };
  }

  revalidateDayRouteSurfaces(changed.jobId);
  return { ok: true, message: DAY_ROUTE_APPOINTMENT_CHANGED_MESSAGE };
}

export async function sendOwnerDayRouteAppointmentNoticeAction(
  _prev: OwnerDayRouteAppointmentNoticeActionState,
  formData: FormData,
): Promise<OwnerDayRouteAppointmentNoticeActionState> {
  const operating = await requireOperatingProductAccessForForm(PRODUCT_CAPABILITIES.JOBS_TASKS);
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  requireBusinessCapability(access, CAPABILITIES.MANAGE_JOBS);
  requireBusinessCapability(access, CAPABILITIES.MANAGE_COMMUNICATIONS);

  const jobId = readString(formData, "jobId");
  if (!jobId) return { error: DAY_ROUTE_APPOINTMENT_NOTICE_MISSING_JOB_MESSAGE };

  try {
    const sent = await sendOwnerDayRouteAppointmentNotice(prisma, access, {
      jobId,
      snapshot: readString(formData, "scheduleSnapshot"),
      confirmSend: readString(formData, "confirmSend"),
      timeZone: readString(formData, "timeZone"),
      reviewedChannel: readString(formData, "channel"),
      reviewedProposalId: readString(formData, "proposalId"),
      reviewedCustomerId: readString(formData, "customerId"),
      reviewedDestinationFingerprint: readString(formData, "destinationFingerprint"),
    });
    revalidateDayRouteSurfaces(sent.jobId);
    return { ok: true, message: DAY_ROUTE_APPOINTMENT_NOTICE_SENT_MESSAGE };
  } catch (error) {
    return {
      error: dayRouteAppointmentNoticeErrorMessage(
        error,
        DAY_ROUTE_APPOINTMENT_NOTICE_MISSING_JOB_MESSAGE,
      ),
    };
  }
}

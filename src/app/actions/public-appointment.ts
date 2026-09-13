"use server";

import { revalidatePath } from "next/cache";
import { readAccessArrangementFromFormData } from "@/lib/access-arrangement-form";
import {
  appointmentAwaitingCustomerAction,
  isCurrentAppointmentConfirmed,
  parseAppointmentChangeRequestNote,
} from "@/lib/appointment-confirmation";
import {
  ensureAppointmentConfirmationSchema,
  recordAppointmentEvent,
} from "@/lib/appointment-data";
import { accessArrangementWriteData } from "@/lib/property-access";
import { prisma } from "@/lib/prisma";

export type CustomerAppointmentActionState = {
  status?: string;
  error?: string;
};

const GENERIC_ERROR = "This appointment is not available.";
const STALE_ERROR =
  "The appointment time has changed. Open your project to review the new time.";
const NOT_READY_ERROR = "This appointment is not ready to respond to.";

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function parseProposalId(value: string) {
  if (!/^\d+$/.test(value)) return null;
  return Number(value);
}

/**
 * SECURITY: customer appointment mutations look a Job up ONLY by the
 * unguessable Job.projectToken. They never accept a client-supplied
 * businessId, customerId, or jobId. Confirm and request-different-time
 * cannot change pricing, scope, Job.status, invoices, or the scheduled slot.
 */
async function findJobByToken(token: string) {
  if (!token) return null;
  await ensureAppointmentConfirmationSchema(prisma);
  return prisma.job.findUnique({
    where: { projectToken: token },
    select: {
      id: true,
      businessId: true,
      projectToken: true,
      scheduledAt: true,
      scheduledDurationMinutes: true,
      appointmentConfirmationStatus: true,
      appointmentProposalId: true,
      appointmentConfirmedForProposalId: true,
      appointmentConfirmationSource: true,
      propertyAccessMethod: true,
      propertyAccessInstructions: true,
      propertyAccessContactName: true,
      propertyAccessContactInfo: true,
      propertyAccessPickupLocation: true,
      propertyAccessNote: true,
      appointmentChangeRequestNote: true,
    },
  });
}

export async function confirmAppointment(
  _prev: CustomerAppointmentActionState,
  formData: FormData,
): Promise<CustomerAppointmentActionState> {
  const token = readString(formData, "projectToken");
  const proposalId = parseProposalId(readString(formData, "appointmentProposalId"));
  const accessArrangement = readAccessArrangementFromFormData(formData);

  if (!token || proposalId == null) {
    return { error: GENERIC_ERROR };
  }
  if (!accessArrangement.ok) {
    return { error: accessArrangement.error };
  }

  const job = await findJobByToken(token);
  if (!job || !job.scheduledAt) {
    return { error: GENERIC_ERROR };
  }
  if (job.appointmentProposalId !== proposalId) {
    return { error: STALE_ERROR };
  }

  if (isCurrentAppointmentConfirmed(job)) {
    return { status: "CONFIRMED" };
  }

  if (!appointmentAwaitingCustomerAction(job) && job.appointmentConfirmationStatus !== "NONE") {
    return { error: NOT_READY_ERROR };
  }

  const updated = await prisma.job.updateMany({
    where: {
      id: job.id,
      projectToken: token,
      appointmentProposalId: proposalId,
      appointmentConfirmationStatus: {
        in: ["NONE", "AWAITING_CUSTOMER", "DIFFERENT_TIME_REQUESTED"],
      },
    },
    data: {
      appointmentConfirmationStatus: "CONFIRMED",
      appointmentConfirmedAt: new Date(),
      appointmentConfirmedForProposalId: proposalId,
      appointmentConfirmationSource: "PORTAL",
      appointmentConfirmedByMembershipId: null,
      appointmentChangeRequestNote: null,
      ...accessArrangementWriteData(accessArrangement.value),
    },
  });

  if (updated.count !== 1) {
    const latest = await findJobByToken(token);
    if (latest && isCurrentAppointmentConfirmed(latest) && latest.appointmentProposalId === proposalId) {
      return { status: "CONFIRMED" };
    }
    if (latest && latest.appointmentProposalId !== proposalId) {
      return { error: STALE_ERROR };
    }
    return { error: NOT_READY_ERROR };
  }

  await recordAppointmentEvent(prisma, {
    businessId: job.businessId,
    jobId: job.id,
    eventType: "APPOINTMENT_CONFIRMED",
    appointmentProposalId: proposalId,
    scheduledAt: job.scheduledAt,
    scheduledDurationMinutes: job.scheduledDurationMinutes,
    actorKind: "CUSTOMER",
    payload: { confirmationSource: "PORTAL", accessMethod: accessArrangement.value.method },
  });

  revalidatePath(`/p/${token}`);
  revalidatePath(`/jobs/${job.id}`);
  revalidatePath("/jobs");
  return { status: "CONFIRMED" };
}

export async function requestDifferentAppointmentTime(
  _prev: CustomerAppointmentActionState,
  formData: FormData,
): Promise<CustomerAppointmentActionState> {
  const token = readString(formData, "projectToken");
  const proposalId = parseProposalId(readString(formData, "appointmentProposalId"));

  if (!token || proposalId == null) {
    return { error: GENERIC_ERROR };
  }

  const job = await findJobByToken(token);
  if (!job || !job.scheduledAt) {
    return { error: GENERIC_ERROR };
  }
  if (job.appointmentProposalId !== proposalId) {
    return { error: STALE_ERROR };
  }
  const note = parseAppointmentChangeRequestNote(
    readString(formData, "changeRequestNote"),
  );

  if (job.appointmentConfirmationStatus === "DIFFERENT_TIME_REQUESTED") {
    return { status: "DIFFERENT_TIME_REQUESTED" };
  }

  const updated = await prisma.job.updateMany({
    where: {
      id: job.id,
      projectToken: token,
      appointmentProposalId: proposalId,
      appointmentConfirmationStatus: {
        in: ["NONE", "AWAITING_CUSTOMER", "CONFIRMED"],
      },
    },
    data: {
      appointmentConfirmationStatus: "DIFFERENT_TIME_REQUESTED",
      appointmentConfirmedAt: null,
      appointmentConfirmationSource: null,
      appointmentConfirmedByMembershipId: null,
      appointmentChangeRequestNote: note,
    },
  });

  if (updated.count !== 1) {
    const latest = await findJobByToken(token);
    if (latest?.appointmentConfirmationStatus === "DIFFERENT_TIME_REQUESTED") {
      return { status: "DIFFERENT_TIME_REQUESTED" };
    }
    if (latest && latest.appointmentProposalId !== proposalId) {
      return { error: STALE_ERROR };
    }
    return { error: NOT_READY_ERROR };
  }

  await recordAppointmentEvent(prisma, {
    businessId: job.businessId,
    jobId: job.id,
    eventType: "APPOINTMENT_DIFFERENT_TIME_REQUESTED",
    appointmentProposalId: proposalId,
    scheduledAt: job.scheduledAt,
    scheduledDurationMinutes: job.scheduledDurationMinutes,
    actorKind: "CUSTOMER",
    payload: { changeRequestNote: note },
  });

  revalidatePath(`/p/${token}`);
  revalidatePath(`/jobs/${job.id}`);
  revalidatePath("/jobs");
  return { status: "DIFFERENT_TIME_REQUESTED" };
}

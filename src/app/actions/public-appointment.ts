"use server";

import { revalidatePath } from "next/cache";
import { readAccessArrangementFromFormData } from "@/lib/access-arrangement-form";
import {
  customerDifferentTimeRequestTouchesAccess,
  customerDifferentTimeRequestWriteData,
  isAppointmentChangeRequestSubmission,
  readAppointmentChangeRequestNoteFromFormData,
  withoutMisfiledChangeRequestAccess,
} from "@/lib/appointment-change-request";
import {
  appointmentAwaitingCustomerAction,
  isCurrentAppointmentConfirmed,
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

function revalidateAppointmentSurfaces(token: string, jobId: string) {
  revalidatePath(`/p/${token}`);
  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/jobs");
}

/**
 * Single portal entry so Confirm and Request Different Time cannot be
 * mixed up by two useActionState hooks in one client component.
 */
export async function submitCustomerAppointmentAction(
  prev: CustomerAppointmentActionState,
  formData: FormData,
): Promise<CustomerAppointmentActionState> {
  if (isAppointmentChangeRequestSubmission(formData)) {
    return applyRequestDifferentAppointmentTime(formData);
  }
  return applyConfirmAppointment(formData);
}

export async function confirmAppointment(
  _prev: CustomerAppointmentActionState,
  formData: FormData,
): Promise<CustomerAppointmentActionState> {
  if (isAppointmentChangeRequestSubmission(formData)) {
    return applyRequestDifferentAppointmentTime(formData);
  }
  return applyConfirmAppointment(formData);
}

export async function requestDifferentAppointmentTime(
  _prev: CustomerAppointmentActionState,
  formData: FormData,
): Promise<CustomerAppointmentActionState> {
  return applyRequestDifferentAppointmentTime(formData);
}

async function applyConfirmAppointment(
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
      ...accessArrangementWriteData(
        withoutMisfiledChangeRequestAccess(accessArrangement.value, job),
      ),
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

  revalidateAppointmentSurfaces(token, job.id);
  return { status: "CONFIRMED" };
}

async function applyRequestDifferentAppointmentTime(
  formData: FormData,
): Promise<CustomerAppointmentActionState> {
  const token = readString(formData, "projectToken");
  const proposalId = parseProposalId(readString(formData, "appointmentProposalId"));
  const note = readAppointmentChangeRequestNoteFromFormData(formData);

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

  const write = customerDifferentTimeRequestWriteData(note);
  if (customerDifferentTimeRequestTouchesAccess(write)) {
    return { error: GENERIC_ERROR };
  }

  const previousAccess = {
    propertyAccessMethod: job.propertyAccessMethod,
    propertyAccessInstructions: job.propertyAccessInstructions,
    propertyAccessContactName: job.propertyAccessContactName,
    propertyAccessContactInfo: job.propertyAccessContactInfo,
    propertyAccessPickupLocation: job.propertyAccessPickupLocation,
    propertyAccessNote: job.propertyAccessNote,
  };

  const updated = await prisma.job.updateMany({
    where: {
      id: job.id,
      projectToken: token,
      appointmentProposalId: proposalId,
      appointmentConfirmationStatus: {
        in: ["NONE", "AWAITING_CUSTOMER", "CONFIRMED", "DIFFERENT_TIME_REQUESTED"],
      },
    },
    data: write,
  });

  if (updated.count !== 1) {
    return { error: NOT_READY_ERROR };
  }

  const latest = await findJobByToken(token);
  if (
    latest &&
    (latest.propertyAccessMethod !== previousAccess.propertyAccessMethod ||
      latest.propertyAccessInstructions !== previousAccess.propertyAccessInstructions ||
      latest.propertyAccessNote !== previousAccess.propertyAccessNote ||
      latest.propertyAccessContactName !== previousAccess.propertyAccessContactName ||
      latest.propertyAccessContactInfo !== previousAccess.propertyAccessContactInfo ||
      latest.propertyAccessPickupLocation !== previousAccess.propertyAccessPickupLocation)
  ) {
    await prisma.job.update({
      where: { id: job.id },
      data: previousAccess,
    });
    return { error: GENERIC_ERROR };
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

  revalidateAppointmentSurfaces(token, job.id);
  return { status: "DIFFERENT_TIME_REQUESTED" };
}

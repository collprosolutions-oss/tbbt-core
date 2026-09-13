/**
 * Appointment confirmation is orthogonal to Job.status
 * (UNSCHEDULED | SCHEDULED | IN_PROGRESS | COMPLETED).
 *
 * A confirmation is valid only for the current appointmentProposalId and
 * only when required property-access questions have been answered.
 */

import {
  accessArrangementFromJob,
  isAccessArrangementComplete,
} from "@/lib/property-access";

export const APPOINTMENT_CONFIRMATION_STATUSES = [
  "NONE",
  "AWAITING_CUSTOMER",
  "CONFIRMED",
  "DIFFERENT_TIME_REQUESTED",
] as const;

export type AppointmentConfirmationStatus =
  (typeof APPOINTMENT_CONFIRMATION_STATUSES)[number];

export const APPOINTMENT_EVENT_TYPES = [
  "APPOINTMENT_PROPOSED",
  "APPOINTMENT_CONFIRMED",
  "APPOINTMENT_RESCHEDULED",
  "APPOINTMENT_DIFFERENT_TIME_REQUESTED",
  "APPOINTMENT_CONFIRMATION_OVERRIDE",
  "APPOINTMENT_NOTIFICATION_SENT",
  "APPOINTMENT_NOTIFICATION_FAILED",
] as const;

export type AppointmentEventType = (typeof APPOINTMENT_EVENT_TYPES)[number];

export const APPOINTMENT_CONFIRMATION_SOURCES = [
  "PORTAL",
  "OWNER_PHONE",
  "OWNER_TEXT",
  "OWNER_IN_PERSON",
  "OWNER_OTHER",
] as const;

export type AppointmentConfirmationSource =
  (typeof APPOINTMENT_CONFIRMATION_SOURCES)[number];

export const OWNER_CONFIRMATION_METHODS = [
  { id: "OWNER_PHONE", label: "Confirmed by phone" },
  { id: "OWNER_TEXT", label: "Confirmed by text" },
  { id: "OWNER_IN_PERSON", label: "Confirmed in person" },
  { id: "OWNER_OTHER", label: "Other" },
] as const;

export const START_WITHOUT_CONFIRMATION_REASONS = [
  { id: "PHONE", label: "Confirmed by phone" },
  { id: "TEXT", label: "Confirmed by text" },
  { id: "IN_PERSON", label: "Confirmed in person" },
  { id: "IMMEDIATE_SERVICE", label: "Customer requested immediate service" },
  { id: "OTHER", label: "Other" },
] as const;

export const CUSTOMER_HAS_NOT_CONFIRMED_APPOINTMENT =
  "Customer has not confirmed this appointment.";

export const OWNER_DIFFERENT_TIME_ATTENTION_HEADING =
  "CUSTOMER REQUEST / APPOINTMENT CHANGE";
export const OWNER_RECONFIRMATION_ATTENTION_HEADING =
  "APPOINTMENT CHANGED — CUSTOMER RECONFIRMATION REQUIRED";

const MAX_CHANGE_REQUEST_NOTE = 500;

export type AppointmentJobFields = {
  scheduledAt: Date | null;
  scheduledDurationMinutes: number | null;
  appointmentConfirmationStatus: string | null;
  appointmentProposalId: number | null;
  appointmentConfirmedForProposalId: number | null;
  appointmentConfirmationSource: string | null;
  appointmentChangeRequestNote?: string | null;
  propertyAccessMethod: string | null;
  propertyAccessInstructions: string | null;
  propertyAccessContactName: string | null;
  propertyAccessContactInfo: string | null;
  propertyAccessPickupLocation: string | null;
  propertyAccessNote: string | null;
};

export type OwnerAppointmentAttentionKind = "DIFFERENT_TIME" | "RECONFIRMATION";

export function isMaterialAppointmentChange(
  job: { scheduledAt: Date | null; scheduledDurationMinutes: number | null },
  nextStart: Date,
  nextDurationMinutes: number | null,
) {
  if (!job.scheduledAt) return true;
  if (job.scheduledAt.getTime() !== nextStart.getTime()) return true;
  return (job.scheduledDurationMinutes ?? null) !== (nextDurationMinutes ?? null);
}

export function nextAppointmentProposalId(current: number | null | undefined) {
  return (current ?? 0) + 1;
}

export function isCurrentAppointmentConfirmed(job: AppointmentJobFields) {
  if (!job.scheduledAt) return false;
  if (job.appointmentConfirmationStatus !== "CONFIRMED") return false;
  if (job.appointmentConfirmedForProposalId !== job.appointmentProposalId) {
    return false;
  }
  return isAccessArrangementComplete(job);
}

export function effectiveAppointmentConfirmationStatus(
  job: AppointmentJobFields,
): AppointmentConfirmationStatus {
  if (!job.scheduledAt) {
    return "NONE";
  }
  if (isCurrentAppointmentConfirmed(job)) {
    return "CONFIRMED";
  }
  if (
    job.appointmentConfirmationStatus === "DIFFERENT_TIME_REQUESTED" &&
    (job.appointmentConfirmedForProposalId == null ||
      job.appointmentConfirmedForProposalId === job.appointmentProposalId)
  ) {
    // Different-time is stored on the current proposal; a reschedule already
    // reset status to AWAITING_CUSTOMER.
    return "DIFFERENT_TIME_REQUESTED";
  }
  return "AWAITING_CUSTOMER";
}

export function appointmentConfirmationLabel(
  status: AppointmentConfirmationStatus,
) {
  switch (status) {
    case "CONFIRMED":
      return "Customer Confirmed";
    case "DIFFERENT_TIME_REQUESTED":
      return "Different Time Requested";
    case "AWAITING_CUSTOMER":
      return "Awaiting Customer Confirmation";
    default:
      return "Not scheduled";
  }
}

export function customerAppointmentStatusLabel(
  status: AppointmentConfirmationStatus,
) {
  switch (status) {
    case "CONFIRMED":
      return "Appointment confirmed";
    case "DIFFERENT_TIME_REQUESTED":
      return "We received your request for a different time.";
    case "AWAITING_CUSTOMER":
      return "Awaiting Your Confirmation";
    default:
      return "Not scheduled";
  }
}

export function parseAppointmentChangeRequestNote(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_CHANGE_REQUEST_NOTE);
}

/**
 * Owner Work Order attention. Distinct from property-access copy.
 * DIFFERENT_TIME takes precedence until the owner reschedules.
 * After a previously confirmed slot is rescheduled, the last confirmed
 * proposal id is kept as a stale binding so reconfirmation is required.
 */
export function ownerAppointmentAttention(
  job: AppointmentJobFields,
): OwnerAppointmentAttentionKind | null {
  if (!job.scheduledAt) return null;
  const status = effectiveAppointmentConfirmationStatus(job);
  if (status === "DIFFERENT_TIME_REQUESTED") {
    return "DIFFERENT_TIME";
  }
  if (status === "CONFIRMED") {
    return null;
  }
  if (
    job.appointmentConfirmedForProposalId != null &&
    job.appointmentConfirmedForProposalId !== job.appointmentProposalId
  ) {
    return "RECONFIRMATION";
  }
  return null;
}

export function confirmationSourceLabel(source: string | null | undefined) {
  switch (source) {
    case "PORTAL":
      return "Customer confirmed through portal";
    case "OWNER_PHONE":
      return "Owner recorded confirmation — phone";
    case "OWNER_TEXT":
      return "Owner recorded confirmation — text";
    case "OWNER_IN_PERSON":
      return "Owner recorded confirmation — in person";
    case "OWNER_OTHER":
      return "Owner recorded confirmation — other";
    default:
      return null;
  }
}

export function isOwnerConfirmationSource(
  value: string,
): value is AppointmentConfirmationSource {
  return OWNER_CONFIRMATION_METHODS.some((method) => method.id === value);
}

export function parseStartWithoutConfirmationReason(value: string) {
  return START_WITHOUT_CONFIRMATION_REASONS.find((reason) => reason.id === value) ?? null;
}

export function startJobRequiresCustomerConfirmation(job: AppointmentJobFields) {
  return !isCurrentAppointmentConfirmed(job);
}

export function appointmentAwaitingCustomerAction(job: AppointmentJobFields) {
  const status = effectiveAppointmentConfirmationStatus(job);
  return status === "AWAITING_CUSTOMER" || status === "DIFFERENT_TIME_REQUESTED";
}

export function customerNotificationNeeded(job: {
  scheduledAt: Date | null;
  appointmentProposalId: number | null;
  appointmentNotificationStatus: string | null;
  appointmentNotifiedForProposalId: number | null;
}) {
  if (!job.scheduledAt) return false;
  if (job.appointmentNotifiedForProposalId !== job.appointmentProposalId) {
    return true;
  }
  return job.appointmentNotificationStatus !== "SENT";
}

export function notificationOwnerMessage(job: {
  appointmentNotificationStatus: string | null;
  appointmentNotificationError: string | null;
}) {
  if (job.appointmentNotificationStatus === "SENT") {
    return null;
  }
  if (job.appointmentNotificationStatus === "SKIPPED_NO_EMAIL") {
    return "This customer has no usable email. Copy the project link or retry after an email is on file.";
  }
  if (job.appointmentNotificationStatus === "NOT_CONFIGURED") {
    return "Email delivery is not configured, so the customer was not notified.";
  }
  if (job.appointmentNotificationStatus === "FAILED") {
    return (
      job.appointmentNotificationError ||
      "The appointment email could not be sent."
    );
  }
  return "The customer has not been notified of this appointment.";
}

export function eventPayload(values: Record<string, string | number | boolean | null | undefined>) {
  const cleaned: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined || value === "") continue;
    cleaned[key] = value;
  }
  return JSON.stringify(cleaned);
}

export function accessArrangementSnapshot(job: AppointmentJobFields) {
  const arrangement = accessArrangementFromJob(job);
  return arrangement ? { accessMethod: arrangement.method } : {};
}

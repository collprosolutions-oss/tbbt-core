/**
 * Day-route appointment notice copy, preview, and input parsing.
 *
 * After an OWNER records an appointment change, this path offers a
 * separate review-and-send. Page load and the appointment change itself
 * never send. The reviewed window is the recorded appointment, not a
 * travel arrival or a rearranged route.
 */
import { customerNotificationNeeded } from "@/lib/appointment-confirmation";
import {
  evaluateComposeChannelEligibility,
  type ChannelEligibility,
} from "@/lib/communications/consent";
import type { CommunicationChannel } from "@/lib/communications/types";
import { formatDate } from "@/lib/format";
import { parseOwnerDayRouteScheduleSnapshot } from "@/lib/owner-day-route/snapshot";
import type { OwnerDayRouteScheduleSnapshot } from "@/lib/owner-day-route/types";
import { ownerTodayTimeWindowLabel } from "@/lib/owner-today";
import type { SettingsPreferenceFlags } from "@/lib/settings";

export const DAY_ROUTE_APPOINTMENT_NOTICE_OWNER_ONLY_MESSAGE =
  "Only the business owner can send an appointment notice from the day route.";

export const DAY_ROUTE_APPOINTMENT_NOTICE_STALE_MESSAGE =
  "This appointment changed since the page was loaded. Refresh and try again.";

export const DAY_ROUTE_APPOINTMENT_NOTICE_FOREIGN_MESSAGE =
  "That job could not be notified from this workspace.";

export const DAY_ROUTE_APPOINTMENT_NOTICE_UNAVAILABLE_MESSAGE =
  "No available customer channel can receive this appointment notice.";

export const DAY_ROUTE_APPOINTMENT_NOTICE_DUPLICATE_MESSAGE =
  "A notice was already sent for this recorded appointment change.";

export const DAY_ROUTE_APPOINTMENT_NOTICE_IN_PROGRESS_MESSAGE =
  "A send is already in progress for this recorded appointment change.";

export const DAY_ROUTE_APPOINTMENT_NOTICE_CLAIM_LEASE_MS = 2 * 60 * 1000;

export const DAY_ROUTE_APPOINTMENT_NOTICE_UNCONFIRMED_MESSAGE =
  "Review the recorded window and recipient, then confirm send.";

export const DAY_ROUTE_APPOINTMENT_NOTICE_MISSING_JOB_MESSAGE =
  "That appointment notice could not be sent.";

export const DAY_ROUTE_APPOINTMENT_NOTICE_NOT_RECORDED_MESSAGE =
  "Send an appointment notice only after a recorded day-route appointment change.";

export const DAY_ROUTE_APPOINTMENT_NOTICE_SENT_MESSAGE =
  "Appointment notice sent for the recorded window. This is not a live travel arrival.";

export const DAY_ROUTE_APPOINTMENT_NOTICE_FORM_NOTE =
  "Review the recorded appointment window and the customer recipient. Sending uses the existing communication channel and consent rules. This does not invent an arrival time and does not rearrange travel.";

export const DAY_ROUTE_APPOINTMENT_NOTICE_SUBMIT_LABEL = "Send appointment notice";

export const DAY_ROUTE_APPOINTMENT_NOTICE_CONFIRM_VALUE = "send";

export type DayRouteAppointmentNoticeChannel = Extract<
  CommunicationChannel,
  "EMAIL" | "SMS"
>;

export type OwnerDayRouteAppointmentNoticePreview = {
  jobId: string;
  proposalId: number;
  customerId: string | null;
  destinationFingerprint: string | null;
  appointmentWindowLabel: string;
  channel: DayRouteAppointmentNoticeChannel | null;
  channelLabel: string;
  recipientLabel: string;
  available: boolean;
  alreadySent: boolean;
  offerSend: boolean;
  sendInProgress: boolean;
  unavailableReason: string | null;
  snapshot: OwnerDayRouteScheduleSnapshot;
};

export type DayRouteAppointmentNoticeReviewSnapshot = OwnerDayRouteScheduleSnapshot & {
  customerId: string;
  destinationFingerprint: string;
};

export type DayRouteAppointmentNoticeCustomer = {
  id?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  smsConsentStatus?: string | null;
};

export type DayRouteAppointmentNoticeJob = {
  id: string;
  businessId: string;
  customerId?: string | null;
  status: string;
  scheduledAt: Date | null;
  scheduledDurationMinutes: number | null;
  arrivalWindowMinutes?: number | null;
  pickupDurationMinutes?: number | null;
  assignedMembershipId?: string | null;
  appointmentProposalId?: number | null;
  appointmentNotificationStatus?: string | null;
  appointmentNotifiedForProposalId?: number | null;
  projectToken?: string | null;
  customer?: DayRouteAppointmentNoticeCustomer | null;
};

export function parseDayRouteAppointmentNoticeSnapshot(
  raw: string,
  jobId: string,
): OwnerDayRouteScheduleSnapshot | null {
  const snapshot = parseOwnerDayRouteScheduleSnapshot(raw);
  if (!snapshot || snapshot.jobId !== jobId) return null;
  return snapshot;
}

function readReviewBindingField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function parseDayRouteAppointmentNoticeReviewSnapshot(
  raw: string,
  jobId: string,
): DayRouteAppointmentNoticeReviewSnapshot | null {
  const snapshot = parseDayRouteAppointmentNoticeSnapshot(raw, jobId);
  if (!snapshot) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const customerId = readReviewBindingField(value.customerId);
    const destinationFingerprint = readReviewBindingField(value.destinationFingerprint);
    if (!customerId || !destinationFingerprint) return null;
    return {
      ...snapshot,
      customerId,
      destinationFingerprint,
    };
  } catch {
    return null;
  }
}

export function serializeDayRouteAppointmentNoticeReviewSnapshot(
  snapshot: DayRouteAppointmentNoticeReviewSnapshot,
) {
  return JSON.stringify({
    jobId: snapshot.jobId,
    scheduledAt: snapshot.scheduledAt,
    status: snapshot.status,
    pickupDurationMinutes: snapshot.pickupDurationMinutes,
    arrivalWindowMinutes: snapshot.arrivalWindowMinutes,
    assignedMembershipId: snapshot.assignedMembershipId,
    customerId: snapshot.customerId,
    destinationFingerprint: snapshot.destinationFingerprint,
  });
}

export function scheduleFieldsFromNoticeReview(
  snapshot: DayRouteAppointmentNoticeReviewSnapshot,
): OwnerDayRouteScheduleSnapshot {
  return {
    jobId: snapshot.jobId,
    scheduledAt: snapshot.scheduledAt,
    status: snapshot.status,
    pickupDurationMinutes: snapshot.pickupDurationMinutes,
    arrivalWindowMinutes: snapshot.arrivalWindowMinutes,
    assignedMembershipId: snapshot.assignedMembershipId,
  };
}

/** First schedule (APPOINTMENT_PROPOSED only) is not a recorded change. */
export function recordedDayRouteAppointmentNoticeEligible(
  job: {
    status: string;
    scheduledAt: Date | null;
    appointmentProposalId?: number | null;
    appointmentNotificationStatus?: string | null;
    appointmentNotifiedForProposalId?: number | null;
  },
  extras?: { recordedReschedule?: boolean },
) {
  if (extras?.recordedReschedule !== true) return false;
  if (job.status === "COMPLETED" || job.status === "CANCELLED") return false;
  if (!job.scheduledAt) return false;
  const proposalId = job.appointmentProposalId ?? 0;
  if (proposalId <= 0) return false;
  return customerNotificationNeeded({
    scheduledAt: job.scheduledAt,
    appointmentProposalId: proposalId,
    appointmentNotificationStatus: job.appointmentNotificationStatus ?? null,
    appointmentNotifiedForProposalId: job.appointmentNotifiedForProposalId ?? null,
  });
}

export function dayRouteAppointmentNoticeDestinationFingerprint(
  eligibility: ChannelEligibility | null,
) {
  const fingerprint = eligibility?.fingerprint?.trim() ?? "";
  return fingerprint || null;
}

export function dayRouteAppointmentNoticeClaimLeaseCutoff(now = new Date()) {
  return new Date(now.getTime() - DAY_ROUTE_APPOINTMENT_NOTICE_CLAIM_LEASE_MS);
}

export function dayRouteAppointmentNoticeClaimInProgress(
  claim: { status: string; attemptedAt: Date | null } | null | undefined,
  now = new Date(),
) {
  if (!claim || claim.status !== "READY" || !claim.attemptedAt) return false;
  return now.getTime() - claim.attemptedAt.getTime() < DAY_ROUTE_APPOINTMENT_NOTICE_CLAIM_LEASE_MS;
}

export function sanitizeDayRouteAppointmentNoticeBusinessName(businessName: string) {
  return businessName.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim() || "Your contractor";
}

export function dayRouteAppointmentNoticeIdempotencyKey(
  jobId: string,
  proposalId: number,
) {
  return `day-route-appointment-notice:${jobId}:${proposalId}`;
}

export function describeRecordedAppointmentWindow(
  job: {
    scheduledAt: Date | null;
    scheduledDurationMinutes: number | null;
    arrivalWindowMinutes?: number | null;
  },
  timeZone: string,
) {
  if (!job.scheduledAt) return null;
  const window = ownerTodayTimeWindowLabel(job, timeZone);
  const date = formatDate(job.scheduledAt, timeZone);
  return window ? `${date}, ${window}` : date;
}

export function dayRouteAppointmentNoticeChannelLabel(
  channel: DayRouteAppointmentNoticeChannel | null,
) {
  if (channel === "EMAIL") return "Email";
  if (channel === "SMS") return "SMS";
  return "None";
}

export function dayRouteAppointmentNoticeRecipientLabel(
  channel: DayRouteAppointmentNoticeChannel,
  eligibility: ChannelEligibility,
  email: string | null | undefined,
) {
  if (channel === "EMAIL") {
    const address = email?.trim() ?? "";
    return address || "Email on file";
  }
  return eligibility.last4 ? `SMS ending ${eligibility.last4}` : "SMS on file";
}

export function resolveDayRouteAppointmentNoticeChannel(input: {
  businessId: string;
  email: string | null | undefined;
  phone: string | null | undefined;
  smsConsentStatus: string | null | undefined;
  preferences: Partial<SettingsPreferenceFlags> | null | undefined;
  smsEntitled: boolean;
  smsConfigured: boolean;
  emailConfigured: boolean;
}): {
  channel: DayRouteAppointmentNoticeChannel | null;
  eligibility: ChannelEligibility | null;
  available: boolean;
  unavailableReason: string | null;
} {
  const email = evaluateComposeChannelEligibility({
    businessId: input.businessId,
    channel: "EMAIL",
    email: input.email,
    phone: input.phone,
    smsConsentStatus: input.smsConsentStatus,
    purpose: "SCHEDULE_CHANGE",
    preferences: input.preferences,
    smsEntitled: input.smsEntitled,
    smsConfigured: input.smsConfigured,
    emailConfigured: input.emailConfigured,
  });
  if (email.available) {
    return {
      channel: "EMAIL",
      eligibility: email,
      available: true,
      unavailableReason: null,
    };
  }

  const sms = evaluateComposeChannelEligibility({
    businessId: input.businessId,
    channel: "SMS",
    email: input.email,
    phone: input.phone,
    smsConsentStatus: input.smsConsentStatus,
    purpose: "SCHEDULE_CHANGE",
    preferences: input.preferences,
    smsEntitled: input.smsEntitled,
    smsConfigured: input.smsConfigured,
    emailConfigured: input.emailConfigured,
  });
  if (sms.available) {
    return {
      channel: "SMS",
      eligibility: sms,
      available: true,
      unavailableReason: null,
    };
  }

  const reason =
    email.ownerReason || sms.ownerReason || DAY_ROUTE_APPOINTMENT_NOTICE_UNAVAILABLE_MESSAGE;
  return {
    channel: email.reason === "missing_email" && sms.reason !== "missing_phone" ? "SMS" : "EMAIL",
    eligibility: email.reason === "missing_email" ? sms : email,
    available: false,
    unavailableReason: reason,
  };
}

export function buildOwnerDayRouteAppointmentNoticePreview(input: {
  job: DayRouteAppointmentNoticeJob;
  snapshot: OwnerDayRouteScheduleSnapshot;
  timeZone: string;
  businessId: string;
  preferences: Partial<SettingsPreferenceFlags> | null | undefined;
  smsEntitled: boolean;
  smsConfigured: boolean;
  emailConfigured: boolean;
  recordedReschedule?: boolean;
  claim?: { status: string; attemptedAt: Date | null } | null;
}): OwnerDayRouteAppointmentNoticePreview | null {
  if (input.job.businessId !== input.businessId) return null;
  if (
    !recordedDayRouteAppointmentNoticeEligible(input.job, {
      recordedReschedule: input.recordedReschedule === true,
    })
  ) {
    return null;
  }

  const resolved = resolveDayRouteAppointmentNoticeChannel({
    businessId: input.businessId,
    email: input.job.customer?.email,
    phone: input.job.customer?.phone,
    smsConsentStatus: input.job.customer?.smsConsentStatus,
    preferences: input.preferences,
    smsEntitled: input.smsEntitled,
    smsConfigured: input.smsConfigured,
    emailConfigured: input.emailConfigured,
  });
  const windowLabel =
    describeRecordedAppointmentWindow(input.job, input.timeZone) ?? "Recorded appointment";
  const channel = resolved.channel;
  const destinationFingerprint = dayRouteAppointmentNoticeDestinationFingerprint(
    resolved.eligibility,
  );
  const customerId = input.job.customer?.id ?? input.job.customerId ?? null;
  const recipientLabel =
    channel && resolved.eligibility
      ? dayRouteAppointmentNoticeRecipientLabel(
          channel,
          resolved.eligibility,
          input.job.customer?.email,
        )
      : "No recipient";
  const sendInProgress = dayRouteAppointmentNoticeClaimInProgress(input.claim);
  const canSend = resolved.available && Boolean(customerId) && Boolean(destinationFingerprint);

  return {
    jobId: input.job.id,
    proposalId: input.job.appointmentProposalId ?? 0,
    customerId,
    destinationFingerprint,
    appointmentWindowLabel: windowLabel,
    channel,
    channelLabel: dayRouteAppointmentNoticeChannelLabel(channel),
    recipientLabel,
    available: resolved.available && !sendInProgress,
    alreadySent: false,
    offerSend: canSend && !sendInProgress,
    sendInProgress,
    unavailableReason: sendInProgress
      ? DAY_ROUTE_APPOINTMENT_NOTICE_IN_PROGRESS_MESSAGE
      : resolved.available
        ? null
        : resolved.unavailableReason,
    snapshot: input.snapshot,
  };
}

export function buildDayRouteAppointmentNoticeBody(input: {
  businessName: string;
  appointmentWindowLabel: string;
  projectUrl?: string | null;
}) {
  const business = sanitizeDayRouteAppointmentNoticeBusinessName(input.businessName);
  const lines = [
    `${business} updated your appointment.`,
    "",
    `Recorded window: ${input.appointmentWindowLabel}`,
    "",
    "This is the recorded appointment time. It is not a live travel arrival.",
  ];
  if (input.projectUrl) {
    lines.push("", "Confirm or request a different time in your project portal:", input.projectUrl);
  }
  return lines.join("\n");
}

export function buildDayRouteAppointmentNoticeSubject(businessName: string) {
  const business = sanitizeDayRouteAppointmentNoticeBusinessName(businessName);
  return `Your appointment with ${business} was updated`;
}

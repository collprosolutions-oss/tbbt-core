import { resolveJobTradeCode } from "@/lib/cleaning-visit-workflow";
import type { NativePushAlertPayload, NativePushKind } from "@/lib/native-push/types";

export const NATIVE_PUSH_FORBIDDEN_PAYLOAD_KEYS = [
  "address",
  "addressLine1",
  "addressLine2",
  "city",
  "region",
  "postalCode",
  "customerName",
  "customerPhone",
  "phone",
  "email",
  "accessCode",
  "access",
  "gateCode",
  "lockbox",
  "propertyAccessMethod",
  "propertyAccessInstructions",
  "propertyAccessContactName",
  "propertyAccessContactInfo",
  "propertyAccessPickupLocation",
  "propertyAccessNote",
  "startTime",
  "acceptAppointment",
] as const;

export const NATIVE_PUSH_ASSIGNED_TITLE = "New job assigned";
export const NATIVE_PUSH_ASSIGNED_BODY =
  "A Handyman job was assigned to you. This notice does not start your time.";
export const NATIVE_PUSH_RESCHEDULED_TITLE = "Job rescheduled";
export const NATIVE_PUSH_RESCHEDULED_BODY =
  "A Handyman job on your list was rescheduled. This notice does not accept the appointment.";

export const NATIVE_PUSH_ALERT_DISCLAIMER =
  "Job alerts are optional. A notice is informational only — it never starts time or accepts an appointment.";

export function isHandymanJobForNativePush(input: {
  requestTradeCode?: string | null;
  catalogTradeCodes?: Array<string | null | undefined>;
}) {
  return resolveJobTradeCode(input) === "HANDYMAN";
}

export function isOwnerSideNativePushActor(role: string) {
  return role === "OWNER" || role === "ADMIN";
}

export function buildNativePushAlertPayload(input: {
  kind: NativePushKind;
  jobId: string;
}): NativePushAlertPayload {
  const assigned = input.kind === "JOB_ASSIGNED";
  return {
    kind: input.kind,
    jobId: input.jobId,
    title: assigned ? NATIVE_PUSH_ASSIGNED_TITLE : NATIVE_PUSH_RESCHEDULED_TITLE,
    body: assigned ? NATIVE_PUSH_ASSIGNED_BODY : NATIVE_PUSH_RESCHEDULED_BODY,
    informational: true,
    startsTime: false,
    acceptsAppointment: false,
  };
}

export function nativePushAlertAction(_payload: NativePushAlertPayload) {
  return {
    kind: "open-job" as const,
    startsTime: false,
    acceptsAppointment: false,
  };
}

export function nativePushPayloadHasForbiddenFields(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return true;
  }
  const record = payload as Record<string, unknown>;
  for (const key of NATIVE_PUSH_FORBIDDEN_PAYLOAD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      return true;
    }
  }
  return record.informational !== true || record.startsTime !== false || record.acceptsAppointment !== false;
}

export function assignmentAlertIdempotencyKey(input: {
  jobId: string;
  nextMembershipId: string;
  previousMembershipId: string | null;
  committedAt: Date;
}) {
  return `JOB_ASSIGNED:${input.jobId}:${input.nextMembershipId}:from:${input.previousMembershipId ?? "none"}:${input.committedAt.toISOString()}`;
}

export function rescheduleAlertIdempotencyKey(input: {
  jobId: string;
  membershipId: string;
  proposalId: number;
}) {
  return `JOB_RESCHEDULED:${input.jobId}:${input.membershipId}:${input.proposalId}`;
}

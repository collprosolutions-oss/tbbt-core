export const COMMUNICATION_CHANNELS = [
  "EMAIL",
  "SMS",
  "PHONE",
  "MANUAL",
  "PORTAL",
  "SYSTEM",
] as const;
export type CommunicationChannel = (typeof COMMUNICATION_CHANNELS)[number];

export const COMMUNICATION_DIRECTIONS = ["INBOUND", "OUTBOUND"] as const;
export type CommunicationDirection = (typeof COMMUNICATION_DIRECTIONS)[number];

export const COMMUNICATION_DEPARTMENT_PURPOSES = [
  "ESTIMATE_FOLLOW_UP",
  "APPOINTMENT_REMINDER",
  "JOB_UPDATE",
  "PAYMENT_REMINDER",
  "REVIEW_REQUEST",
  "GENERAL",
  "OWNER_FOLLOW_UP",
  "MISSED_CALL",
  "MANUAL_PHONE",
  "INBOUND_CALL",
] as const;
export type CommunicationDepartmentPurpose =
  (typeof COMMUNICATION_DEPARTMENT_PURPOSES)[number];

export const COMMUNICATION_COMPOSE_TEMPLATES = [
  "estimate_follow_up",
  "appointment_reminder",
  "job_update",
  "invoice_reminder",
  "review_request",
  "general",
] as const;
export type CommunicationComposeTemplate =
  (typeof COMMUNICATION_COMPOSE_TEMPLATES)[number];

export const COMMUNICATION_RELATED_TYPES = [
  "ESTIMATE",
  "JOB",
  "INVOICE",
  "REVIEW_REQUEST",
  "REFERRAL_REQUEST",
  "CUSTOMER_FOLLOW_UP",
  "SERVICE_REQUEST",
  "PHONE_INTERACTION",
  "PROPERTY",
] as const;
export type CommunicationRelatedType = (typeof COMMUNICATION_RELATED_TYPES)[number];

export const COMMUNICATION_AREAS = [
  "inbox",
  "compose",
  "missed-calls",
  "receptionist",
  "automation",
] as const;
export type CommunicationArea = (typeof COMMUNICATION_AREAS)[number];

export const COMMUNICATION_AREA_LABELS: Record<CommunicationArea, string> = {
  inbox: "Inbox",
  compose: "Compose",
  "missed-calls": "Missed calls",
  receptionist: "Receptionist",
  automation: "Automation",
};

export function isCommunicationArea(value: string | undefined): value is CommunicationArea {
  return (COMMUNICATION_AREAS as readonly string[]).includes(value ?? "");
}

export function parseCommunicationArea(raw: string | undefined): CommunicationArea {
  return isCommunicationArea(raw) ? raw : "inbox";
}

export function isCommunicationChannel(value: string): value is CommunicationChannel {
  return (COMMUNICATION_CHANNELS as readonly string[]).includes(value);
}

export function isCommunicationComposeTemplate(
  value: string,
): value is CommunicationComposeTemplate {
  return (COMMUNICATION_COMPOSE_TEMPLATES as readonly string[]).includes(value);
}

export const RECEPTIONIST_CAPABILITIES = [
  "INBOUND_CALL_EVENT",
  "CALLER_LOOKUP",
  "REQUEST_QUALIFICATION",
  "CREATE_CUSTOMER_OR_REQUEST",
  "PROPOSE_SCHEDULING",
  "MESSAGE_SUMMARY",
  "ESCALATE_TO_OWNER",
] as const;
export type ReceptionistCapability = (typeof RECEPTIONIST_CAPABILITIES)[number];

export const VOICE_NOT_CONNECTED_REASON =
  "No voice provider is connected. TBBT does not buy or provision phone numbers from Communications, and it will not invent a completed call.";

export const SMS_ADDON_NOT_ENTITLED_REASON =
  "Paid SMS compose requires the SMS Messaging add-on. Ordinary email does not.";

export const EMAIL_NOT_CONFIGURED_REASON = "Email delivery is not configured.";
export const SMS_NOT_CONFIGURED_REASON = "SMS delivery is not connected.";

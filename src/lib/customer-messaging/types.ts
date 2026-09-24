export const CUSTOMER_MESSAGE_CHANNELS = ["SMS"] as const;
export type CustomerMessageChannel = (typeof CUSTOMER_MESSAGE_CHANNELS)[number];

export const CUSTOMER_MESSAGE_PURPOSES = [
  "ESTIMATE_READY",
  "APPOINTMENT_CONFIRMATION",
  "APPOINTMENT_REMINDER",
  "SCHEDULE_CHANGE",
  "INVOICE_READY",
  "PAYMENT_REMINDER",
  "REVIEW_REQUEST",
  "REVIEW_REMINDER",
  "REFERRAL_REQUEST",
  "JOB_FOLLOW_UP",
  "REPEAT_FOLLOW_UP",
] as const;
export type CustomerMessagePurpose = (typeof CUSTOMER_MESSAGE_PURPOSES)[number];

export const CUSTOMER_MESSAGE_RELATED_TYPES = [
  "ESTIMATE",
  "JOB",
  "INVOICE",
  "REVIEW_REQUEST",
  "REFERRAL_REQUEST",
] as const;
export type CustomerMessageRelatedType = (typeof CUSTOMER_MESSAGE_RELATED_TYPES)[number];

export const CUSTOMER_MESSAGE_STATUSES = [
  "DRAFT",
  "READY",
  "QUEUED",
  "ACCEPTED",
  "SENT",
  "DELIVERED",
  "FAILED",
  "BLOCKED",
  "NOT_SENT",
] as const;
export type CustomerMessageStatus = (typeof CUSTOMER_MESSAGE_STATUSES)[number];

export const SMS_CONSENT_STATUSES = ["UNKNOWN", "GRANTED", "REVOKED"] as const;
export type SmsConsentStatus = (typeof SMS_CONSENT_STATUSES)[number];

export const ACCEPTED_CUSTOMER_MESSAGE_STATUSES = [
  "QUEUED",
  "ACCEPTED",
  "SENT",
  "DELIVERED",
] as const;

export type CustomerMessageSendInput = {
  businessId: string;
  communicationId: string;
  channel: CustomerMessageChannel;
  to: string;
  /** Tenant sending/receiving identity (normalized digits). Required for Twilio. */
  from?: string | null;
  body: string;
  purpose: CustomerMessagePurpose;
};

export type CustomerMessageSendResult =
  | {
      ok: true;
      status: "QUEUED" | "ACCEPTED" | "SENT";
      providerMessageId: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      ok: false;
      status: "FAILED" | "NOT_SENT";
      error: string;
      providerMetadata?: Record<string, unknown>;
    };

export type CustomerMessageDeliveryUpdate = {
  provider: string;
  providerMessageId: string;
  status: "QUEUED" | "ACCEPTED" | "SENT" | "DELIVERED" | "FAILED";
  failureReason?: string;
  claimedBusinessId?: string | null;
  providerEventId?: string;
  routingNumber?: string | null;
  providerMetadata?: Record<string, unknown>;
};

export type InboundSmsOptOutType = "STOP" | "START" | "HELP";

export type InboundSmsEvent = {
  provider: string;
  providerEventId: string;
  from: string;
  to: string;
  body: string;
  optOutType: InboundSmsOptOutType | null;
};

export type ParsedCustomerMessagingWebhook =
  | { kind: "delivery"; update: CustomerMessageDeliveryUpdate; providerEventId: string }
  | { kind: "inbound"; inbound: InboundSmsEvent };

export type CustomerMessagingWebhookParseInput = {
  url: string;
  signature: string | null;
  rawBody: string;
  contentType: string | null;
};

export type CustomerMessagingProvider = {
  id: string;
  connected: boolean;
  send(input: CustomerMessageSendInput): Promise<CustomerMessageSendResult>;
  verifyDeliveryCallback?(
    payload: string,
    signature: string | null,
  ): CustomerMessageDeliveryUpdate | null;
  parseWebhook?(
    input: CustomerMessagingWebhookParseInput,
  ): ParsedCustomerMessagingWebhook | null;
};

export type AttemptCustomerSmsInput = {
  businessId: string;
  customerId: string;
  purpose: CustomerMessagePurpose;
  relatedType?: CustomerMessageRelatedType | null;
  relatedId?: string | null;
  idempotencyKey: string;
  body: string;
  initiatedByMembershipId?: string | null;
};

export type CustomerCommunicationAttemptResult = {
  ok: boolean;
  communicationId: string | null;
  status: CustomerMessageStatus;
  provider: string;
  providerMessageId: string | null;
  failureReason: string | null;
  reused: boolean;
};

export function isCustomerMessagePurpose(value: string): value is CustomerMessagePurpose {
  return (CUSTOMER_MESSAGE_PURPOSES as readonly string[]).includes(value);
}

export function isAcceptedCustomerMessageStatus(status: string) {
  return (ACCEPTED_CUSTOMER_MESSAGE_STATUSES as readonly string[]).includes(status);
}

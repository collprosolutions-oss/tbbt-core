export {
  CUSTOMER_MESSAGING_WEBHOOK_PATH,
  DISCONNECTED_CUSTOMER_MESSAGING_PROVIDER,
  FAKE_CUSTOMER_MESSAGING_PROVIDER,
  getCustomerMessagingWebhookSecret,
  isCustomerMessagingConfigured,
  isCustomerMessagingWebhookPath,
  isFakeCustomerMessagingAdapterEnabled,
} from "@/lib/customer-messaging/config";
export {
  isSmsConsentGranted,
  isSmsConsentRevoked,
  isSmsConsentStatus,
  resolveStoredSmsConsent,
} from "@/lib/customer-messaging/consent";
export { createDisconnectedCustomerMessagingProvider } from "@/lib/customer-messaging/disconnected";
export { createFakeCustomerMessagingProvider } from "@/lib/customer-messaging/fake";
export type { FakeCustomerMessagingProvider } from "@/lib/customer-messaging/fake";
export {
  communicationPreferenceEnabled,
  destinationFingerprint,
  evaluateSmsEligibility,
} from "@/lib/customer-messaging/eligibility";
export {
  applyCustomerMessageDeliveryUpdate,
  attemptCustomerSms,
  getCustomerCommunication,
  listCustomerCommunications,
  safeAttemptCustomerSms,
} from "@/lib/customer-messaging/ops";
export {
  getCustomerMessagingProvider,
  resetCustomerMessagingProvider,
  setCustomerMessagingProvider,
} from "@/lib/customer-messaging/provider";
export {
  CUSTOMER_MESSAGING_ENSURE_SQL,
  ensureCustomerMessagingSchema,
  resetCustomerMessagingSchemaEnsure,
} from "@/lib/customer-messaging/schema";
export {
  ACCEPTED_CUSTOMER_MESSAGE_STATUSES,
  CUSTOMER_MESSAGE_PURPOSES,
  CUSTOMER_MESSAGE_STATUSES,
  SMS_CONSENT_STATUSES,
  isAcceptedCustomerMessageStatus,
  isCustomerMessagePurpose,
} from "@/lib/customer-messaging/types";
export type {
  AttemptCustomerSmsInput,
  CustomerCommunicationAttemptResult,
  CustomerMessageDeliveryUpdate,
  CustomerMessagePurpose,
  CustomerMessageStatus,
  CustomerMessagingProvider,
} from "@/lib/customer-messaging/types";
export {
  appointmentConfirmationSmsBody,
  appointmentReminderSmsBody,
  customerSmsIdempotencyKey,
  estimateReadySmsBody,
  invoiceReadySmsBody,
  paymentReminderSmsBody,
  reviewRequestSmsBody,
} from "@/lib/customer-messaging/bodies";
export {
  attemptAppointmentReminderSms,
  attemptAppointmentSms,
  attemptEstimateReadySms,
  attemptInvoiceReadySms,
  attemptPaymentReminderSms,
  attemptReviewRequestSms,
} from "@/lib/customer-messaging/workflows";

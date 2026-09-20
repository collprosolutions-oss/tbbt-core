export {
  CUSTOMER_MESSAGING_WEBHOOK_PATH,
  DISCONNECTED_CUSTOMER_MESSAGING_PROVIDER,
  FAKE_CUSTOMER_MESSAGING_PROVIDER,
  TWILIO_CUSTOMER_MESSAGING_PROVIDER,
  getCustomerMessagingWebhookSecret,
  getTwilioMessagingConfig,
  isCustomerMessagingConfigured,
  isCustomerMessagingWebhookPath,
  isFakeCustomerMessagingAdapterEnabled,
  isTwilioCustomerMessagingConfigured,
} from "@/lib/customer-messaging/config";
export {
  isSmsConsentGranted,
  isSmsConsentRevoked,
  isSmsConsentStatus,
  resolveStoredSmsConsent,
} from "@/lib/customer-messaging/consent";
export {
  SMS_CONSENT_PRIVACY_URL,
  SMS_CONSENT_TERMS_URL,
  SMS_OPT_IN_LABEL,
  SMS_TRANSACTIONAL_OPT_OUT_FOOTER,
  TWILIO_COMPLIANCE_SETUP_REQUIRED,
} from "@/lib/customer-messaging/compliance";
export { createDisconnectedCustomerMessagingProvider } from "@/lib/customer-messaging/disconnected";
export { createFakeCustomerMessagingProvider } from "@/lib/customer-messaging/fake";
export type { FakeCustomerMessagingProvider } from "@/lib/customer-messaging/fake";
export {
  createTwilioCustomerMessagingProvider,
  parseTwilioOptOutType,
  twilioRequestSignature,
  twilioStatusToCustomerMessageStatus,
  verifyTwilioRequestSignature,
  withTransactionalOptOutFooter,
} from "@/lib/customer-messaging/twilio";
export {
  isAffirmativeSmsOptIn,
  SMS_OPT_IN_FIELD,
  smsConsentAfterOwnerPhoneEdit,
  smsConsentFromPublicOptIn,
} from "@/lib/customer-messaging/opt-in";
export { applyInboundConsentEvent } from "@/lib/customer-messaging/inbound";
export {
  handleCustomerMessagingWebhookRequest,
  handleParsedCustomerMessagingWebhook,
} from "@/lib/customer-messaging/webhook";
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

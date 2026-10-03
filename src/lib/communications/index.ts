export {
  COMMUNICATION_AREAS,
  COMMUNICATION_AREA_LABELS,
  COMMUNICATION_CHANNELS,
  COMMUNICATION_COMPOSE_TEMPLATES,
  COMMUNICATION_DEPARTMENT_PURPOSES,
  RECEPTIONIST_CAPABILITIES,
  SMS_ADDON_NOT_ENTITLED_REASON,
  VOICE_NOT_CONNECTED_REASON,
  isCommunicationArea,
  isCommunicationChannel,
  isCommunicationComposeTemplate,
  parseCommunicationArea,
} from "@/lib/communications/types";
export {
  COMMUNICATIONS_DEPARTMENT_MIGRATIONS,
  COMMUNICATIONS_DEPARTMENT_SCHEMA_SOURCE,
} from "@/lib/communications/schema";
export { getOrCreateCustomerThread } from "@/lib/communications/thread";
export {
  consentContextSnapshot,
  emailDestinationFingerprint,
  emailDestinationFingerprintOrNull,
  evaluateComposeChannelEligibility,
  evaluateEmailEligibility,
} from "@/lib/communications/consent";
export {
  EMAIL_DISPATCH_CLAIM_LEASE_MS,
  communicationEmailDispatchTestHooks,
  composeCustomerCommunication,
  maintenanceComposeTestHooks,
  resetCommunicationEmailSender,
  setCommunicationEmailSender,
} from "@/lib/communications/engine";
export {
  CUSTOMER_COMMUNICATION_TIMELINE_LIMIT,
  communicationContextLabel,
  compareCommunicationTimelineItems,
  emptyCustomerCommunicationHistory,
  filterCommunicationTimelineItems,
  listAssignedJobCommunications,
  listBusinessCommunicationInbox,
  loadCustomerCommunicationHistory,
  loadCustomerCommunicationTimeline,
  recordedCommunicationDirection,
  summarizeCustomerCommunicationTimeline,
} from "@/lib/communications/timeline";
export {
  PHONE_LOG_INJECTED_FAILURE_PREFIX,
  recordMissedOrManualCall,
  setPhoneLogFailureAfter,
} from "@/lib/communications/missed-call";
export {
  MISSED_INBOUND_VOICE_STATUSES,
  TWILIO_VOICE_PROVIDER,
  VOICE_WEBHOOK_IGNORED_CONTENT_PARAMS,
  VOICE_WEBHOOK_PATH,
  VOICE_WEBHOOK_REJECT_TWIML,
  applyInboundVoiceMissedCall,
  handleInboundVoiceWebhookRequest,
  isMissedInboundVoiceEvent,
  isTwilioVoiceWebhookConfigured,
  isVoiceWebhookPath,
  parseInboundVoiceWebhook,
  voiceMissedCallIdempotencyKey,
  voiceWebhookCommunicationsAccess,
} from "@/lib/communications/voice-webhook";
export {
  getReceptionistReadiness,
  lookupCaller,
  proposeReceptionistAction,
  recordInboundCallEvent,
} from "@/lib/communications/receptionist";
export {
  OWNER_LOG_LEAD_HREF,
  RECEPTIONIST_RECOVERY_FACT_KEYS,
  RECEPTIONIST_RECOVERY_QUEUE_LIMIT,
  RECEPTIONIST_RECOVERY_SCAN_LIMIT,
  appendReceptionistRecoveryFacts,
  loadReceptionistRecoveryCenter,
} from "@/lib/communications/receptionist-recovery";
export {
  COMMUNICATIONS_PERMISSION_ERROR,
  COMMUNICATIONS_UNEXPECTED_DISPOSITION_ERROR,
  communicationsActionError,
} from "@/lib/communications/action-errors";
export {
  PHONE_INTERACTION_CLOSED_STATUS,
  RECEPTIONIST_DISPOSITION_FOREIGN_BUSINESS_REASON,
  RECEPTIONIST_DISPOSITION_NOT_CALLBACK_REASON,
  RECEPTIONIST_DISPOSITION_NOT_FOUND_REASON,
  RECEPTIONIST_MANUAL_DISPOSITION_KIND,
  RECEPTIONIST_MANUAL_DISPOSITION_STATUS,
  executeReceptionistDispositionAction,
  phoneInteractionIsCallbackNeeded,
  phoneInteractionIsClosedDisposition,
  receptionistDispositionIdempotencyKey,
  receptionistDispositionLockKey,
  recordReceptionistCallbackDisposition,
  withDispositionLock,
} from "@/lib/communications/receptionist-disposition";
export {
  isCommunicationAiAction,
  runCommunicationAssist,
} from "@/lib/communications/ai";
export {
  productCapabilityForPurpose,
  productCapabilityForTemplate,
  purposeForComposeTemplate,
} from "@/lib/communications/entitlements";
export { renderCommunicationTemplate } from "@/lib/communications/templates";
export { loadCommunicationsWorkspace } from "@/lib/communications/data";
export {
  FAILED_SMS_DELIVERY_LIMIT,
  FAILED_SMS_EMPTY_BODY_REASON,
  FAILED_SMS_NOT_IN_BUSINESS_REASON,
  FAILED_SMS_ONLY_FAILED_REASON,
  FAILED_SMS_RETRY_KEY_PREFIX,
  FAILED_SMS_SUCCESS_NOT_RETRIED_REASON,
  FAILED_SMS_UNSUPPORTED_PURPOSE_REASON,
  failedSmsRetryIdempotencyKey,
  isFailedSmsRetryKey,
  listFailedSmsDeliveries,
  retryFailedSmsDelivery,
} from "@/lib/communications/failed-delivery";
export type { FailedSmsDeliveryRow } from "@/lib/communications/failed-delivery";
export {
  buildComposeFormFields,
  composeIdempotencyKey,
  nextCommunicationAttemptId,
  resolveComposeSendIntent,
  shouldRotateCommunicationAiAttemptId,
  shouldRotateCommunicationSendAttemptId,
} from "@/lib/communications/compose-flow";
export {
  PHONE_LOG_CUSTOMER_CONFLICT_REASON,
  RELATED_RECORD_NOT_OWNED_REASON,
  RELATED_RECORD_WRONG_CUSTOMER_REASON,
  assertRelatedRecordForCustomer,
  resolveRelatedCommunicationRecord,
} from "@/lib/communications/related";
export {
  SMS_COMMERCIAL_BOUNDARY,
  departmentSmsComposeRequiresAddon,
  operationalSmsRequiresSmsAddon,
  ordinaryEmailRequiresSmsAddon,
} from "@/lib/communications/sms-policy";

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
  evaluateComposeChannelEligibility,
  evaluateEmailEligibility,
} from "@/lib/communications/consent";
export {
  composeCustomerCommunication,
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

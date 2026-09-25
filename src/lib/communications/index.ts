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
  COMMUNICATIONS_DEPARTMENT_ENSURE_SQL,
  ensureCommunicationsSchema,
  resetCommunicationsSchemaEnsure,
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
  listAssignedJobCommunications,
  listBusinessCommunicationInbox,
  loadCustomerCommunicationTimeline,
} from "@/lib/communications/timeline";
export { recordMissedOrManualCall } from "@/lib/communications/missed-call";
export {
  getReceptionistReadiness,
  lookupCaller,
  proposeReceptionistAction,
  recordInboundCallEvent,
} from "@/lib/communications/receptionist";
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

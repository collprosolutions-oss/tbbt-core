export {
  APPROVAL_CLASSES,
  COS_APPROVAL_CLASS,
  MAX_RECURSION_DEPTH,
  MAX_SPECIALIST_FANOUT,
  ORCHESTRATION_STATUSES,
  SPECIALIST_IDS,
} from "@/lib/chief-of-staff/types";
export type {
  ApprovalClass,
  ConflictResolution,
  CosEntityHints,
  CosPlannerInput,
  OrchestrationStatus,
  SpecialistId,
  SpecialistResult,
  SpecialistSelection,
  SpecialistSkipReason,
} from "@/lib/chief-of-staff/types";
export {
  SPECIALIST_REGISTRY,
  enabledSpecialistIds,
  getSpecialistEntry,
  isSpecialistEnabled,
} from "@/lib/chief-of-staff/registry";
export {
  isAttentionTodayQuestion,
  isJobBlockerQuestion,
  isNextWorkQuestion,
  isOwnerFocusQuestion,
  planSpecialists,
  sanitizePlannerQuestion,
} from "@/lib/chief-of-staff/planner";
export {
  getDeepLoaderInvocations,
  loadSpecialistContext,
  resetDeepLoaderInvocations,
} from "@/lib/chief-of-staff/context";
export {
  getFinancialSpecialistInterpretationCount,
  resetFinancialSpecialistCounters,
} from "@/lib/chief-of-staff/financial-snapshot";
export {
  getGrowthSpecialistInterpretationCount,
  resetGrowthSpecialistCounters,
} from "@/lib/chief-of-staff/growth-snapshot";
export {
  FINANCIAL_CONTEXT_CAPS,
  FINANCIAL_OWNED_RECOMMENDATION_KEYS,
  interpretFinancialSpecialist,
  isFinancialJobFindingKey,
  isFinancialOwnedRecommendationKey,
  jobIdsFromFinancialFindings,
  projectFinancialContext,
} from "@/lib/chief-of-staff/specialists/financial";
export {
  GROWTH_CONTEXT_CAPS,
  GROWTH_OWNED_RECOMMENDATION_KEYS,
  GROWTH_REQUIRED_PRODUCT_CAPABILITIES,
  getLastGrowthProjection,
  growthEntitlementLimitation,
  growthProjectionHasForbiddenFields,
  interpretGrowthSpecialist,
  isGrowthOwnedRecommendationKey,
  projectGrowthContext,
  projectGrowthFromSource,
  resetLastGrowthProjection,
} from "@/lib/chief-of-staff/growth-specialist";
export {
  getCommunicationsProjectionLoadCount,
  getCommunicationsSpecialistInterpretationCount,
  resetCommunicationsSpecialistCounters,
} from "@/lib/chief-of-staff/communications-snapshot";
export {
  getKnowledgeLaunchProjectionLoadCount,
  getKnowledgeLaunchSpecialistInterpretationCount,
  resetKnowledgeLaunchSpecialistCounters,
} from "@/lib/chief-of-staff/knowledge-launch-snapshot";
export {
  getBusinessProtectionProjectionLoadCount,
  getBusinessProtectionSpecialistInterpretationCount,
  resetBusinessProtectionSpecialistCounters,
} from "@/lib/chief-of-staff/business-protection-snapshot";
export {
  getMaterialsProjectionLoadCount,
  getMaterialsSpecialistInterpretationCount,
  resetMaterialsSpecialistCounters,
} from "@/lib/chief-of-staff/materials-snapshot";
export {
  COMMUNICATIONS_CONTEXT_CAPS,
  COMMUNICATIONS_OWNED_RECOMMENDATION_KEYS,
  TARGET_CONSISTENCY_LIMITATION,
  communicationsEntitlementLimitation,
  communicationsProjectionHasForbiddenFields,
  getLastCommunicationsProjection,
  isCommunicationsOwnedRecommendationKey,
  loadCommunicationsProjection,
  phoneDoesNotGrantConsent,
  projectCommunicationsFacts,
  resetLastCommunicationsProjection,
  runCommunicationsSpecialist,
  unknownConsentIsNotGranted,
} from "@/lib/chief-of-staff/communications-specialist";
export {
  KNOWLEDGE_LAUNCH_CONTEXT_CAPS,
  KNOWLEDGE_LAUNCH_OWNED_RECOMMENDATION_KEYS,
  KNOWLEDGE_STATE_CONTRACT,
  SETUP_STATE_CONTRACT,
  TARGET_CONSISTENCY_LIMITATION as KNOWLEDGE_LAUNCH_TARGET_CONSISTENCY_LIMITATION,
  KNOWLEDGE_NOT_AUTHORIZED_LIMITATION,
  LAUNCH_NOT_AUTHORIZED_LIMITATION,
  SETUP_NOT_AUTHORIZED_LIMITATION,
  candidateIsNotApprovedKnowledge,
  conflictRemainsConflict,
  estimateIsLabeledEstimate,
  externalReferenceIsNotInternallyVerified,
  getLastKnowledgeLaunchProjection,
  isKnowledgeLaunchOwnedRecommendationKey,
  isKnowledgeLaunchOwnerRole,
  knowledgeLaunchEntitlementLimitation,
  knowledgeLaunchProjectionHasForbiddenFields,
  launchCompleteDoesNotImplyProvider,
  launchCompleteDoesNotImplyWebsite,
  launchStatusesRemainDistinct,
  loadKnowledgeLaunchProjection,
  projectKnowledgeLaunchFacts,
  proposalIsNotAppliedSetup,
  resetLastKnowledgeLaunchProjection,
  resolveKnowledgeLaunchReadScope,
  runKnowledgeLaunchSpecialist,
  setupItemApprovedIsNotApplied,
  setupItemBlockedIsNotApplied,
  setupItemPendingIsNotApproved,
  setupItemRejectedIsNotApplied,
  setupProposalIsNotCompletedLaunch,
  supportedIsNotVerified,
  systemDerivedIsReserved,
  unknownStaysUnknown,
  unreviewedIsNotApproved,
} from "@/lib/chief-of-staff/knowledge-launch-specialist";
export {
  BUSINESS_PROTECTION_CONTEXT_CAPS,
  BUSINESS_PROTECTION_OWNED_RECOMMENDATION_KEYS,
  PROTECTION_STATE_CONTRACT,
  TARGET_CONSISTENCY_LIMITATION as BUSINESS_PROTECTION_TARGET_CONSISTENCY_LIMITATION,
  FOREIGN_TARGET_LIMITATION,
  BUSINESS_PROTECTION_FAILURE_LIMITATION,
  businessProtectionEntitlementLimitation,
  businessProtectionProjectionHasForbiddenFields,
  checklistMetIsNotCompliant,
  completionIsNotEnforceable,
  currentIsRecordedDateNotLegalValidity,
  esignStaysNotConnected,
  expiredIsRecordedDatePassed,
  expiringSoonUsesCanonicalWindow,
  getLastBusinessProtectionProjection,
  isBusinessProtectionOwnedRecommendationKey,
  legalWarningAckIsNotAttorneyApproval,
  lifecycleStatusesRemainDistinct,
  loadBusinessProtectionProjection,
  missingDateIsNotExpiredOrNoncompliant,
  noDateOptionalStaysDistinct,
  ownerReviewIsNotAttorneyReview,
  projectBusinessProtectionFacts,
  resetLastBusinessProtectionProjection,
  runBusinessProtectionSpecialist,
} from "@/lib/chief-of-staff/business-protection-specialist";
export {
  MATERIALS_CONTEXT_CAPS,
  MATERIALS_OWNED_RECOMMENDATION_KEYS,
  MATERIALS_REQUIRED_PRODUCT_CAPABILITIES,
  countCheaperRecordedSuppliers,
  countDistinctStaleMaterials,
  countPriceChangesFromHistory,
  latestComparableByProvider,
  latestRecordedSupplierPrice,
  selectProjectedSupplierPrices,
  getLastMaterialsProjection,
  isMaterialsOwnedRecommendationKey,
  loadMaterialsProjection,
  materialsEntitlementLimitation,
  materialsProjectionHasForbiddenFields,
  projectMaterialsFacts,
  resetLastMaterialsProjection,
  runMaterialsSpecialist,
} from "@/lib/chief-of-staff/materials-specialist";
export { resolveConflicts } from "@/lib/chief-of-staff/conflicts";
export { synthesizeCoachAnswer } from "@/lib/chief-of-staff/synthesize";
export {
  findCatalogRecommendation,
  loadCanonicalRecommendationCatalog,
  mergeCatalogRecommendations,
} from "@/lib/chief-of-staff/recommendations";
export {
  CONTROLLED_ACTION_CATALOG,
  CONTROLLED_ACTION_KEYS,
  EXCLUDED_ACTION_KEYS,
  confirmControlledAction,
  controlledActionErrorMessage,
  executableControlledActionKeys,
  getControlledActionEntry,
  isControlledActionKey,
  isExcludedActionKey,
  parseControlledActionProposal,
  proposeControlledAction,
  resetControlledActionAttempts,
  serializeControlledActionProposal,
} from "@/lib/chief-of-staff/controlled-actions";
export type {
  ConfirmControlledActionInput,
  ControlledActionCatalogEntry,
  ControlledActionConfirmation,
  ControlledActionExecutionResult,
  ControlledActionKey,
  ControlledActionProposal,
  ExcludedActionKey,
} from "@/lib/chief-of-staff/controlled-actions";
export {
  getOrchestrationWorkerCount,
  getSynthesisCallCount,
  resetOrchestrationWorkerCount,
  resetSynthesisCallCount,
  runChiefOfStaffCoach,
} from "@/lib/chief-of-staff/run";
export {
  WORKFORCE_CONTEXT_CAPS,
  getLastWorkforceProjection,
  resetLastWorkforceProjection,
  runWorkforceSpecialist,
  projectWorkforceFromSnapshot,
  availabilitySourceForMember,
  describeInheritedAvailability,
  workforceProjectionHasForbiddenFields,
} from "@/lib/chief-of-staff/workforce-specialist";

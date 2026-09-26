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
export { planSpecialists, sanitizePlannerQuestion } from "@/lib/chief-of-staff/planner";
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

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

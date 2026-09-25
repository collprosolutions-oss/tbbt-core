export { isAiProviderConnected, aiConnectionLabel, readAiModel } from "@/lib/ai/config";
export { resolveAiProvider } from "@/lib/ai/provider";
export {
  runAiTask,
  parseStructuredAiOutput,
  filterAuthorizedCitedFactKeys,
  loadAiUsage,
  claimAiInteraction,
  AI_PENDING_STALE_MS,
} from "@/lib/ai/service";
export { applyTemplateWriting, runWritingAssist, resolveWritingOriginal } from "@/lib/ai/writing";
export { answerCoachFromFacts, coachSystemPrompt } from "@/lib/ai/coach";
export {
  retrieveTenantKnowledge,
  answerKnowledgeFromEntries,
  extractKnowledgeFoundation,
} from "@/lib/ai/knowledge";
export {
  draftMarketingVariations,
  weeklyMarketingPlanFromActivity,
  campaignIdeasFromActivity,
  draftMarketingVariationsWithAi,
  weeklyMarketingPlanWithAi,
  campaignIdeasWithAi,
} from "@/lib/ai/marketing";
export { describeReviewSentiment, draftReviewResponseFromRecord } from "@/lib/ai/reviews";
export { runAgreementAssist, agreementAssistFallback } from "@/lib/ai/agreements";
export {
  explainGrowthPerformance,
  proposeCampaignAngle,
  explainGrowthPerformanceWithAi,
  proposeCampaignAngleWithAi,
} from "@/lib/ai/growth";
export {
  AI_NOT_CONNECTED_MESSAGE,
  AI_FAILURE_MESSAGE,
  AI_IN_PROGRESS_MESSAGE,
  WRITING_ACTIONS,
  WRITING_ACTION_LABELS,
  isWritingAction,
  isAiAttemptId,
  shouldRotateAiAttemptId,
} from "@/lib/ai/types";
export type { WritingAction, AiRunResult, StructuredAiOutput, CitedFact } from "@/lib/ai/types";

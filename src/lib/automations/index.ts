export {
  AUTOMATIONS_PATH,
  AUTOMATION_RUN_HISTORY_LIMIT,
  AUTOMATION_CENTER_DISCLAIMER,
  CONFIGURATION_RECORDED_LABEL,
  NO_RECORDED_AUTOMATION_RULES_MESSAGE,
  UNSUPPORTED_AUTOMATION_RULE_LABEL,
} from "@/lib/automations/types";
export type {
  AutomationOwnerCenter,
  AutomationPairKey,
  AutomationRuleProjection,
  AutomationRunProjection,
  SafeAutomationConfig,
  SupportedAutomationDefinition,
} from "@/lib/automations/types";
export {
  PROCESSOR_ONLY_UNSEEDED_PURPOSES,
  SUPPORTED_AUTOMATION_RULES,
  automationPairKey,
  getSupportedAutomationDefinition,
  getSupportedAutomationRule,
  isSupportedAutomationPair,
  isSupportedAutomationRule,
  listSupportedAutomationPairKeys,
  listSupportedAutomationPairs,
} from "@/lib/automations/registry";
export { projectSafeAutomationConfig, projectionTextContains } from "@/lib/automations/config";
export {
  loadAutomationOwnerCenter,
  loadAutomationRunHistory,
  projectAutomationRuleForOwner,
  projectAutomationRun,
} from "@/lib/automations/center";
export { canManageAutomationCenter, requireAutomationCenterAccess } from "@/lib/automations/access";
export {
  UNSUPPORTED_RULE_TOGGLE_ERROR,
  toggleOwnedAutomationRuleEnabled,
} from "@/lib/automations/toggle";

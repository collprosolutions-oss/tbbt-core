import type { AutomationChannel } from "@/lib/automation/types";

export const AUTOMATIONS_PATH = "/automations";
export const AUTOMATION_RUN_HISTORY_LIMIT = 10;

export const AUTOMATION_CENTER_DISCLAIMER =
  "This page lists recorded AutomationRule rows for this business. Enabling a rule does not run it now. Disabling a rule does not delete run history. Run status is the exact recorded AutomationRun status.";

export const UNSUPPORTED_AUTOMATION_RULE_LABEL = "Unsupported / recorded rule";

export const CONFIGURATION_RECORDED_LABEL = "Configuration recorded";

export type AutomationPairKey = `${string}:${string}`;

export type SupportedAutomationDefinition = {
  eventType: string;
  purpose: string;
  kind: "COMMUNICATION" | "ACTION_SUGGESTION";
  channel: AutomationChannel;
  delayMinutes: number;
  templateKey: string;
  triggerLabel: string;
  actionLabel: string;
  sentence: string;
};

export type SafeAutomationConfig = {
  summary: string;
  channelLabel: string | null;
  delayLabel: string | null;
};

export type AutomationRunProjection = {
  id: string;
  status: string;
  resultSummary: string | null;
  lastError: string | null;
  attemptCount: number;
  availableAt: string;
  processedAt: string | null;
  createdAt: string;
  kind: string;
};

export type AutomationRuleProjection = {
  id: string;
  supported: boolean;
  canToggle: boolean;
  enabled: boolean;
  label: string;
  sentence: string;
  triggerLabel: string;
  actionLabel: string;
  recordedTrigger: string;
  recordedAction: string;
  kind: string;
  createdAt: string;
  updatedAt: string;
  configSummary: string;
  config: SafeAutomationConfig;
  lastRun: AutomationRunProjection | null;
};

export type AutomationOwnerCenter = {
  businessId: string;
  disclaimer: string;
  rules: AutomationRuleProjection[];
  selectedRuleId: string | null;
  selectedHistory: AutomationRunProjection[];
  historyLimit: number;
};

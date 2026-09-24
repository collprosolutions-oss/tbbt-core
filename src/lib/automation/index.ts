export { emitBusinessEvent, emitAndProcessBusinessEvent, queueAutomationRunsForEvent } from "@/lib/automation/events";
export { ensureDefaultAutomationRules, updateAutomationRule } from "@/lib/automation/rules";
export { processPendingAutomationRuns } from "@/lib/automation/processor";
export { BUSINESS_EVENT_TYPES, DEFAULT_AUTOMATION_RULES } from "@/lib/automation/types";
export type { BusinessEventType } from "@/lib/automation/types";

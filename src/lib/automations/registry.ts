import { DEFAULT_AUTOMATION_RULES } from "@/lib/automation/types";
import type {
  AutomationPairKey,
  SupportedAutomationDefinition,
} from "@/lib/automations/types";

/**
 * Owner-facing copy for trigger/action pairs the existing engine already
 * seeds and can execute. Keys are `eventType:purpose` — the live schema
 * stores those columns, not `trigger` / `action`.
 */
const AUTOMATION_PAIR_COPY: Record<
  string,
  { triggerLabel: string; actionLabel: string; sentence: string }
> = {
  "ESTIMATE_SENT:ESTIMATE_READY": {
    triggerLabel: "An estimate is sent",
    actionLabel: "queue the recorded estimate-ready communication",
    sentence: "When an estimate is sent → TBBT queues the recorded estimate-ready communication",
  },
  "APPOINTMENT_SCHEDULED:APPOINTMENT_CONFIRMATION": {
    triggerLabel: "An appointment is scheduled",
    actionLabel: "queue the recorded appointment confirmation",
    sentence: "When an appointment is scheduled → TBBT queues the recorded appointment confirmation",
  },
  "APPOINTMENT_CHANGED:SCHEDULE_CHANGE": {
    triggerLabel: "An appointment changes",
    actionLabel: "queue the recorded schedule-change communication",
    sentence: "When an appointment changes → TBBT queues the recorded schedule-change communication",
  },
  "APPOINTMENT_SCHEDULED:APPOINTMENT_REMINDER": {
    triggerLabel: "An appointment is scheduled",
    actionLabel: "queue the recorded appointment reminder after the rule delay",
    sentence:
      "When an appointment is scheduled → TBBT queues the recorded appointment reminder after the rule delay",
  },
  "INVOICE_SENT:INVOICE_READY": {
    triggerLabel: "An invoice is sent",
    actionLabel: "queue the recorded invoice-ready communication",
    sentence: "When an invoice is sent → TBBT queues the recorded invoice-ready communication",
  },
  "INVOICE_DUE:PAYMENT_REMINDER": {
    triggerLabel: "An invoice is due",
    actionLabel: "queue the recorded payment reminder",
    sentence: "When an invoice is due → TBBT queues the recorded payment reminder",
  },
  "INVOICE_OVERDUE:PAYMENT_REMINDER": {
    triggerLabel: "An invoice is overdue",
    actionLabel: "queue the recorded payment reminder",
    sentence: "When an invoice is overdue → TBBT queues the recorded payment reminder",
  },
  "REVIEW_OPPORTUNITY_CREATED:REVIEW_REQUEST": {
    triggerLabel: "A review opportunity is created",
    actionLabel: "record an owner action to request a review",
    sentence:
      "When a review opportunity is created → TBBT records an owner action to request a review",
  },
  "REFERRAL_OPPORTUNITY_CREATED:REFERRAL_REQUEST": {
    triggerLabel: "A referral opportunity is created",
    actionLabel: "record an owner action to request a referral",
    sentence:
      "When a referral opportunity is created → TBBT records an owner action to request a referral",
  },
  "JOB_COMPLETED:JOB_FOLLOW_UP": {
    triggerLabel: "A job is completed",
    actionLabel: "record an owner action for a job follow-up",
    sentence: "When a job is completed → TBBT records an owner action for a job follow-up",
  },
  "REVIEW_REQUEST_READY:REVIEW_REQUEST": {
    triggerLabel: "A review request is ready",
    actionLabel: "queue the recorded review-request communication",
    sentence: "When a review request is ready → TBBT queues the recorded review-request communication",
  },
  "REFERRAL_REQUEST_READY:REFERRAL_REQUEST": {
    triggerLabel: "A referral request is ready",
    actionLabel: "queue the recorded referral-request communication",
    sentence:
      "When a referral request is ready → TBBT queues the recorded referral-request communication",
  },
  "CUSTOMER_FOLLOW_UP_DUE:JOB_FOLLOW_UP": {
    triggerLabel: "A customer follow-up is due",
    actionLabel: "queue the recorded job follow-up communication",
    sentence: "When a customer follow-up is due → TBBT queues the recorded job follow-up communication",
  },
  "CUSTOMER_FOLLOW_UP_DUE:REPEAT_FOLLOW_UP": {
    triggerLabel: "A customer follow-up is due",
    actionLabel: "queue the recorded repeat follow-up communication",
    sentence:
      "When a customer follow-up is due → TBBT queues the recorded repeat follow-up communication",
  },
  "GROWTH_RECOVERY_QUEUED:GROWTH_RECOVERY": {
    triggerLabel: "Growth recovery is queued",
    actionLabel: "record an owner action for growth recovery",
    sentence: "When growth recovery is queued → TBBT records an owner action for growth recovery",
  },
  "GROWTH_REACTIVATION_APPROVED:GROWTH_REACTIVATION": {
    triggerLabel: "Growth reactivation is approved",
    actionLabel: "record an owner action for growth reactivation",
    sentence:
      "When growth reactivation is approved → TBBT records an owner action for growth reactivation",
  },
  "ESTIMATE_SENT:ESTIMATE_FOLLOW_UP": {
    triggerLabel: "An estimate is sent",
    actionLabel: "queue the recorded estimate follow-up after the rule delay",
    sentence:
      "When an estimate is sent → TBBT queues the recorded estimate follow-up after the rule delay",
  },
  "ESTIMATE_NO_ACTION:ESTIMATE_FOLLOW_UP": {
    triggerLabel: "An estimate has no recorded customer action",
    actionLabel: "queue the recorded estimate follow-up",
    sentence:
      "When an estimate has no recorded customer action → TBBT queues the recorded estimate follow-up",
  },
  "OWNER_FOLLOW_UP_CREATED:OWNER_FOLLOW_UP": {
    triggerLabel: "An owner follow-up is created",
    actionLabel: "record an owner action for follow-up",
    sentence: "When an owner follow-up is created → TBBT records an owner action for follow-up",
  },
};

export function automationPairKey(eventType: string, purpose: string): AutomationPairKey {
  return `${eventType}:${purpose}`;
}

function definitionFromDefault(
  rule: (typeof DEFAULT_AUTOMATION_RULES)[number],
): SupportedAutomationDefinition {
  const key = automationPairKey(rule.eventType, rule.purpose);
  const copy = AUTOMATION_PAIR_COPY[key];
  if (!copy) {
    throw new Error(`Missing owner-facing copy for supported automation pair ${key}.`);
  }
  return {
    eventType: rule.eventType,
    purpose: rule.purpose,
    kind: rule.kind,
    channel: rule.channel,
    delayMinutes: rule.delayMinutes,
    templateKey: rule.templateKey,
    triggerLabel: copy.triggerLabel,
    actionLabel: copy.actionLabel,
    sentence: copy.sentence,
  };
}

export const SUPPORTED_AUTOMATION_RULES: readonly SupportedAutomationDefinition[] =
  DEFAULT_AUTOMATION_RULES.map(definitionFromDefault);

const SUPPORTED_PAIR_INDEX = new Map(
  SUPPORTED_AUTOMATION_RULES.map((definition) => [
    automationPairKey(definition.eventType, definition.purpose),
    definition,
  ]),
);

export function getSupportedAutomationDefinition(
  eventType: string,
  purpose: string,
): SupportedAutomationDefinition | null {
  return SUPPORTED_PAIR_INDEX.get(automationPairKey(eventType, purpose)) ?? null;
}

export function isSupportedAutomationPair(eventType: string, purpose: string): boolean {
  return SUPPORTED_PAIR_INDEX.has(automationPairKey(eventType, purpose));
}

/**
 * A recorded rule is supported only when eventType, purpose, AND canonical
 * kind match DEFAULT_AUTOMATION_RULES. Channel and delay are editable
 * settings and are not part of identity.
 */
export function isSupportedAutomationRule(rule: {
  eventType: string;
  purpose: string;
  kind: string;
}): boolean {
  const definition = getSupportedAutomationDefinition(rule.eventType, rule.purpose);
  return Boolean(definition && definition.kind === rule.kind);
}

export function getSupportedAutomationRule(rule: {
  eventType: string;
  purpose: string;
  kind: string;
}): SupportedAutomationDefinition | null {
  const definition = getSupportedAutomationDefinition(rule.eventType, rule.purpose);
  if (!definition || definition.kind !== rule.kind) return null;
  return definition;
}

export function listSupportedAutomationPairs(): readonly SupportedAutomationDefinition[] {
  return SUPPORTED_AUTOMATION_RULES;
}

export function listSupportedAutomationPairKeys(): string[] {
  return SUPPORTED_AUTOMATION_RULES.map((definition) =>
    automationPairKey(definition.eventType, definition.purpose),
  );
}

/**
 * The live processor can also resolve SMS for JOB_UPDATE, but no default
 * rule seeds that pair. The owner center must not invent it as supported.
 */
export const PROCESSOR_ONLY_UNSEEDED_PURPOSES = ["JOB_UPDATE"] as const;

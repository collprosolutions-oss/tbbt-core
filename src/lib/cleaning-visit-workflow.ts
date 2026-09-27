/**
 * Cleaning recurring-visit + crew-checklist workflow helpers.
 *
 * Uses existing Job recurrence columns, scheduling, OperatingProcedure
 * checklists, and one JobCrewVisit field record. Not a second job engine,
 * CRM, billing, messaging, or invented quality stamp.
 */
import {
  cadenceLabel,
  computeNextOccurrenceAt,
  oneTimeRecurrencePlan,
  parseRecurrenceCadence,
  recurringServicePlan,
  type RecurrenceCadence,
  type RecurrencePlan,
} from "@/lib/recurrence";
import { getTradeConfig } from "@/lib/trade-config";
import { DEFAULT_TRADE, isConfiguredTrade, type TradeCode } from "@/lib/trades";

export const VISIT_OUTCOME_STATUSES = [
  "NONE",
  "VISIT_COMPLETED",
  "RE_CLEAN_REQUESTED",
] as const;
export type VisitOutcomeStatus = (typeof VISIT_OUTCOME_STATUSES)[number];

export const VISIT_OUTCOME_RECORDED_STATUSES = [
  "VISIT_COMPLETED",
  "RE_CLEAN_REQUESTED",
] as const;
export type RecordedVisitOutcomeStatus =
  (typeof VISIT_OUTCOME_RECORDED_STATUSES)[number];

export const CLEANING_VISIT_CADENCES = ["WEEKLY", "BIWEEKLY", "MONTHLY"] as const;
export type CleaningVisitCadence = (typeof CLEANING_VISIT_CADENCES)[number];

export const CLEANING_VISIT_ONLY_MESSAGE =
  "This recurring-visit workflow is only for Cleaning jobs.";
export const OWNER_SETS_CADENCE_MESSAGE =
  "Only the business owner can set the visit cadence.";
export const ASSIGNED_WORKER_ONLY_MESSAGE =
  "Only the assigned worker can update this visit checklist.";
export const START_BEFORE_COMPLETE_MESSAGE =
  "Start this visit before recording completion.";

export type CrewChecklistItem = {
  key: string;
  title: string;
  required: boolean;
  checked: boolean;
};

export const CLEANING_PACK_CREW_CHECKLIST: ReadonlyArray<
  Omit<CrewChecklistItem, "checked">
> = [
  {
    key: "kitchen",
    title: "Kitchen counters, sink, and appliance exteriors",
    required: true,
  },
  {
    key: "bathrooms",
    title: "Bathrooms cleaned as scoped",
    required: true,
  },
  {
    key: "floors",
    title: "Floors vacuumed and mopped",
    required: true,
  },
  {
    key: "surfaces",
    title: "Common surfaces dusted and wiped",
    required: true,
  },
  {
    key: "trash",
    title: "Trash emptied",
    required: true,
  },
  {
    key: "walkthrough",
    title: "Final walkthrough of scoped rooms",
    required: true,
  },
];

export function parseVisitOutcomeStatus(
  value: string | null | undefined,
): VisitOutcomeStatus {
  const raw = (value ?? "").trim().toUpperCase();
  return (VISIT_OUTCOME_STATUSES as readonly string[]).includes(raw)
    ? (raw as VisitOutcomeStatus)
    : "NONE";
}

export function parseRecordedVisitOutcome(
  value: string | null | undefined,
): RecordedVisitOutcomeStatus | "" {
  const raw = (value ?? "").trim().toUpperCase();
  return (VISIT_OUTCOME_RECORDED_STATUSES as readonly string[]).includes(raw)
    ? (raw as RecordedVisitOutcomeStatus)
    : "";
}

export function parseCleaningVisitCadence(
  value: string | null | undefined,
): CleaningVisitCadence | "" {
  const cadence = parseRecurrenceCadence(value);
  return (CLEANING_VISIT_CADENCES as readonly string[]).includes(cadence)
    ? (cadence as CleaningVisitCadence)
    : "";
}

export function visitOutcomeLabel(status: string) {
  const parsed = parseVisitOutcomeStatus(status);
  if (parsed === "VISIT_COMPLETED") return "Visit completed";
  if (parsed === "RE_CLEAN_REQUESTED") return "Re-clean requested";
  return "No visit outcome recorded";
}

export function packCrewChecklist(): CrewChecklistItem[] {
  return CLEANING_PACK_CREW_CHECKLIST.map((item) => ({
    ...item,
    checked: false,
  }));
}

export function checklistFromProcedureSteps(
  steps: Array<{ id: string; title: string; required: boolean }>,
): CrewChecklistItem[] {
  return steps
    .map((step) => ({
      key: step.id,
      title: step.title.trim(),
      required: step.required !== false,
      checked: false,
    }))
    .filter((step) => step.title);
}

export function parseChecklistJson(raw: string | null | undefined): CrewChecklistItem[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((row) => {
        if (!row || typeof row !== "object") return null;
        const item = row as Partial<CrewChecklistItem>;
        const key = typeof item.key === "string" ? item.key.trim() : "";
        const title = typeof item.title === "string" ? item.title.trim() : "";
        if (!key || !title) return null;
        return {
          key,
          title,
          required: item.required !== false,
          checked: item.checked === true,
        };
      })
      .filter((row): row is CrewChecklistItem => row !== null);
  } catch {
    return [];
  }
}

export function serializeChecklist(items: CrewChecklistItem[]) {
  return JSON.stringify(items);
}

export function toggleChecklistItem(
  items: CrewChecklistItem[],
  key: string,
  checked: boolean,
): CrewChecklistItem[] {
  return items.map((item) => (item.key === key ? { ...item, checked } : item));
}

export function resolveJobTradeCode(input: {
  requestTradeCode?: string | null;
  catalogTradeCodes?: Array<string | null | undefined>;
}): TradeCode {
  if (input.requestTradeCode && isConfiguredTrade(input.requestTradeCode)) {
    return input.requestTradeCode;
  }
  const catalog = (input.catalogTradeCodes ?? []).find(
    (code): code is TradeCode => Boolean(code && isConfiguredTrade(code)),
  );
  return catalog ?? DEFAULT_TRADE;
}

export function cleaningVisitWorkflowEligible(tradeCode: string) {
  return (
    isConfiguredTrade(tradeCode) &&
    tradeCode === "CLEANING" &&
    getTradeConfig(tradeCode).recurrenceSupport === true
  );
}

export function ownerCadencePlan(
  cadenceOrOneTime: string,
): { ok: true; plan: RecurrencePlan } | { ok: false; error: string } {
  const raw = cadenceOrOneTime.trim().toUpperCase();
  if (raw === "ONE_TIME" || raw === "") {
    return { ok: true, plan: oneTimeRecurrencePlan() };
  }
  const cadence = parseCleaningVisitCadence(raw);
  if (!cadence) {
    return { ok: false, error: "Choose weekly, every two weeks, or monthly." };
  }
  return { ok: true, plan: recurringServicePlan(cadence) };
}

export function nextOccurrenceForCadence(input: {
  scheduledAt: Date | null;
  cadence: RecurrenceCadence | "";
  existingNext?: Date | null;
  timeZone?: string;
}): Date | null {
  if (!input.scheduledAt || !input.cadence) return null;
  return computeNextOccurrenceAt(
    input.scheduledAt,
    input.cadence,
    input.existingNext,
    input.timeZone,
  );
}

export function visitCadenceSummary(job: {
  serviceIntent?: string | null;
  recurrenceCadence?: string | null;
}) {
  if (job.serviceIntent === "RECURRING") {
    return cadenceLabel(job.recurrenceCadence ?? "");
  }
  return cadenceLabel("");
}

export function checklistHasItem(items: CrewChecklistItem[], key: string) {
  return items.some((item) => item.key === key);
}

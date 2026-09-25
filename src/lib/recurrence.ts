/**
 * Recurrence-ready Core helpers.
 *
 * These represent one-time vs recurring service intent, cadence, source
 * relationship, and later cancel/skip semantics. They are not a recurring
 * billing engine and do not charge customers automatically.
 */

export const SERVICE_INTENTS = ["ONE_TIME", "RECURRING"] as const;
export type ServiceIntent = (typeof SERVICE_INTENTS)[number];

export const RECURRENCE_CADENCES = [
  "WEEKLY",
  "BIWEEKLY",
  "MONTHLY",
  "CUSTOM",
] as const;
export type RecurrenceCadence = (typeof RECURRENCE_CADENCES)[number];

export const RECURRENCE_STATUSES = ["ACTIVE", "SKIPPED", "CANCELLED"] as const;
export type RecurrenceStatus = (typeof RECURRENCE_STATUSES)[number];

export const DEFAULT_SERVICE_INTENT: ServiceIntent = "ONE_TIME";

export function parseServiceIntent(value: string | null | undefined): ServiceIntent {
  return value === "RECURRING" ? "RECURRING" : "ONE_TIME";
}

export function parseRecurrenceCadence(
  value: string | null | undefined,
): RecurrenceCadence | "" {
  const raw = (value ?? "").trim().toUpperCase();
  return (RECURRENCE_CADENCES as readonly string[]).includes(raw)
    ? (raw as RecurrenceCadence)
    : "";
}

export function parseRecurrenceStatus(
  value: string | null | undefined,
): RecurrenceStatus | "" {
  const raw = (value ?? "").trim().toUpperCase();
  return (RECURRENCE_STATUSES as readonly string[]).includes(raw)
    ? (raw as RecurrenceStatus)
    : "";
}

export function serviceIntentFromFrequency(frequency: string | null | undefined): ServiceIntent {
  const cadence = parseRecurrenceCadence(frequency);
  if (cadence) return "RECURRING";
  const raw = (frequency ?? "").trim().toUpperCase();
  if (raw === "ONE_TIME" || raw === "" || raw === "ONCE") return "ONE_TIME";
  if (raw === "WEEKLY" || raw === "BIWEEKLY" || raw === "MONTHLY" || raw === "CUSTOM") {
    return "RECURRING";
  }
  return "ONE_TIME";
}

export function cadenceLabel(cadence: string) {
  if (cadence === "WEEKLY") return "Weekly";
  if (cadence === "BIWEEKLY") return "Every two weeks";
  if (cadence === "MONTHLY") return "Monthly";
  if (cadence === "CUSTOM") return "Custom cadence";
  return "One-time";
}

export type RecurrencePlan = {
  serviceIntent: ServiceIntent;
  recurrenceCadence: RecurrenceCadence | "";
  recurrenceStatus: RecurrenceStatus | "";
  recurrenceSourceJobId: string | null;
  nextOccurrenceAt: Date | null;
};

export function oneTimeRecurrencePlan(): RecurrencePlan {
  return {
    serviceIntent: "ONE_TIME",
    recurrenceCadence: "",
    recurrenceStatus: "",
    recurrenceSourceJobId: null,
    nextOccurrenceAt: null,
  };
}

export function recurringServicePlan(cadence: RecurrenceCadence): RecurrencePlan {
  return {
    serviceIntent: "RECURRING",
    recurrenceCadence: cadence,
    recurrenceStatus: "ACTIVE",
    recurrenceSourceJobId: null,
    nextOccurrenceAt: null,
  };
}

/**
 * Copy authoritative request recurrence onto a Job created from an Estimate.
 * Manual/legacy estimates without a source request stay ONE_TIME. This does
 * not create future jobs or recurring billing.
 */
export function jobRecurrenceFromServiceRequest(
  request:
    | {
        serviceIntent?: string | null;
        recurrenceCadence?: string | null;
      }
    | null
    | undefined,
): RecurrencePlan {
  if (!request) return oneTimeRecurrencePlan();
  const intent = parseServiceIntent(request.serviceIntent);
  if (intent !== "RECURRING") return oneTimeRecurrencePlan();
  const cadence = parseRecurrenceCadence(request.recurrenceCadence);
  if (!cadence) {
    return {
      serviceIntent: "RECURRING",
      recurrenceCadence: "",
      recurrenceStatus: "ACTIVE",
      recurrenceSourceJobId: null,
      nextOccurrenceAt: null,
    };
  }
  return recurringServicePlan(cadence);
}

/** Later skip/cancel semantics — recorded on the occurrence, not billed here. */
export function applyRecurrenceDecision(
  plan: RecurrencePlan,
  decision: "SKIP" | "CANCEL",
): RecurrencePlan {
  return {
    ...plan,
    recurrenceStatus: decision === "SKIP" ? "SKIPPED" : "CANCELLED",
    nextOccurrenceAt: decision === "CANCEL" ? null : plan.nextOccurrenceAt,
  };
}

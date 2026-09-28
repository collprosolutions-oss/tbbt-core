/**
 * OWNER-scheduled corrective Cleaning job after RE_CLEAN_REQUESTED.
 *
 * One explicit job only: same-business customer, property, and selected
 * service scope, plus an owner-chosen business-timezone date and
 * confirmation. Distinct from a regular next booking. Not a recurring
 * series, invoice, charge, or customer message.
 */
import { formatISODateInTimeZone, resolveBusinessTimeZone } from "@/lib/business-timezone";
import { parseScheduleStart } from "@/lib/job-schedule";
import {
  cleaningVisitWorkflowEligible,
  parseVisitOutcomeStatus,
  resolveJobTradeCode,
} from "@/lib/cleaning-visit-workflow";

export const OWNER_SCHEDULES_CORRECTIVE_CLEAN_MESSAGE =
  "Only the business owner can schedule the corrective clean.";
export const CLEANING_CORRECTIVE_CLEAN_ONLY_MESSAGE =
  "The corrective clean can only be scheduled from a Cleaning job.";
export const CLEANING_CORRECTIVE_CLEAN_RE_CLEAN_REQUIRED_MESSAGE =
  "Review a visit that requested a re-clean before scheduling the corrective job.";
export const CLEANING_CORRECTIVE_CLEAN_DATE_REQUIRED_MESSAGE =
  "Choose a date for the corrective clean.";
export const CLEANING_CORRECTIVE_CLEAN_CONFIRM_REQUIRED_MESSAGE =
  "Confirm this one corrective Cleaning job before scheduling it.";
export const CLEANING_CORRECTIVE_CLEAN_INVALID_DATE_MESSAGE =
  "Choose a valid date in the business timezone.";
export const CLEANING_CORRECTIVE_CLEAN_CUSTOMER_REQUIRED_MESSAGE =
  "This job has no same-business customer to carry forward.";
export const CLEANING_CORRECTIVE_CLEAN_PROPERTY_REQUIRED_MESSAGE =
  "This job has no same-business property to carry forward.";
export const CLEANING_CORRECTIVE_CLEAN_SCOPE_REQUIRED_MESSAGE =
  "This job has no selected service scope to carry forward.";
export const CLEANING_CORRECTIVE_CLEAN_CREATED_MESSAGE =
  "Corrective clean scheduled. No next booking, invoice, charge, or message was created.";
export const CLEANING_CORRECTIVE_CLEAN_ALREADY_EXISTS_MESSAGE =
  "This requested re-clean already has a corrective job.";

/** Default clock time when the owner supplies a civil date only. */
export const DEFAULT_CORRECTIVE_CLEAN_TIME = "09:00";

export type CorrectiveCleanScopeLine = {
  title: string;
  quantity: string;
};

export type CorrectiveCleanRecurrenceFields = {
  serviceIntent: "ONE_TIME";
  recurrenceCadence: "";
  recurrenceStatus: "";
  nextOccurrenceAt: null;
};

export function cleaningCorrectiveCleanEligible(tradeCode: string) {
  return cleaningVisitWorkflowEligible(tradeCode);
}

export function resolveCleaningJobTradeCode(input: {
  requestTradeCode?: string | null;
  catalogTradeCodes?: Array<string | null | undefined>;
}) {
  return resolveJobTradeCode(input);
}

export function visitRequestedReClean(outcomeStatus: string | null | undefined) {
  return parseVisitOutcomeStatus(outcomeStatus) === "RE_CLEAN_REQUESTED";
}

export function oneTimeCorrectiveCleanPlan(): CorrectiveCleanRecurrenceFields {
  return {
    serviceIntent: "ONE_TIME",
    recurrenceCadence: "",
    recurrenceStatus: "",
    nextOccurrenceAt: null,
  };
}

export function parseOwnerCorrectiveCleanConfirmation(
  value: string | boolean | null | undefined,
) {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  const raw = value.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

export function parseOwnerCorrectiveCleanStart(input: {
  date: string;
  time?: string | null;
  timeZone: string;
}) {
  const date = input.date.trim();
  if (!date) return null;
  const time = (input.time ?? "").trim() || DEFAULT_CORRECTIVE_CLEAN_TIME;
  return parseScheduleStart(date, time, input.timeZone);
}

export function correctiveCleanCivilDate(scheduledAt: Date, timeZone: string) {
  return formatISODateInTimeZone(scheduledAt, timeZone);
}

export function businessTimeZoneForCorrectiveClean(
  business: { timezone?: string | null } | null | undefined,
) {
  return resolveBusinessTimeZone(business);
}

export function hasSelectedServiceScope(input: {
  approvedEstimateVersionId?: string | null;
  estimateId?: string | null;
  scopeLineCount: number;
}) {
  return Boolean(input.approvedEstimateVersionId || input.scopeLineCount > 0);
}

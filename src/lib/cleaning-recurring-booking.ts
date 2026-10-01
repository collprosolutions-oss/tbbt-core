/**
 * OWNER-managed future recurring Cleaning bookings.
 *
 * Explicit cadence + business-timezone dates. Occurrences are real Job
 * rows linked by recurrenceSourceJobId and a unique occurrence key.
 * Distinct from one-time next bookings and corrective cleans. Not a
 * billing engine, invoice, or customer message.
 */
import { formatISODateInTimeZone, resolveBusinessTimeZone } from "@/lib/business-timezone";
import { parseScheduleStart } from "@/lib/job-schedule";
import {
  cleaningVisitWorkflowEligible,
  parseCleaningVisitCadence,
  resolveJobTradeCode,
  type CleaningVisitCadence,
} from "@/lib/cleaning-visit-workflow";
import {
  computeNextOccurrenceAt,
  parseRecurrenceStatus,
  type RecurrenceCadence,
} from "@/lib/recurrence";

export const OWNER_MANAGES_RECURRING_BOOKINGS_MESSAGE =
  "Only the business owner can set up or stop recurring Cleaning bookings.";
export const CLEANING_RECURRING_BOOKING_ONLY_MESSAGE =
  "Recurring bookings can only be set up from a Cleaning job.";
export const CLEANING_RECURRING_BOOKING_SOURCE_MESSAGE =
  "Recurring bookings must start from the original Cleaning job, not a next booking, corrective clean, or later occurrence.";
export const CLEANING_RECURRING_CADENCE_REQUIRED_MESSAGE =
  "Choose weekly, every two weeks, or monthly.";
export const CLEANING_RECURRING_DATE_REQUIRED_MESSAGE =
  "Choose a first booking date.";
export const CLEANING_RECURRING_CONFIRM_REQUIRED_MESSAGE =
  "Confirm this recurring Cleaning schedule before creating bookings.";
export const CLEANING_RECURRING_STOP_CONFIRM_REQUIRED_MESSAGE =
  "Confirm you want to stop this recurring Cleaning schedule.";
export const CLEANING_RECURRING_RESUME_CONFIRM_REQUIRED_MESSAGE =
  "Confirm you want to resume this recurring Cleaning schedule.";
export const CLEANING_RECURRING_INVALID_DATE_MESSAGE =
  "Choose a valid date in the business timezone.";
export const CLEANING_RECURRING_DATE_IN_PAST_MESSAGE =
  "Choose a first booking date on or after today in the business timezone.";
export const CLEANING_RECURRING_CUSTOMER_REQUIRED_MESSAGE =
  "This job has no same-business customer to carry forward.";
export const CLEANING_RECURRING_PROPERTY_REQUIRED_MESSAGE =
  "This job has no same-business property to carry forward.";
export const CLEANING_RECURRING_SCOPE_REQUIRED_MESSAGE =
  "This job has no selected service scope to carry forward.";
export const CLEANING_RECURRING_CREATED_MESSAGE =
  "Recurring Cleaning bookings scheduled. No next booking, corrective clean, invoice, or message was created.";
export const CLEANING_RECURRING_ALREADY_EXISTS_MESSAGE =
  "This job already has a recurring Cleaning schedule.";
export const CLEANING_RECURRING_STOPPED_MESSAGE =
  "Recurring Cleaning schedule stopped. Future unstarted bookings are canceled. Started and completed work is unchanged.";
export const CLEANING_RECURRING_RESUMED_MESSAGE =
  "Recurring Cleaning schedule resumed.";
export const CLEANING_RECURRING_FILLED_MESSAGE =
  "Upcoming recurring Cleaning bookings are up to date.";
export const CLEANING_RECURRING_NOT_ACTIVE_MESSAGE =
  "This recurring Cleaning schedule is not active.";
export const CLEANING_RECURRING_NOT_STOPPED_MESSAGE =
  "This recurring Cleaning schedule is not stopped.";
export const CLEANING_RECURRING_SLOT_BLOCKED_MESSAGE =
  "A proposed recurring booking time is blocked by working hours, a buffer, pickup time, or another scheduled job. No bookings were created.";

export const DEFAULT_RECURRING_BOOKING_TIME = "09:00";
export const MAX_UPCOMING_RECURRING_BOOKINGS = 8;

export type RecurringBookingScopeLine = {
  title: string;
  quantity: string;
};

export type RecurringOccurrencePlan = {
  serviceIntent: "RECURRING";
  recurrenceCadence: CleaningVisitCadence;
  recurrenceStatus: "ACTIVE" | "CANCELLED";
  nextBookingSourceJobId: null;
  correctiveCleanSourceJobId: null;
};

export function cleaningRecurringBookingEligible(tradeCode: string) {
  return cleaningVisitWorkflowEligible(tradeCode);
}

export function resolveCleaningJobTradeCode(input: {
  requestTradeCode?: string | null;
  catalogTradeCodes?: Array<string | null | undefined>;
}) {
  return resolveJobTradeCode(input);
}

export function recurringOccurrencePlan(
  cadence: CleaningVisitCadence,
  status: "ACTIVE" | "CANCELLED" = "ACTIVE",
): RecurringOccurrencePlan {
  return {
    serviceIntent: "RECURRING",
    recurrenceCadence: cadence,
    recurrenceStatus: status,
    nextBookingSourceJobId: null,
    correctiveCleanSourceJobId: null,
  };
}

export function parseOwnerRecurringConfirmation(value: string | boolean | null | undefined) {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  const raw = value.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

export function parseOwnerRecurringCadence(value: string | null | undefined): CleaningVisitCadence | "" {
  return parseCleaningVisitCadence(value);
}

export function parseOwnerRecurringStart(input: {
  date: string;
  time?: string | null;
  timeZone: string;
}) {
  const date = input.date.trim();
  if (!date) return null;
  const time = (input.time ?? "").trim() || DEFAULT_RECURRING_BOOKING_TIME;
  return parseScheduleStart(date, time, input.timeZone);
}

export function recurringBookingCivilDate(scheduledAt: Date, timeZone: string) {
  return formatISODateInTimeZone(scheduledAt, timeZone);
}

export function businessTimeZoneForRecurringBooking(
  business: { timezone?: string | null } | null | undefined,
) {
  return resolveBusinessTimeZone(business);
}

export function recurrenceOccurrenceKey(sourceJobId: string, civilDate: string) {
  return `recurring:${sourceJobId}:${civilDate}`;
}

export function hasSelectedServiceScope(input: {
  approvedEstimateVersionId?: string | null;
  estimateId?: string | null;
  scopeLineCount: number;
}) {
  return Boolean(input.approvedEstimateVersionId || input.scopeLineCount > 0);
}

export function isRecurringSeriesSource(job: {
  recurrenceSourceJobId?: string | null;
  nextBookingSourceJobId?: string | null;
  correctiveCleanSourceJobId?: string | null;
}) {
  return (
    !job.recurrenceSourceJobId &&
    !job.nextBookingSourceJobId &&
    !job.correctiveCleanSourceJobId
  );
}

/**
 * A later recurring booking row. Distinct from the series source, a
 * one-time next booking, and a corrective clean. Occurrence invoices
 * must bind to this job, never the source.
 */
export function isRecurringOccurrenceJob(job: {
  recurrenceSourceJobId?: string | null;
  recurrenceOccurrenceKey?: string | null;
  nextBookingSourceJobId?: string | null;
  correctiveCleanSourceJobId?: string | null;
}) {
  return (
    Boolean(job.recurrenceSourceJobId) &&
    Boolean(job.recurrenceOccurrenceKey) &&
    !job.nextBookingSourceJobId &&
    !job.correctiveCleanSourceJobId
  );
}

export function isActiveRecurringSeries(job: {
  serviceIntent?: string | null;
  recurrenceStatus?: string | null;
}) {
  return (
    job.serviceIntent === "RECURRING" &&
    parseRecurrenceStatus(job.recurrenceStatus) === "ACTIVE"
  );
}

export function isCancelledRecurringSeries(job: {
  serviceIntent?: string | null;
  recurrenceStatus?: string | null;
}) {
  return (
    job.serviceIntent === "RECURRING" &&
    parseRecurrenceStatus(job.recurrenceStatus) === "CANCELLED"
  );
}

/**
 * Upcoming occurrence starts on or after today in `timeZone`, walking from
 * `firstAt` on the cadence. Does not create Job rows.
 */
export function listUpcomingRecurringStarts(input: {
  firstAt: Date;
  cadence: RecurrenceCadence | "";
  timeZone: string;
  now?: Date;
  maxOccurrences?: number;
}): Date[] {
  const cadence = parseOwnerRecurringCadence(input.cadence);
  if (!cadence) return [];
  const maxOccurrences = input.maxOccurrences ?? MAX_UPCOMING_RECURRING_BOOKINGS;
  const now = input.now ?? new Date();
  const todayCivil = formatISODateInTimeZone(now, input.timeZone);
  const starts: Date[] = [];
  let cursor: Date | null = input.firstAt;
  let guard = 0;
  while (cursor && starts.length < maxOccurrences && guard < 120) {
    guard += 1;
    const civil = formatISODateInTimeZone(cursor, input.timeZone);
    if (civil >= todayCivil) {
      starts.push(cursor);
    }
    const next = computeNextOccurrenceAt(cursor, cadence, null, input.timeZone);
    if (!next || next.getTime() <= cursor.getTime()) break;
    cursor = next;
  }
  return starts;
}

export function firstCivilDateIsInPast(input: {
  firstAt: Date;
  timeZone: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  return (
    formatISODateInTimeZone(input.firstAt, input.timeZone) <
    formatISODateInTimeZone(now, input.timeZone)
  );
}

export function isUnstartedRecurringJobStatus(status: string | null | undefined) {
  return status === "SCHEDULED" || status === "UNSCHEDULED";
}

export function isStartedOrCompletedJobStatus(status: string | null | undefined) {
  return status === "IN_PROGRESS" || status === "COMPLETED";
}

export function recurringOccurrenceIsOnOrAfterToday(input: {
  scheduledAt: Date | null | undefined;
  timeZone: string;
  now?: Date;
}) {
  if (!input.scheduledAt) return true;
  const now = input.now ?? new Date();
  return (
    formatISODateInTimeZone(input.scheduledAt, input.timeZone) >=
    formatISODateInTimeZone(now, input.timeZone)
  );
}

export function canCancelUnstartedRecurringOccurrence(input: {
  status: string | null | undefined;
  scheduledAt?: Date | null;
  timeZone: string;
  now?: Date;
}) {
  return (
    isUnstartedRecurringJobStatus(input.status) &&
    recurringOccurrenceIsOnOrAfterToday({
      scheduledAt: input.scheduledAt,
      timeZone: input.timeZone,
      now: input.now,
    })
  );
}

export function canReopenCancelledRecurringOccurrence(input: {
  status: string | null | undefined;
  scheduledAt?: Date | null;
  timeZone: string;
  now?: Date;
}) {
  return (
    input.status === "CANCELLED" &&
    Boolean(input.scheduledAt) &&
    recurringOccurrenceIsOnOrAfterToday({
      scheduledAt: input.scheduledAt,
      timeZone: input.timeZone,
      now: input.now,
    })
  );
}

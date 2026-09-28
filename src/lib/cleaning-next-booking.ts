/**
 * OWNER-created next booking from a completed Cleaning job.
 *
 * One explicit booking only: same-business customer, property, and
 * selected service scope, plus an owner-chosen date and confirmation.
 * Not a recurring series, invoice, or customer message.
 */
import { formatISODateInTimeZone, resolveBusinessTimeZone } from "@/lib/business-timezone";
import { parseScheduleStart } from "@/lib/job-schedule";
import {
  cleaningVisitWorkflowEligible,
  resolveJobTradeCode,
} from "@/lib/cleaning-visit-workflow";

export const OWNER_CREATES_NEXT_BOOKING_MESSAGE =
  "Only the business owner can create the next booking.";
export const CLEANING_NEXT_BOOKING_ONLY_MESSAGE =
  "The next booking can only be created from a completed Cleaning job.";
export const CLEANING_NEXT_BOOKING_NOT_COMPLETED_MESSAGE =
  "Complete this Cleaning job before creating the next booking.";
export const CLEANING_NEXT_BOOKING_DATE_REQUIRED_MESSAGE =
  "Choose a date for the next booking.";
export const CLEANING_NEXT_BOOKING_CONFIRM_REQUIRED_MESSAGE =
  "Confirm this one next booking before creating it.";
export const CLEANING_NEXT_BOOKING_INVALID_DATE_MESSAGE =
  "Choose a valid date in the business timezone.";
export const CLEANING_NEXT_BOOKING_CUSTOMER_REQUIRED_MESSAGE =
  "This job has no same-business customer to carry forward.";
export const CLEANING_NEXT_BOOKING_PROPERTY_REQUIRED_MESSAGE =
  "This job has no same-business property to carry forward.";
export const CLEANING_NEXT_BOOKING_SCOPE_REQUIRED_MESSAGE =
  "This job has no selected service scope to carry forward.";
export const CLEANING_NEXT_BOOKING_CREATED_MESSAGE =
  "Next booking created. No recurring series, invoice, or message was created.";
export const CLEANING_NEXT_BOOKING_ALREADY_EXISTS_MESSAGE =
  "This completed job already has a next booking.";

/** Default clock time when the owner supplies a civil date only. */
export const DEFAULT_NEXT_BOOKING_TIME = "09:00";

export type NextBookingScopeLine = {
  title: string;
  quantity: string;
};

export type NextBookingRecurrenceFields = {
  serviceIntent: "ONE_TIME";
  recurrenceCadence: "";
  recurrenceStatus: "";
  nextOccurrenceAt: null;
};

export function cleaningNextBookingEligible(tradeCode: string) {
  return cleaningVisitWorkflowEligible(tradeCode);
}

export function resolveCleaningJobTradeCode(input: {
  requestTradeCode?: string | null;
  catalogTradeCodes?: Array<string | null | undefined>;
}) {
  return resolveJobTradeCode(input);
}

export function oneTimeNextBookingPlan(): NextBookingRecurrenceFields {
  return {
    serviceIntent: "ONE_TIME",
    recurrenceCadence: "",
    recurrenceStatus: "",
    nextOccurrenceAt: null,
  };
}

export function parseOwnerNextBookingConfirmation(value: string | boolean | null | undefined) {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  const raw = value.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

export function parseOwnerNextBookingStart(input: {
  date: string;
  time?: string | null;
  timeZone: string;
}) {
  const date = input.date.trim();
  if (!date) return null;
  const time = (input.time ?? "").trim() || DEFAULT_NEXT_BOOKING_TIME;
  return parseScheduleStart(date, time, input.timeZone);
}

export function nextBookingCivilDate(scheduledAt: Date, timeZone: string) {
  return formatISODateInTimeZone(scheduledAt, timeZone);
}

export function businessTimeZoneForNextBooking(business: { timezone?: string | null } | null | undefined) {
  return resolveBusinessTimeZone(business);
}

export function hasSelectedServiceScope(input: {
  approvedEstimateVersionId?: string | null;
  estimateId?: string | null;
  scopeLineCount: number;
}) {
  return Boolean(input.approvedEstimateVersionId || input.scopeLineCount > 0);
}

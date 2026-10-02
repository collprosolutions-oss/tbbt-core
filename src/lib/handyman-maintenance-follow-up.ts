/**
 * OWNER-set Handyman maintenance follow-up for a completed job.
 *
 * Records a CustomerFollowUp with origin MAINTENANCE, a required task,
 * and a required due date. Creating or due-dating the row never sends
 * SMS or email, never emits CUSTOMER_FOLLOW_UP_DUE, never books a job,
 * and never creates a Cleaning recurring visit. A customer reminder
 * is sent only when an OWNER reviews and submits the existing
 * Communications compose path.
 */
import type { MembershipRole } from "@prisma/client";
import {
  parseCivilDateInTimeZone,
  startOfZonedDay,
} from "@/lib/business-timezone";
import { CUSTOMER_FOLLOW_UP_ORIGINS } from "@/lib/customer-follow-up-origin";
import { completedSameBusinessJobEligible } from "@/lib/job-callback";
import { resolveJobTradeCode } from "@/lib/cleaning-visit-workflow";

export const HANDYMAN_MAINTENANCE_FOLLOW_UP_KIND = "JOB_COMPLETE" as const;
export const HANDYMAN_MAINTENANCE_FOLLOW_UP_ORIGIN =
  CUSTOMER_FOLLOW_UP_ORIGINS.MAINTENANCE;
export const MAX_HANDYMAN_MAINTENANCE_TASK_LENGTH = 2000;
export const HANDYMAN_MAINTENANCE_TRADE = "HANDYMAN" as const;

export const HANDYMAN_MAINTENANCE_OWNER_ONLY_MESSAGE =
  "Only the business owner can set or cancel a Handyman maintenance follow-up.";

export const HANDYMAN_MAINTENANCE_OWNER_SEND_MESSAGE =
  "Only the business owner can send this maintenance reminder after reviewing it in Communications.";

export const HANDYMAN_MAINTENANCE_REVIEWS_REFUSED_MESSAGE =
  "Handyman maintenance follow-ups are not sent, marked sent, or cancelled from Reviews. The owner reviews and sends them in Communications compose.";

export const HANDYMAN_MAINTENANCE_COMPLETED_JOB_MESSAGE =
  "A Handyman maintenance follow-up can only be set on a completed job.";

export const HANDYMAN_MAINTENANCE_JOB_REQUIRED_MESSAGE =
  "That job could not be found.";

export const HANDYMAN_MAINTENANCE_CUSTOMER_REQUIRED_MESSAGE =
  "That completed job has no customer to follow up with.";

export const HANDYMAN_MAINTENANCE_HANDYMAN_ONLY_MESSAGE =
  "Maintenance follow-ups are for completed Handyman jobs. This does not create a recurring Cleaning visit or book a job.";

export const HANDYMAN_MAINTENANCE_TASK_REQUIRED_MESSAGE =
  "Write a clear maintenance task before saving the follow-up.";

export const HANDYMAN_MAINTENANCE_DUE_REQUIRED_MESSAGE =
  "Choose a due date on or after today in this business timezone.";

export const HANDYMAN_MAINTENANCE_INVALID_DUE_DATE_MESSAGE =
  "Enter a valid due date.";

export const HANDYMAN_MAINTENANCE_PAST_DUE_DATE_MESSAGE =
  "Choose a due date on or after today in this business timezone.";

export const HANDYMAN_MAINTENANCE_OPEN_EXISTS_MESSAGE =
  "This job already has an open maintenance follow-up. Cancel it before setting another.";

export const HANDYMAN_MAINTENANCE_UNKNOWN_MESSAGE =
  "That maintenance follow-up could not be found.";

export const HANDYMAN_MAINTENANCE_NOT_OPEN_MESSAGE =
  "Only an open maintenance follow-up can be cancelled.";

export const HANDYMAN_MAINTENANCE_ALREADY_SENT_MESSAGE =
  "That maintenance reminder was already sent. A duplicate send was not attempted.";

export const HANDYMAN_MAINTENANCE_CANCELLED_MESSAGE =
  "That maintenance follow-up was cancelled. A customer reminder was not sent.";

export const HANDYMAN_MAINTENANCE_NOT_SENDABLE_MESSAGE =
  "Only an open maintenance follow-up can be sent after owner review.";

export const HANDYMAN_MAINTENANCE_CREATED_MESSAGE =
  "Maintenance follow-up saved. It will appear in the owner queue when due. No customer message was sent and no job was booked.";

export const HANDYMAN_MAINTENANCE_CANCELLED_SAVED_MESSAGE =
  "Maintenance follow-up cancelled. It left the owner queue. No customer message was sent.";

export const HANDYMAN_MAINTENANCE_OWNER_WORKFLOW_MESSAGE =
  "Set a future Handyman maintenance task and due date for this completed job. The owner queue shows it when due. Sending a customer reminder requires an explicit owner review in Communications. This does not create a recurring Cleaning visit or book a job.";

export const HANDYMAN_MAINTENANCE_QUEUE_TITLE = "Handyman maintenance follow-ups";

export const HANDYMAN_MAINTENANCE_REVIEW_ACTION = "Review";

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class HandymanMaintenanceFollowUpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandymanMaintenanceFollowUpError";
  }
}

export function handymanMaintenanceFollowUpErrorMessage(
  error: unknown,
  fallback: string,
) {
  if (error instanceof HandymanMaintenanceFollowUpError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  return fallback;
}

export function handymanMaintenanceWriteAllowed(
  role: MembershipRole | string,
): boolean {
  return role === "OWNER";
}

export function parseHandymanMaintenanceTask(raw: string | null | undefined) {
  const task = raw?.trim() ?? "";
  if (!task) return null;
  if (task.length > MAX_HANDYMAN_MAINTENANCE_TASK_LENGTH) {
    return task.slice(0, MAX_HANDYMAN_MAINTENANCE_TASK_LENGTH);
  }
  return task;
}

export type ParsedMaintenanceDueOn =
  | { ok: true; dueOn: Date }
  | { ok: false; reason: "invalid" | "past" };

export function parseHandymanMaintenanceDueOn(
  raw: string | null | undefined,
  timeZone: string,
  now: Date = new Date(),
): ParsedMaintenanceDueOn {
  const value = raw?.trim() ?? "";
  if (!value || !CIVIL_DATE.test(value)) return { ok: false, reason: "invalid" };
  const [year, month, day] = value.split("-").map(Number);
  const parsed = parseCivilDateInTimeZone(year, month, day, timeZone);
  if (!parsed) return { ok: false, reason: "invalid" };
  const due = startOfZonedDay(parsed, timeZone).getTime();
  const today = startOfZonedDay(now, timeZone).getTime();
  if (due < today) return { ok: false, reason: "past" };
  return { ok: true, dueOn: parsed };
}

export function handymanMaintenanceDueState(
  dueOn: Date | null | undefined,
  now: Date,
  timeZone: string,
): "none" | "upcoming" | "due_today" | "overdue" {
  if (!dueOn) return "none";
  const due = startOfZonedDay(dueOn, timeZone).getTime();
  const today = startOfZonedDay(now, timeZone).getTime();
  if (due < today) return "overdue";
  if (due === today) return "due_today";
  return "upcoming";
}

export function isHandymanMaintenanceDueOrOverdue(
  dueOn: Date | null | undefined,
  now: Date,
  timeZone: string,
) {
  const state = handymanMaintenanceDueState(dueOn, now, timeZone);
  return state === "due_today" || state === "overdue";
}

export function resolveHandymanMaintenanceJobTrade(input: {
  requestTradeCode?: string | null;
  catalogTradeCodes?: Array<string | null | undefined>;
}) {
  return resolveJobTradeCode(input);
}

export function handymanMaintenanceJobEligible(input: {
  job: { status: string; businessId: string } | null | undefined;
  businessId: string;
  requestTradeCode?: string | null;
  catalogTradeCodes?: Array<string | null | undefined>;
}) {
  if (!completedSameBusinessJobEligible(input.job, input.businessId)) {
    return { ok: false as const, reason: "not_completed" as const };
  }
  const trade = resolveHandymanMaintenanceJobTrade({
    requestTradeCode: input.requestTradeCode,
    catalogTradeCodes: input.catalogTradeCodes,
  });
  if (trade !== HANDYMAN_MAINTENANCE_TRADE) {
    return { ok: false as const, reason: "not_handyman" as const, trade };
  }
  return { ok: true as const, trade };
}

export function maintenanceFollowUpComposeHref(input: {
  customerId: string;
  followUpId: string;
}) {
  const params = new URLSearchParams({
    area: "compose",
    customerId: input.customerId,
    relatedType: "CUSTOMER_FOLLOW_UP",
    relatedId: input.followUpId,
  });
  return `/communications?${params.toString()}`;
}

export function maintenanceFollowUpLockKey(input: {
  businessId: string;
  jobId: string;
}) {
  return `handyman-maintenance-follow-up:${input.businessId}:${input.jobId}`;
}

export function maintenanceFollowUpStatusLockKey(followUpId: string) {
  return `handyman-maintenance-follow-up-status:${followUpId}`;
}

/**
 * Owner-set RETENTION_TASK due dates.
 *
 * Civil dates are stored as business-timezone midnight. Classification
 * uses the same timezone. This is not a CUSTOMER_FOLLOW_UP_DUE scan and
 * does not send a message.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  addZonedCalendarDays,
  parseCivilDateInTimeZone,
  resolveBusinessTimeZone,
  startOfZonedDay,
} from "@/lib/business-timezone";
import { CUSTOMER_FOLLOW_UP_ORIGINS } from "@/lib/customer-follow-up-origin";

type RetentionDb = PrismaClient | Prisma.TransactionClient;

export const RETENTION_FOLLOW_UP_DUE_STATES = ["NONE", "OVERDUE", "DUE_TODAY", "UPCOMING"] as const;
export type RetentionFollowUpDueState = (typeof RETENTION_FOLLOW_UP_DUE_STATES)[number];

export const RETENTION_FOLLOW_UP_DUE_STATE_LABELS: Record<RetentionFollowUpDueState, string> = {
  NONE: "No due date",
  OVERDUE: "Overdue",
  DUE_TODAY: "Due today",
  UPCOMING: "Upcoming",
};

export async function loadRetentionBusinessTimeZone(db: RetentionDb, businessId: string) {
  const business = await db.business.findFirst({
    where: { id: businessId },
    select: { id: true, timezone: true },
  });
  return resolveBusinessTimeZone(business);
}

export function parseRetentionFollowUpDueOn(
  raw: string | null | undefined,
  timeZone: string,
): Date | null | "invalid" {
  const value = raw?.trim() ?? "";
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "invalid";
  const [year, month, day] = value.split("-").map(Number);
  return parseCivilDateInTimeZone(year, month, day, timeZone) ?? "invalid";
}

export function retentionFollowUpDueState(
  dueAt: Date | null | undefined,
  now: Date,
  timeZone: string,
): RetentionFollowUpDueState {
  if (!dueAt) return "NONE";
  const dueDay = startOfZonedDay(dueAt, timeZone).getTime();
  const today = startOfZonedDay(now, timeZone).getTime();
  if (dueDay < today) return "OVERDUE";
  if (dueDay === today) return "DUE_TODAY";
  return "UPCOMING";
}

export function isRetentionFollowUpDueOrOverdue(state: RetentionFollowUpDueState) {
  return state === "OVERDUE" || state === "DUE_TODAY";
}

export function retentionFollowUpDueStateLabel(state: RetentionFollowUpDueState) {
  return RETENTION_FOLLOW_UP_DUE_STATE_LABELS[state];
}

export function retentionFollowUpDueViewCutoff(now: Date, timeZone: string) {
  return addZonedCalendarDays(startOfZonedDay(now, timeZone), 1, timeZone);
}

export function retentionFollowUpDueViewWhere(businessId: string, now: Date, timeZone: string) {
  return {
    businessId,
    origin: CUSTOMER_FOLLOW_UP_ORIGINS.RETENTION_TASK,
    status: "OPEN" as const,
    dueAt: { not: null, lt: retentionFollowUpDueViewCutoff(now, timeZone) },
  };
}

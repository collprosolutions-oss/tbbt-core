/**
 * Owner-set retention follow-up due dates.
 *
 * Dates are civil days in the business timezone. A due date is a
 * recorded work date. It does not emit a due event or send a message.
 */
import { parseCivilDateInTimeZone, startOfZonedDay } from "@/lib/business-timezone";
import {
  RETENTION_FOLLOW_UP_DUE_STATE_LABELS,
  type RetentionFollowUpDueState,
} from "@/lib/growth/retention/constants";

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type ParsedRetentionDueOn =
  | { ok: true; dueOn: Date | null }
  | { ok: false };

export function parseRetentionFollowUpDueOn(
  raw: string | null | undefined,
  timeZone: string,
): ParsedRetentionDueOn {
  const value = raw?.trim() ?? "";
  if (!value) return { ok: true, dueOn: null };
  if (!CIVIL_DATE.test(value)) return { ok: false };
  const [year, month, day] = value.split("-").map(Number);
  const parsed = parseCivilDateInTimeZone(year, month, day, timeZone);
  if (!parsed) return { ok: false };
  return { ok: true, dueOn: parsed };
}

export function retentionFollowUpDueState(
  dueOn: Date | null | undefined,
  now: Date,
  timeZone: string,
): RetentionFollowUpDueState {
  if (!dueOn) return "none";
  const due = startOfZonedDay(dueOn, timeZone).getTime();
  const today = startOfZonedDay(now, timeZone).getTime();
  if (due < today) return "overdue";
  if (due === today) return "due_today";
  return "upcoming";
}

export function retentionFollowUpDueStateLabel(state: RetentionFollowUpDueState): string {
  return RETENTION_FOLLOW_UP_DUE_STATE_LABELS[state];
}

export function isRetentionFollowUpDueOrOverdue(state: RetentionFollowUpDueState): boolean {
  return state === "overdue" || state === "due_today";
}

export function dueOnInstantsEqual(left: Date | null, right: Date | null): boolean {
  if (left == null && right == null) return true;
  if (left == null || right == null) return false;
  return left.getTime() === right.getTime();
}

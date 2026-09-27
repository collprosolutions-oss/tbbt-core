import { startOfZonedDay } from "@/lib/business-timezone";
import { RETENTION_AGE_PREFIX } from "@/lib/growth/retention/constants";

/**
 * Calendar-day age in the business timezone. Server UTC midnight is not
 * the business day.
 */
export function daysSinceInBusinessTimeZone(
  date: Date,
  now: Date,
  timeZone: string,
): number {
  const start = startOfZonedDay(date, timeZone).getTime();
  const today = startOfZonedDay(now, timeZone).getTime();
  return Math.max(0, Math.round((today - start) / 86_400_000));
}

export function formatLastCompletedAge(days: number): string {
  if (days === 0) return `${RETENTION_AGE_PREFIX} today`;
  if (days === 1) return `${RETENTION_AGE_PREFIX} 1 day ago`;
  return `${RETENTION_AGE_PREFIX} ${days} days ago`;
}

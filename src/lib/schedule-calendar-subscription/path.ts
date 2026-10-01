import { SCHEDULE_CALENDAR_FEED_PATH_PREFIX } from "@/lib/schedule-calendar-subscription/contract";

/**
 * Tokenized calendar feed. Calendar clients have no TBBT session cookie.
 * The edge proxy must not redirect this path to /sign-in — the route
 * itself looks up sha256(token) and rechecks membership on every GET.
 * This is not a public website directory.
 */
export function isScheduleCalendarFeedPath(pathname: string): boolean {
  return (
    pathname === SCHEDULE_CALENDAR_FEED_PATH_PREFIX ||
    pathname.startsWith(`${SCHEDULE_CALENDAR_FEED_PATH_PREFIX}/`)
  );
}

/**
 * Vercel cron path for the OWNER weekly Marketing Studio reminder.
 * Authenticated by CRON_SECRET, not a TBBT session cookie. The edge
 * proxy must not redirect it to /sign-in.
 */
export const STUDIO_WEEKLY_REMINDER_CRON_PATH = "/api/cron/studio-weekly-reminder";

export function isStudioWeeklyReminderCronPath(pathname: string) {
  return pathname === STUDIO_WEEKLY_REMINDER_CRON_PATH;
}

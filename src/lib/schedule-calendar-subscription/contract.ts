/**
 * Optional, revocable calendar subscription.
 *
 * OWNER may subscribe to the business schedule. An active worker may
 * subscribe to jobs currently assigned to them. The raw token is shown
 * once on create/rotate; only sha256(token) is stored. Every feed GET
 * rechecks membership, business, and assignment so deactivation or
 * Chat 4 reassignment removes access immediately.
 *
 * This is not a public directory, not a writable schedule field, and
 * not a second scheduling source. The authenticated one-time .ics
 * download (schedule-calendar-export) stays unchanged.
 */

export const SCHEDULE_CALENDAR_SUBSCRIPTION_CONTRACT =
  "tbbt.schedule-calendar-subscription.v1" as const;
export const SCHEDULE_CALENDAR_SUBSCRIPTION_VERSION = 1;
export const SCHEDULE_CALENDAR_FEED_PATH_PREFIX = "/calendar/feed" as const;
export const SCHEDULE_CALENDAR_FEED_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export const SCHEDULE_CALENDAR_SUBSCRIPTION_SCOPES = ["business", "assigned"] as const;
export type ScheduleCalendarSubscriptionScope =
  (typeof SCHEDULE_CALENDAR_SUBSCRIPTION_SCOPES)[number];

export const SCHEDULE_CALENDAR_FEED_STATUSES = [
  "SCHEDULED",
  "IN_PROGRESS",
  "CANCELLED",
  "CANCELED",
] as const;

export const SCHEDULE_CALENDAR_SUBSCRIPTION_OMISSIONS = [
  "Customer name, email, phone, and other contact details",
  "Property address and access instructions, key locations, and pickup notes",
  "Private job notes, appointment change-request notes, and access codes",
  "Project portal tokens, estimate public tokens, and other secrets",
  "The raw feed token after create/rotate returns",
  "Writes to scheduledAt, duration, assignment, or any other schedule field",
] as const;

export const SCHEDULE_CALENDAR_SUBSCRIPTION_UNAVAILABLE_MESSAGE =
  "Calendar subscription is not available on this environment yet.";
export const SCHEDULE_CALENDAR_SUBSCRIPTION_ALREADY_ACTIVE_MESSAGE =
  "A calendar subscription is already active. Rotate it to replace the URL, or revoke it first.";
export const SCHEDULE_CALENDAR_SUBSCRIPTION_NOT_ACTIVE_MESSAGE =
  "There is no active calendar subscription to change.";
export const SCHEDULE_CALENDAR_SUBSCRIPTION_CREATED_MESSAGE =
  "Calendar subscription created. Copy the URL now — TBBT does not store the raw token.";
export const SCHEDULE_CALENDAR_SUBSCRIPTION_ROTATED_MESSAGE =
  "Calendar subscription rotated. The previous URL stopped working. Copy the new URL now.";
export const SCHEDULE_CALENDAR_SUBSCRIPTION_REVOKED_MESSAGE =
  "Calendar subscription revoked. Calendar apps with the old URL will no longer receive this schedule.";
export const SCHEDULE_CALENDAR_FEED_NOT_FOUND_MESSAGE = "Not found.";

export const SCHEDULE_CALENDAR_FEED_CACHE_CONTROL =
  "private, no-store, no-cache, must-revalidate, max-age=0";

export type ScheduleCalendarSubscriptionStatus = {
  available: boolean;
  active: boolean;
  scope: ScheduleCalendarSubscriptionScope;
  createdAt: Date | null;
  rotatedAt: Date | null;
  revokedAt: Date | null;
};

export type ScheduleCalendarFeedLimits = {
  horizonDays: 90;
  eventLimit: 100;
  liveSynchronization: true;
  publicSubscription: false;
  sharedDatabase: false;
  writesScheduleFields: false;
};

export type ScheduleCalendarFeedDocument = {
  contract: typeof SCHEDULE_CALENDAR_SUBSCRIPTION_CONTRACT;
  version: typeof SCHEDULE_CALENDAR_SUBSCRIPTION_VERSION;
  filename: string;
  ics: string;
  timeZone: string;
  scope: ScheduleCalendarSubscriptionScope;
  rangeStart: Date;
  rangeEnd: Date;
  truncated: boolean;
  events: Array<{
    jobId: string;
    status: string;
    assigned: boolean;
    start: Date;
    end: Date;
    timeZone: string;
  }>;
  authorization: {
    role: "OWNER" | "ADMIN" | "MEMBER";
    authorizedByMembershipId: string;
    membershipActive: true;
    scope: ScheduleCalendarSubscriptionScope;
  };
  limits: ScheduleCalendarFeedLimits;
};

export function isScheduleCalendarSubscriptionScope(
  value: string,
): value is ScheduleCalendarSubscriptionScope {
  return (SCHEDULE_CALENDAR_SUBSCRIPTION_SCOPES as readonly string[]).includes(value);
}

export function isScheduleCalendarFeedToken(token: string): boolean {
  return SCHEDULE_CALENDAR_FEED_TOKEN_PATTERN.test(token);
}

export function scheduleCalendarFeedPath(token: string): string {
  return `${SCHEDULE_CALENDAR_FEED_PATH_PREFIX}/${token}`;
}

export function scheduleCalendarFeedUrl(origin: string | null, token: string): string {
  const path = scheduleCalendarFeedPath(token);
  if (!origin) return path;
  return `${origin.replace(/\/$/, "")}${path}`;
}

export function emptyScheduleCalendarSubscriptionStatus(
  scope: ScheduleCalendarSubscriptionScope,
  available = true,
): ScheduleCalendarSubscriptionStatus {
  return {
    available,
    active: false,
    scope,
    createdAt: null,
    rotatedAt: null,
    revokedAt: null,
  };
}

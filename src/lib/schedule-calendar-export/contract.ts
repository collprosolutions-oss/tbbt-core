/**
 * Authenticated one-time .ics snapshot of recorded Job appointments.
 *
 * OWNER downloads the business's upcoming recorded appointments.
 * An active worker downloads only jobs currently assigned to them.
 *
 * This is not a public calendar subscription, not a writable schedule
 * field, and not a second scheduling source. Times come from the existing
 * Job.scheduledAt / Job.scheduledDurationMinutes columns and the stored
 * Business.timezone (IANA via Intl, never a hard-coded offset).
 */

export const SCHEDULE_CALENDAR_EXPORT_CONTRACT = "tbbt.schedule-calendar.v1" as const;
export const SCHEDULE_CALENDAR_EXPORT_VERSION = 1;
export const SCHEDULE_CALENDAR_EXPORT_SYSTEM = "tbbt-core" as const;
export const SCHEDULE_CALENDAR_EXPORT_PRODUCT = "TBBT" as const;
export const SCHEDULE_CALENDAR_EXPORT_PRODID = "-//TBBT//Schedule Calendar 1.0//EN";

export const SCHEDULE_CALENDAR_EXPORT_HORIZON_DAYS = 90;
export const SCHEDULE_CALENDAR_EXPORT_EVENT_LIMIT = 100;

export const SCHEDULE_CALENDAR_ACTIVE_STATUSES = ["SCHEDULED", "IN_PROGRESS"] as const;
export const SCHEDULE_CALENDAR_EXCLUDED_STATUSES = [
  "CANCELLED",
  "CANCELED",
  "COMPLETED",
  "UNSCHEDULED",
  "CLOSED",
] as const;

export const SCHEDULE_CALENDAR_EXPORT_SCOPES = ["business", "assigned"] as const;
export type ScheduleCalendarExportScope = (typeof SCHEDULE_CALENDAR_EXPORT_SCOPES)[number];

export const SCHEDULE_CALENDAR_EXPORT_OMISSIONS = [
  "Customer name, email, phone, and other contact details",
  "Property address and access instructions, key locations, and pickup notes",
  "Private job notes, appointment change-request notes, and access codes",
  "Project portal tokens, estimate public tokens, and other secrets",
  "A public subscription URL or unguessable feed token",
  "Writes to scheduledAt, duration, assignment, or any other schedule field",
] as const;

export const SCHEDULE_CALENDAR_TRUNCATION_MESSAGE =
  "This one-time calendar includes the next 90 business-timezone days, up to 100 recorded appointments. Additional upcoming rows were omitted.";

export type ScheduleCalendarExportAuthorization = {
  role: "OWNER" | "ADMIN" | "MEMBER";
  authorizedByMembershipId: string;
  membershipActive: true;
  scope: ScheduleCalendarExportScope;
};

export type ScheduleCalendarExportLimits = {
  horizonDays: typeof SCHEDULE_CALENDAR_EXPORT_HORIZON_DAYS;
  eventLimit: typeof SCHEDULE_CALENDAR_EXPORT_EVENT_LIMIT;
  liveSynchronization: false;
  publicSubscription: false;
  sharedDatabase: false;
  writesScheduleFields: false;
};

export type ScheduleCalendarExportEvent = {
  jobId: string;
  status: string;
  assigned: boolean;
  start: Date;
  end: Date;
  timeZone: string;
};

export type ScheduleCalendarExportDocument = {
  contract: typeof SCHEDULE_CALENDAR_EXPORT_CONTRACT;
  version: typeof SCHEDULE_CALENDAR_EXPORT_VERSION;
  filename: string;
  ics: string;
  timeZone: string;
  scope: ScheduleCalendarExportScope;
  rangeStart: Date;
  rangeEnd: Date;
  truncated: boolean;
  events: ScheduleCalendarExportEvent[];
  authorization: ScheduleCalendarExportAuthorization;
  limits: ScheduleCalendarExportLimits;
};

export function defaultScheduleCalendarExportLimits(): ScheduleCalendarExportLimits {
  return {
    horizonDays: SCHEDULE_CALENDAR_EXPORT_HORIZON_DAYS,
    eventLimit: SCHEDULE_CALENDAR_EXPORT_EVENT_LIMIT,
    liveSynchronization: false,
    publicSubscription: false,
    sharedDatabase: false,
    writesScheduleFields: false,
  };
}

export function scheduleCalendarExportFilename(input: {
  scope: ScheduleCalendarExportScope;
  generatedOn: Date;
}): string {
  const day = input.generatedOn.toISOString().slice(0, 10);
  return `tbbt-schedule-${input.scope}-${day}.ics`;
}

export function scheduleCalendarExportTruncationMessage(): string {
  return SCHEDULE_CALENDAR_TRUNCATION_MESSAGE;
}

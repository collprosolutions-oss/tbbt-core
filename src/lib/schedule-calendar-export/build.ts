/**
 * Authenticated builder for a one-time schedule calendar download.
 *
 * Callers must pass access.businessId from requireBusinessAccess().
 * Browser business IDs never authorize this load. The query only reads
 * Job identity, status, assignment, and the recorded start/window.
 */
import type { PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  addZonedCalendarDays,
  resolveBusinessTimeZone,
  startOfZonedDay,
} from "@/lib/business-timezone";
import { scheduleWindow } from "@/lib/job-schedule";
import { assertScheduleCalendarExportScope } from "@/lib/schedule-calendar-export/access";
import {
  SCHEDULE_CALENDAR_ACTIVE_STATUSES,
  SCHEDULE_CALENDAR_EXPORT_CONTRACT,
  SCHEDULE_CALENDAR_EXPORT_EVENT_LIMIT,
  SCHEDULE_CALENDAR_EXPORT_HORIZON_DAYS,
  SCHEDULE_CALENDAR_EXPORT_VERSION,
  defaultScheduleCalendarExportLimits,
  scheduleCalendarExportFilename,
  type ScheduleCalendarExportDocument,
  type ScheduleCalendarExportEvent,
  type ScheduleCalendarExportScope,
} from "@/lib/schedule-calendar-export/contract";
import { serializeScheduleCalendarIcs } from "@/lib/schedule-calendar-export/ics";

export type BuildScheduleCalendarExportInput = {
  scope: ScheduleCalendarExportScope;
  now?: Date;
};

export function boundCalendarRead<T>(
  rows: readonly T[],
  limit: number,
): { items: T[]; truncated: boolean; limit: number } {
  const truncated = rows.length > limit;
  return {
    items: truncated ? rows.slice(0, limit) : [...rows],
    truncated,
    limit,
  };
}

const CALENDAR_JOB_SELECT = {
  id: true,
  businessId: true,
  status: true,
  scheduledAt: true,
  scheduledDurationMinutes: true,
  assignedMembershipId: true,
} as const;

export async function buildScheduleCalendarExport(
  prisma: PrismaClient,
  access: BusinessAccess,
  input: BuildScheduleCalendarExportInput,
): Promise<ScheduleCalendarExportDocument> {
  assertScheduleCalendarExportScope(access, input.scope);

  const businessId = access.businessId;
  const business = await prisma.business.findFirst({
    where: { id: businessId },
    select: { id: true, timezone: true },
  });
  if (!business) {
    throw new Error("Record is not in the authorized business workspace.");
  }
  access.assertOwned({ businessId: business.id });

  const timeZone = resolveBusinessTimeZone(business);
  const generatedAt = input.now ?? new Date();
  const rangeStart = startOfZonedDay(generatedAt, timeZone);
  const rangeEnd = addZonedCalendarDays(rangeStart, SCHEDULE_CALENDAR_EXPORT_HORIZON_DAYS, timeZone);
  const membershipId = access.workspace.membership.id;

  const rows = await prisma.job.findMany({
    where: {
      businessId,
      scheduledAt: { gte: rangeStart, lt: rangeEnd },
      status: { in: [...SCHEDULE_CALENDAR_ACTIVE_STATUSES] },
      ...(input.scope === "assigned" ? { assignedMembershipId: membershipId } : {}),
    },
    select: CALENDAR_JOB_SELECT,
    orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
    take: SCHEDULE_CALENDAR_EXPORT_EVENT_LIMIT + 1,
  });

  for (const row of rows) {
    access.assertOwned(row);
  }

  const bounded = boundCalendarRead(rows, SCHEDULE_CALENDAR_EXPORT_EVENT_LIMIT);
  const events: ScheduleCalendarExportEvent[] = bounded.items.map((row) => {
    const start = row.scheduledAt;
    if (!start) {
      throw new Error("Recorded appointment is missing scheduledAt.");
    }
    const window = scheduleWindow(start, row.scheduledDurationMinutes);
    return {
      jobId: row.id,
      status: row.status,
      assigned: row.assignedMembershipId != null,
      start: window.start,
      end: window.end,
      timeZone,
    };
  });

  const ics = serializeScheduleCalendarIcs({
    timeZone,
    scope: input.scope,
    generatedAt,
    truncated: bounded.truncated,
    events,
  });

  return {
    contract: SCHEDULE_CALENDAR_EXPORT_CONTRACT,
    version: SCHEDULE_CALENDAR_EXPORT_VERSION,
    filename: scheduleCalendarExportFilename({
      scope: input.scope,
      generatedOn: generatedAt,
    }),
    ics,
    timeZone,
    scope: input.scope,
    rangeStart,
    rangeEnd,
    truncated: bounded.truncated,
    events,
    authorization: {
      role: access.workspace.role,
      authorizedByMembershipId: membershipId,
      membershipActive: true,
      scope: input.scope,
    },
    limits: defaultScheduleCalendarExportLimits(),
  };
}

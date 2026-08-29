import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/page-header";
import { CrewView } from "@/components/schedule/crew-view";
import { DayView } from "@/components/schedule/day-view";
import {
  JobsListView,
  type JobsListItem,
} from "@/components/schedule/jobs-list-view";
import { MonthView } from "@/components/schedule/month-view";
import { ScheduleDateNav } from "@/components/schedule/schedule-date-nav";
import { ScheduleViewTabs } from "@/components/schedule/schedule-view-tabs";
import { UnscheduledJobsPanel } from "@/components/schedule/unscheduled-jobs-panel";
import { WeekView } from "@/components/schedule/week-view";
import { requireManagementPageAccess } from "@/lib/access";
import {
  SCHEDULE_JOB_SELECT,
  dayLabel,
  dayRange,
  findScheduleConflicts,
  formatISODate,
  groupJobsByDay,
  isSameDay,
  monthGridRange,
  monthLabel,
  parseScheduleDate,
  parseScheduleView,
  startOfDay,
  weekLabel,
  weekRange,
} from "@/lib/schedule";
import { prisma } from "@/lib/prisma";

// Deliberately not the exact "Schedule / Jobs" sidebar nav label: Next's
// metadata system resolves a page's static <title> even on an unauthorized
// redirect response (a harmless artifact, not a data leak -- see the
// management-console-access check's own note on this), and reusing the nav
// label text verbatim here would make that harmless title collide with the
// "is the real sidebar nav present" check in scripts/check-management-console-access.mjs.
export const metadata: Metadata = {
  title: "Schedule",
};

const UNSCHEDULED_PANEL_TAKE = 25;

const UNSCHEDULED_PANEL_SELECT = {
  id: true,
  customer: { select: { name: true } },
  property: {
    select: {
      addressLine1: true,
      addressLine2: true,
      city: true,
      region: true,
      postalCode: true,
    },
  },
} as const;

/**
 * Conflict detection is real but bounded (see findScheduleConflicts() in
 * src/lib/schedule.ts): it only compares Jobs' own recorded start time and
 * duration, and never invents precision the data doesn't have.
 */
const CONFLICT_METHOD_NOTE =
  "Conflicts are flagged only when two Jobs' known start times and durations actually overlap. A Job with no saved duration is compared as a single instant, so some real-world conflicts may go undetected here -- never fabricated.";

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; date?: string }>;
}) {
  const params = await searchParams;
  const access = await requireManagementPageAccess();
  const view = parseScheduleView(params.view);
  const anchorDate = parseScheduleDate(params.date);
  const today = startOfDay(new Date());
  const todayRange = dayRange(today);

  const [todayCount, unscheduledJobs, unscheduledCount] = await Promise.all([
    prisma.job.count({
      where: {
        ...access.scope,
        scheduledAt: { gte: todayRange.start, lt: todayRange.end },
      },
    }),
    prisma.job.findMany({
      where: { ...access.scope, status: "UNSCHEDULED" },
      select: UNSCHEDULED_PANEL_SELECT,
      orderBy: { createdAt: "desc" },
      take: UNSCHEDULED_PANEL_TAKE,
    }),
    prisma.job.count({ where: { ...access.scope, status: "UNSCHEDULED" } }),
  ]);

  const todayIso = formatISODate(today);
  const headerDescription = (
    <span>
      Jobs for {access.workspace.business.name}.{" "}
      {todayCount === 0
        ? "No jobs scheduled today."
        : `${todayCount} job${todayCount === 1 ? "" : "s"} scheduled today.`}{" "}
      <Link href={`/jobs?view=day&date=${todayIso}`} className="underline underline-offset-4">
        View today
      </Link>
    </span>
  );

  let content: ReactNode;
  let dateNavLabel: string | null = null;

  if (view === "month") {
    const range = monthGridRange(anchorDate);
    const jobs = await prisma.job.findMany({
      where: {
        ...access.scope,
        scheduledAt: { gte: range.start, lt: range.end },
      },
      select: SCHEDULE_JOB_SELECT,
      orderBy: { scheduledAt: "asc" },
    });
    const jobsByDay = groupJobsByDay(jobs);
    const conflicts = findScheduleConflicts(jobs);
    dateNavLabel = monthLabel(anchorDate);
    content = (
      <MonthView
        days={range.days}
        monthStart={range.monthStart}
        monthEnd={range.monthEnd}
        today={today}
        jobsByDay={jobsByDay}
        conflicts={conflicts}
      />
    );
  } else if (view === "week") {
    const range = weekRange(anchorDate);
    const jobs = await prisma.job.findMany({
      where: {
        ...access.scope,
        scheduledAt: { gte: range.start, lt: range.end },
      },
      select: SCHEDULE_JOB_SELECT,
      orderBy: { scheduledAt: "asc" },
    });
    const jobsByDay = groupJobsByDay(jobs);
    const conflicts = findScheduleConflicts(jobs);
    dateNavLabel = weekLabel(range);
    content = (
      <WeekView
        days={range.days}
        today={today}
        jobsByDay={jobsByDay}
        conflicts={conflicts}
      />
    );
  } else if (view === "day") {
    const range = dayRange(anchorDate);
    const jobs = await prisma.job.findMany({
      where: {
        ...access.scope,
        scheduledAt: { gte: range.start, lt: range.end },
      },
      select: SCHEDULE_JOB_SELECT,
      orderBy: { scheduledAt: "asc" },
    });
    const conflicts = findScheduleConflicts(jobs);
    dateNavLabel = dayLabel(anchorDate);
    content = (
      <DayView
        jobs={jobs}
        conflicts={conflicts}
        isToday={isSameDay(anchorDate, today)}
      />
    );
  } else if (view === "crew") {
    const range = monthGridRange(anchorDate);
    const jobs = await prisma.job.findMany({
      where: {
        ...access.scope,
        status: { in: ["SCHEDULED", "IN_PROGRESS"] },
        scheduledAt: { gte: range.monthStart, lt: range.monthEnd },
      },
      select: SCHEDULE_JOB_SELECT,
      orderBy: { scheduledAt: "asc" },
    });
    dateNavLabel = monthLabel(anchorDate);
    content = <CrewView jobs={jobs} monthLabel={monthLabel(anchorDate)} />;
  } else {
    const jobs: JobsListItem[] = await prisma.job.findMany({
      where: access.scope,
      include: {
        customer: { select: { name: true } },
        property: {
          select: {
            addressLine1: true,
            addressLine2: true,
            city: true,
            region: true,
            postalCode: true,
          },
        },
        estimate: { select: { total: true } },
      },
    });
    content = <JobsListView jobs={jobs} />;
  }

  const showUnscheduledPanel = view !== "list";
  const showConflictNote = view === "month" || view === "week" || view === "day";

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title="Schedule / Jobs" description={headerDescription} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <ScheduleViewTabs view={view} date={anchorDate} />
        {dateNavLabel ? (
          <ScheduleDateNav view={view} date={anchorDate} label={dateNavLabel} />
        ) : null}
      </div>

      {showUnscheduledPanel ? (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-3 lg:col-span-2">
            {content}
            {showConflictNote ? (
              <p className="text-xs text-muted-foreground">{CONFLICT_METHOD_NOTE}</p>
            ) : null}
          </div>
          <div className="lg:col-span-1">
            <UnscheduledJobsPanel
              jobs={unscheduledJobs}
              totalCount={unscheduledCount}
            />
          </div>
        </div>
      ) : (
        <div className="space-y-6">{content}</div>
      )}
    </div>
  );
}

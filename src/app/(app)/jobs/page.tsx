import type { Metadata } from "next";
import Link from "next/link";
import type { ComponentType, ReactNode } from "react";
import { Prisma } from "@prisma/client";
import { CalendarClock, CalendarDays, CalendarX2, CheckCircle2, Timer } from "lucide-react";
import { CrewFilterSelect } from "@/components/jobs/crew-filter-select";
import { DateFilterSelect } from "@/components/jobs/date-filter-select";
import {
  JobsWorkspace,
  type JobChangeOrderSummary,
  type JobListItem,
} from "@/components/jobs/jobs-workspace";
import { PageSizeSelect } from "@/components/jobs/page-size-select";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { PageHeaderControls } from "@/components/page-header-controls";
import { CrewView } from "@/components/schedule/crew-view";
import { DayView } from "@/components/schedule/day-view";
import { JobsListView, type JobsListItem } from "@/components/schedule/jobs-list-view";
import { MonthView } from "@/components/schedule/month-view";
import { ScheduleDateNav } from "@/components/schedule/schedule-date-nav";
import { ScheduleViewTabs } from "@/components/schedule/schedule-view-tabs";
import { UnscheduledJobsPanel } from "@/components/schedule/unscheduled-jobs-panel";
import { WeekView } from "@/components/schedule/week-view";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { requireManagementPageAccess } from "@/lib/access";
import { resolveCurrentApprovedProjectTotal } from "@/lib/change-order";
import { formatAddress, formatDateTime, formatMoney } from "@/lib/format";
import {
  durationPresetForMinutes,
  formatDurationMinutes,
} from "@/lib/job-schedule";
import { prisma } from "@/lib/prisma";
import {
  SCHEDULE_JOB_SELECT,
  dayLabel,
  dayRange,
  findScheduleConflicts,
  formatISODate,
  groupJobsByDay,
  isSameDay,
  jobScopeSummary,
  monthGridRange,
  monthLabel,
  parseScheduleDate,
  parseScheduleView,
  startOfDay,
  weekLabel,
  weekRange,
} from "@/lib/schedule";
import { cn } from "@/lib/utils";

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
const DEFAULT_PAGE_SIZE = 10;
const PAGE_SIZE_OPTIONS = [10, 25, 50];

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

/**
 * The real Job lifecycle only (see prisma/schema.prisma's Job.status
 * comment): UNSCHEDULED | SCHEDULED -> IN_PROGRESS -> COMPLETED. There is
 * no ON_HOLD or CANCELLED Job status anywhere in the schema or any server
 * action -- the locked mockup's "On Hold"/"Canceled" tabs are intentionally
 * not implemented here rather than faked.
 */
const TAB_KEYS = ["unscheduled", "scheduled", "in_progress", "completed"] as const;
type TabKey = (typeof TAB_KEYS)[number] | "all";

function parseTab(raw: string | undefined): TabKey {
  const normalized = (raw ?? "").toLowerCase();
  return (TAB_KEYS as readonly string[]).includes(normalized) ? (normalized as TabKey) : "all";
}

function rangeFilterStart(preset: string | undefined, now: Date) {
  if (preset === "30d") return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (preset === "month") return new Date(now.getFullYear(), now.getMonth(), 1);
  if (preset === "year") return new Date(now.getFullYear(), 0, 1);
  return null;
}

/**
 * Total-only extraction mirroring resolveApprovedWorkOrderScope()'s exact
 * priority (bound EstimateVersion, then legacy Estimate, then none) plus
 * the canonical resolveCurrentApprovedProjectTotal() for approved Change
 * Orders -- used where only the number is needed (KPI sums), not the full
 * line-item breakdown, so those queries can select just `total` instead of
 * every line item. This is not a second calculation of the underlying
 * logic; it calls the exact same canonical Change Order sum helper.
 */
function computeJobTotal(job: {
  approvedEstimateVersion: { total: Prisma.Decimal } | null;
  estimate: { total: Prisma.Decimal } | null;
  changeOrders: { status: string; total: Prisma.Decimal }[];
}): Prisma.Decimal | null {
  const base = job.approvedEstimateVersion?.total ?? job.estimate?.total ?? null;
  if (!base) return null;
  return resolveCurrentApprovedProjectTotal(base, job.changeOrders);
}

const LINE_ITEM_SELECT = {
  description: true,
  quantity: true,
  unitPrice: true,
  total: true,
  type: true,
} as const;

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{
    view?: string;
    date?: string;
    q?: string;
    status?: string;
    crew?: string;
    range?: string;
    page?: string;
    pageSize?: string;
  }>;
}) {
  const params = await searchParams;
  const access = await requireManagementPageAccess();
  const view = parseScheduleView(params.view);
  const anchorDate = parseScheduleDate(params.date);
  const today = startOfDay(new Date());
  const todayRange = dayRange(today);
  const thisWeek = weekRange(today);

  const q = (params.q ?? "").trim();
  const tab = parseTab(params.status);
  const crew = params.crew;
  const rangePreset = params.range && params.range !== "all" ? params.range : undefined;
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(params.pageSize))
    ? Number(params.pageSize)
    : DEFAULT_PAGE_SIZE;
  const page = Math.max(1, Number(params.page) || 1);

  const tabWhere = tab === "all" ? {} : { status: tab.toUpperCase() };
  const searchWhere = q
    ? {
        OR: [
          { customer: { name: { contains: q, mode: "insensitive" as const } } },
          { customer: { email: { contains: q, mode: "insensitive" as const } } },
          { customer: { phone: { contains: q, mode: "insensitive" as const } } },
          { property: { addressLine1: { contains: q, mode: "insensitive" as const } } },
          {
            approvedEstimateVersion: {
              lineItems: { some: { description: { contains: q, mode: "insensitive" as const } } },
            },
          },
          {
            estimate: {
              lineItems: { some: { description: { contains: q, mode: "insensitive" as const } } },
            },
          },
        ],
      }
    : {};
  const crewWhere =
    crew === "unassigned"
      ? { assignedMembershipId: null }
      : crew && crew !== "all"
        ? { assignedMembershipId: crew }
        : {};
  const rangeStart = rangeFilterStart(rangePreset, today);
  const explicitRangeWhere = rangeStart ? { scheduledAt: { gte: rangeStart } } : {};
  /**
   * When the owner has not explicitly chosen a date filter, the Jobs
   * table below defaults to the SAME date bounds as whichever calendar
   * view is currently selected above it (the exact range that view's own
   * query already uses -- see the view branches further down), so
   * viewing e.g. Month view for August never shows a September job
   * anywhere on the page, matching the calendar's own scoping guarantee
   * (see scripts/check-schedule-calendar.mjs TEST 5/6/8). List view has
   * no date concept (same as the existing JobsListView), so it stays
   * unbounded, matching that existing behavior. An explicit `range`
   * filter always overrides this default.
   *
   * UNSCHEDULED jobs have no `scheduledAt` at all, so an `OR
   * scheduledAt: null` branch keeps them visible under "All Jobs" /
   * "Unscheduled" regardless of which calendar range is selected --
   * excluding them here would silently break the Unscheduled tab/KPI
   * every time a date-bounded calendar view is active.
   */
  function boundedOrUnscheduled(range: { start: Date; end: Date }) {
    return { OR: [{ scheduledAt: { gte: range.start, lt: range.end } }, { scheduledAt: null }] };
  }
  const defaultRangeWhere =
    view === "month"
      ? boundedOrUnscheduled(monthGridRange(anchorDate))
      : view === "crew"
        ? boundedOrUnscheduled({
            start: monthGridRange(anchorDate).monthStart,
            end: monthGridRange(anchorDate).monthEnd,
          })
        : view === "week"
          ? boundedOrUnscheduled(weekRange(anchorDate))
          : view === "day"
            ? boundedOrUnscheduled(dayRange(anchorDate))
            : {};
  const rangeWhere = rangePreset ? explicitRangeWhere : defaultRangeWhere;

  const tableWhere = { ...access.scope, ...tabWhere, ...searchWhere, ...crewWhere, ...rangeWhere };

  const [
    todayCount,
    unscheduledJobs,
    unscheduledCount,
    scheduledCount,
    inProgressCount,
    completedCount,
    thisWeekJobsForSum,
    completedThisWeekJobsForSum,
    eligibleMembers,
    matchedCount,
    jobsRaw,
  ] = await Promise.all([
    prisma.job.count({
      where: { ...access.scope, scheduledAt: { gte: todayRange.start, lt: todayRange.end } },
    }),
    prisma.job.findMany({
      where: { ...access.scope, status: "UNSCHEDULED" },
      select: UNSCHEDULED_PANEL_SELECT,
      orderBy: { createdAt: "desc" },
      take: UNSCHEDULED_PANEL_TAKE,
    }),
    prisma.job.count({ where: { ...access.scope, status: "UNSCHEDULED" } }),
    prisma.job.count({ where: { ...access.scope, status: "SCHEDULED" } }),
    prisma.job.count({ where: { ...access.scope, status: "IN_PROGRESS" } }),
    prisma.job.count({ where: { ...access.scope, status: "COMPLETED" } }),
    prisma.job.findMany({
      where: { ...access.scope, scheduledAt: { gte: thisWeek.start, lt: thisWeek.end } },
      select: {
        approvedEstimateVersion: { select: { total: true } },
        estimate: { select: { total: true } },
        changeOrders: { select: { status: true, total: true } },
      },
    }),
    prisma.job.findMany({
      where: {
        ...access.scope,
        status: "COMPLETED",
        updatedAt: { gte: thisWeek.start, lt: thisWeek.end },
      },
      select: {
        approvedEstimateVersion: { select: { total: true } },
        estimate: { select: { total: true } },
        changeOrders: { select: { status: true, total: true } },
      },
    }),
    prisma.membership.findMany({
      where: { businessId: access.businessId, role: "MEMBER", active: true },
      select: { id: true, user: { select: { name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.job.count({ where: tableWhere }),
    prisma.job.findMany({
      where: tableWhere,
      include: {
        customer: { select: { id: true, name: true, phone: true, email: true } },
        property: {
          select: { addressLine1: true, addressLine2: true, city: true, region: true, postalCode: true },
        },
        estimate: { select: { total: true, lineItems: { orderBy: { createdAt: "asc" }, select: LINE_ITEM_SELECT } } },
        approvedEstimateVersion: {
          select: {
            versionNumber: true,
            total: true,
            approvedAt: true,
            lineItems: { orderBy: { createdAt: "asc" }, select: LINE_ITEM_SELECT },
          },
        },
        changeOrders: { orderBy: { createdAt: "desc" }, select: { id: true, title: true, status: true, total: true } },
        additionalWorkRequests: { where: { status: "OPEN" }, select: { id: true } },
        assignedMembership: { select: { id: true, user: { select: { name: true } } } },
        invoices: { select: { id: true, status: true, total: true }, take: 1, orderBy: { createdAt: "asc" } },
        photos: { select: { id: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  const jobsThisWeekCount = thisWeekJobsForSum.length;
  const jobsThisWeekValue = thisWeekJobsForSum.reduce(
    (sum, job) => sum.add(computeJobTotal(job) ?? new Prisma.Decimal(0)),
    new Prisma.Decimal(0),
  );
  const completedThisWeekCount = completedThisWeekJobsForSum.length;
  const completedThisWeekValue = completedThisWeekJobsForSum.reduce(
    (sum, job) => sum.add(computeJobTotal(job) ?? new Prisma.Decimal(0)),
    new Prisma.Decimal(0),
  );

  function pad(part: number) {
    return String(part).padStart(2, "0");
  }
  function toDateInput(value: Date) {
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  function toTimeInput(value: Date) {
    return `${pad(value.getHours())}:${pad(value.getMinutes())}`;
  }

  const jobs: JobListItem[] = jobsRaw.map((job) => {
    const approvedTotal = job.approvedEstimateVersion?.total ?? job.estimate?.total ?? null;
    const source: JobListItem["approvedScopeSource"] = job.approvedEstimateVersion
      ? "version"
      : job.estimate
        ? "legacy-estimate"
        : "none";
    const lineItems = job.approvedEstimateVersion?.lineItems ?? job.estimate?.lineItems ?? [];
    const approvedChangeOrders: JobChangeOrderSummary[] = job.changeOrders
      .filter((co) => co.status === "APPROVED")
      .map((co) => ({ id: co.id, title: co.title, totalLabel: formatMoney(co.total) }));
    const currentTotal = approvedTotal ? resolveCurrentApprovedProjectTotal(approvedTotal, job.changeOrders) : null;
    const durationPreset = durationPresetForMinutes(job.scheduledDurationMinutes);
    const invoice = job.invoices[0] ?? null;

    return {
      id: job.id,
      status: job.status,
      customer: job.customer,
      propertyLabel: job.property ? formatAddress(job.property) : null,
      scopeSummary: jobScopeSummary(job),
      scheduledAtLabel: job.scheduledAt ? formatDateTime(job.scheduledAt) : null,
      durationLabel: job.scheduledDurationMinutes
        ? formatDurationMinutes(job.scheduledDurationMinutes)
        : null,
      assignedMemberName: job.assignedMembership?.user.name ?? null,
      assignedMembershipId: job.assignedMembership?.id ?? null,
      amountLabel: currentTotal ? formatMoney(currentTotal) : null,
      invoice: invoice ? { id: invoice.id, status: invoice.status, totalLabel: formatMoney(invoice.total) } : null,
      projectToken: job.projectToken,
      photoCount: job.photos.length,
      additionalWorkRequestCount: job.additionalWorkRequests.length,
      scheduleDate: job.scheduledAt ? toDateInput(job.scheduledAt) : "",
      scheduleTime: job.scheduledAt ? toTimeInput(job.scheduledAt) : "",
      durationPreset,
      customHours:
        durationPreset === "custom" && job.scheduledDurationMinutes
          ? (job.scheduledDurationMinutes / 60).toString()
          : "",
      approvedScopeSource: source,
      approvedScopeVersionNumber: job.approvedEstimateVersion?.versionNumber ?? null,
      originalApprovedTotalLabel: approvedTotal ? formatMoney(approvedTotal) : null,
      approvedScopeLineItems: lineItems.map((item) => ({
        description: item.description,
        quantity: item.quantity.toString(),
        unitPrice: formatMoney(item.unitPrice),
        total: formatMoney(item.total),
      })),
      approvedChangeOrders,
    };
  });

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
    const calendarJobs = await prisma.job.findMany({
      where: { ...access.scope, scheduledAt: { gte: range.start, lt: range.end } },
      select: SCHEDULE_JOB_SELECT,
      orderBy: { scheduledAt: "asc" },
    });
    const jobsByDay = groupJobsByDay(calendarJobs);
    const conflicts = findScheduleConflicts(calendarJobs);
    dateNavLabel = monthLabel(anchorDate);
    content = (
      <MonthView days={range.days} monthStart={range.monthStart} monthEnd={range.monthEnd} today={today} jobsByDay={jobsByDay} conflicts={conflicts} />
    );
  } else if (view === "week") {
    const range = weekRange(anchorDate);
    const calendarJobs = await prisma.job.findMany({
      where: { ...access.scope, scheduledAt: { gte: range.start, lt: range.end } },
      select: SCHEDULE_JOB_SELECT,
      orderBy: { scheduledAt: "asc" },
    });
    const jobsByDay = groupJobsByDay(calendarJobs);
    const conflicts = findScheduleConflicts(calendarJobs);
    dateNavLabel = weekLabel(range);
    content = <WeekView days={range.days} today={today} jobsByDay={jobsByDay} conflicts={conflicts} />;
  } else if (view === "day") {
    const range = dayRange(anchorDate);
    const calendarJobs = await prisma.job.findMany({
      where: { ...access.scope, scheduledAt: { gte: range.start, lt: range.end } },
      select: SCHEDULE_JOB_SELECT,
      orderBy: { scheduledAt: "asc" },
    });
    const conflicts = findScheduleConflicts(calendarJobs);
    dateNavLabel = dayLabel(anchorDate);
    content = <DayView jobs={calendarJobs} conflicts={conflicts} isToday={isSameDay(anchorDate, today)} />;
  } else if (view === "crew") {
    const range = monthGridRange(anchorDate);
    const calendarJobs = await prisma.job.findMany({
      where: {
        ...access.scope,
        status: { in: ["SCHEDULED", "IN_PROGRESS"] },
        scheduledAt: { gte: range.monthStart, lt: range.monthEnd },
      },
      select: SCHEDULE_JOB_SELECT,
      orderBy: { scheduledAt: "asc" },
    });
    dateNavLabel = monthLabel(anchorDate);
    content = <CrewView jobs={calendarJobs} monthLabel={monthLabel(anchorDate)} />;
  } else {
    const listJobs: JobsListItem[] = await prisma.job.findMany({
      where: access.scope,
      include: {
        customer: { select: { name: true } },
        property: { select: { addressLine1: true, addressLine2: true, city: true, region: true, postalCode: true } },
        estimate: { select: { total: true } },
      },
    });
    content = <JobsListView jobs={listJobs} />;
  }

  const showUnscheduledPanel = view !== "list";
  const showConflictNote = view === "month" || view === "week" || view === "day";

  const kpis: KpiCardProps[] = [
    {
      label: "Jobs This Week",
      value: jobsThisWeekCount,
      sublabel: jobsThisWeekValue.gt(0) ? formatMoney(jobsThisWeekValue) : undefined,
      icon: CalendarClock,
      accent: "blue",
      href: "/jobs",
    },
    {
      label: "Scheduled",
      value: scheduledCount,
      icon: CalendarDays,
      accent: "purple",
      href: "/jobs?status=scheduled",
    },
    {
      label: "In Progress",
      value: inProgressCount,
      icon: Timer,
      accent: "orange",
      href: "/jobs?status=in_progress",
    },
    {
      label: "Completed",
      value: completedThisWeekCount,
      sublabel: completedThisWeekValue.gt(0) ? `${formatMoney(completedThisWeekValue)} this week` : "This week",
      icon: CheckCircle2,
      accent: "green",
      href: "/jobs?status=completed",
    },
    {
      label: "Unscheduled",
      value: unscheduledCount,
      icon: CalendarX2,
      accent: "slate",
      href: "/jobs?status=unscheduled",
    },
  ];

  const otherParams = new URLSearchParams();
  if (q) otherParams.set("q", q);
  if (crew) otherParams.set("crew", crew);
  if (rangePreset) otherParams.set("range", rangePreset);
  if (pageSize !== DEFAULT_PAGE_SIZE) otherParams.set("pageSize", String(pageSize));

  const tabs: { key: TabKey; label: string; count: number }[] = [
    {
      key: "all",
      label: "All Jobs",
      count: unscheduledCount + scheduledCount + inProgressCount + completedCount,
    },
    { key: "unscheduled", label: "Unscheduled", count: unscheduledCount },
    { key: "scheduled", label: "Scheduled", count: scheduledCount },
    { key: "in_progress", label: "In Progress", count: inProgressCount },
    { key: "completed", label: "Completed", count: completedCount },
  ];

  const totalPages = Math.max(1, Math.ceil(matchedCount / pageSize));
  const rangeStartRow = matchedCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEndRow = Math.min(matchedCount, page * pageSize);

  function pageHref(target: number) {
    const linkParams = new URLSearchParams(otherParams);
    if (tab !== "all") linkParams.set("status", tab);
    if (target > 1) linkParams.set("page", String(target));
    const query = linkParams.toString();
    return `/jobs${query ? `?${query}` : ""}`;
  }

  const crewOptions = eligibleMembers.map((member) => ({ id: member.id, name: member.user.name }));

  const calendarSection = (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ScheduleViewTabs view={view} date={anchorDate} />
        {dateNavLabel ? <ScheduleDateNav view={view} date={anchorDate} label={dateNavLabel} /> : null}
      </div>

      {showUnscheduledPanel ? (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-3 lg:col-span-2">
            {content}
            {showConflictNote ? <p className="text-xs text-muted-foreground">{CONFLICT_METHOD_NOTE}</p> : null}
          </div>
          <div className="lg:col-span-1">
            <UnscheduledJobsPanel jobs={unscheduledJobs} totalCount={unscheduledCount} />
          </div>
        </div>
      ) : (
        <div className="space-y-6">{content}</div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-3 pt-2">
        <nav className="flex flex-wrap items-center gap-1.5 overflow-x-auto">
          {tabs.map((tabItem) => {
            const linkParams = new URLSearchParams(otherParams);
            if (tabItem.key !== "all") linkParams.set("status", tabItem.key);
            const query = linkParams.toString();
            const active = tabItem.key === tab;
            return (
              <Link
                key={tabItem.key}
                href={`/jobs${query ? `?${query}` : ""}`}
                className={cn(
                  "flex items-center gap-2 rounded-md border-b-2 px-4 py-2 text-sm font-medium transition-colors",
                  active
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                {tabItem.label}
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-xs font-semibold tabular-nums",
                    active ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
                  )}
                >
                  {tabItem.count}
                </span>
              </Link>
            );
          })}
        </nav>
        <div className="flex flex-wrap items-center gap-2">
          {crewOptions.length > 0 ? <CrewFilterSelect value={crew ?? "all"} options={crewOptions} /> : null}
          <DateFilterSelect value={rangePreset ?? "all"} />
        </div>
      </div>
    </>
  );

  const pagination =
    matchedCount > 0 ? (
      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <p className="text-sm text-muted-foreground">
          Showing {rangeStartRow} to {rangeEndRow} of {matchedCount} job{matchedCount === 1 ? "" : "s"}
        </p>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
            Rows per page
            <PageSizeSelect value={pageSize} />
          </div>
          {totalPages > 1 ? (
            <div className="flex items-center gap-1">
              <Link
                href={pageHref(Math.max(1, page - 1))}
                aria-disabled={page <= 1}
                className={cn(
                  "inline-flex h-8 items-center rounded-lg border border-border px-3 text-sm",
                  page <= 1 && "pointer-events-none opacity-50",
                )}
              >
                Prev
              </Link>
              <span className="px-2 text-sm tabular-nums text-muted-foreground">
                {page} / {totalPages}
              </span>
              <Link
                href={pageHref(Math.min(totalPages, page + 1))}
                aria-disabled={page >= totalPages}
                className={cn(
                  "inline-flex h-8 items-center rounded-lg border border-border px-3 text-sm",
                  page >= totalPages && "pointer-events-none opacity-50",
                )}
              >
                Next
              </Link>
            </div>
          ) : null}
        </div>
      </div>
    ) : null;

  return (
    <PageContainer width="2xl">
      {/*
       * Shared header slots (TBBT logo -> business switcher -> page title
       * -> primary action -> search -> ... -> theme -> account). No
       * primary action is registered: creating a Job directly (bypassing
       * Estimate -> Approval) is not a supported, lifecycle-safe workflow
       * (see createJobFromEstimate() in src/app/actions/job.ts, the ONLY
       * way a Job is ever created) -- inventing a "+ New Job" action here
       * would either silently do nothing real or bypass the approved
       * lifecycle, so the slot is intentionally left empty rather than
       * fabricated.
       */}
      <PageHeaderControls
        search={
          <form action="/jobs" method="GET" className="flex items-center gap-2">
            <input type="hidden" name="status" value={tab === "all" ? "" : tab} />
            <input type="hidden" name="crew" value={crew ?? ""} />
            <input type="hidden" name="range" value={rangePreset ?? ""} />
            <Input type="search" name="q" defaultValue={q} placeholder="Search jobs..." className="h-9 w-56" />
          </form>
        }
      />
      <PageHeader title="Schedule / Jobs" description={headerDescription} />

      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-5">
        {kpis.map((kpi) => (
          <KpiCard key={kpi.label} {...kpi} />
        ))}
      </div>

      {/* Mobile-only search fallback -- the shared header's search slot only renders on desktop. */}
      <form action="/jobs" method="GET" className="md:hidden">
        <input type="hidden" name="status" value={tab === "all" ? "" : tab} />
        <input type="hidden" name="crew" value={crew ?? ""} />
        <input type="hidden" name="range" value={rangePreset ?? ""} />
        <Input type="search" name="q" defaultValue={q} placeholder="Search jobs..." className="h-9" />
      </form>

      <JobsWorkspace
        calendarSection={calendarSection}
        jobs={jobs}
        eligibleMembers={eligibleMembers.map((member) => ({
          id: member.id,
          name: member.user.name,
          email: member.user.email,
        }))}
        pagination={pagination}
      />
    </PageContainer>
  );
}

type KpiAccent = "blue" | "orange" | "purple" | "teal" | "green" | "slate";

const KPI_ACCENT_CLASSES: Record<KpiAccent, string> = {
  blue: "bg-blue-500/15 text-blue-400",
  orange: "bg-orange-500/15 text-orange-400",
  purple: "bg-purple-500/15 text-purple-400",
  teal: "bg-teal-500/15 text-teal-400",
  green: "bg-green-500/15 text-green-400",
  slate: "bg-slate-500/15 text-slate-400",
};

type KpiCardProps = {
  label: string;
  value: ReactNode;
  sublabel?: string;
  href: string;
  icon: ComponentType<{ className?: string }>;
  accent: KpiAccent;
};

function KpiCard({ label, value, sublabel, href, icon: Icon, accent }: KpiCardProps) {
  return (
    <Link href={href} className="block">
      <Card className="h-full border-border/70 shadow-sm transition-colors hover:border-primary/40 hover:bg-accent/20">
        <CardContent className="flex items-center gap-4 p-5">
          <span
            className={cn(
              "flex size-12 shrink-0 items-center justify-center rounded-full",
              KPI_ACCENT_CLASSES[accent],
            )}
          >
            <Icon className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{label}</p>
            <p className="mt-1 text-3xl font-bold tabular-nums tracking-tight text-foreground">{value}</p>
            {sublabel ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{sublabel}</p> : null}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

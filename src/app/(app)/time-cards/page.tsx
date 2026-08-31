import type { Metadata } from "next";
import { TimeCardsWorkspace } from "@/components/time-cards/time-cards-workspace";
import type {
  TimeCardAdjustment,
  TimeCardEntry,
  TimeCardJobOption,
  TimeCardKpi,
  TimeCardView,
  TimeCardWorker,
} from "@/components/time-cards/types";
import { TIME_CARD_VIEWS } from "@/components/time-cards/types";
import { FounderDesignRoot } from "@/components/founder-design/root";
import { FounderRegion } from "@/components/founder-design/region";
import { KpiCardsLayout } from "@/components/founder-design/kpi-cards-layout";
import { TunableKpiCard } from "@/components/founder-design/tunable-kpi-card";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { requireManagementPageAccess } from "@/lib/access";
import { checkFounderAccess } from "@/lib/founder-access";
import { sanitizeFounderPageTokens } from "@/lib/founder-design";
import { formatDate, formatMoney, formatTime } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { addDays, formatISODate, parseScheduleDate, startOfDay } from "@/lib/schedule";
import {
  TIME_ACTIVITY_LABELS,
  TIME_STATUS_LABELS,
  canEditTimeEntry,
  estimateLaborCost,
  formatDateInput,
  formatDurationClock,
  formatTimeInput,
  hoursBetween,
  isTimeActivityType,
  isTimeEntryStatus,
  paidHours,
  weekRange,
} from "@/lib/time-cards";

export const metadata: Metadata = {
  title: "Time Cards",
};

function parseView(raw: string | undefined): TimeCardView {
  return (TIME_CARD_VIEWS as readonly string[]).includes(raw ?? "")
    ? (raw as TimeCardView)
    : "today";
}

function toEntryDateInput(value: Date) {
  return formatDateInput(value);
}

function toEntryTimeInput(value: Date) {
  return formatTimeInput(value);
}

function jobLabel(job: {
  customer: { name: string } | null;
  property: { addressLine1: string } | null;
}): string {
  if (job.customer?.name) return job.customer.name;
  if (job.property?.addressLine1) return job.property.addressLine1;
  return "Job";
}

export default async function TimeCardsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; date?: string; week?: string; worker?: string }>;
}) {
  const access = await requireManagementPageAccess();
  const params = await searchParams;
  const view = parseView(params.view);
  const selectedDate = startOfDay(parseScheduleDate(params.date));
  const weekAnchor = params.week ? startOfDay(parseScheduleDate(params.week)) : selectedDate;
  const { start: weekStart, end: weekEnd } = weekRange(weekAnchor);
  const dayStart = selectedDate;
  const dayEnd = addDays(dayStart, 1);
  const now = new Date();

  const founder = await checkFounderAccess();
  const founderOverride = founder
    ? await prisma.founderDesignOverride.findUnique({
        where: { userId_pageKey: { userId: founder.id, pageKey: "time-cards" } },
      })
    : null;
  const founderTokens = sanitizeFounderPageTokens("time-cards", founderOverride?.tokens ?? {});

  const [memberships, jobs, entries, weeks, adjustments] = await Promise.all([
    prisma.membership.findMany({
      where: access.scope,
      include: { user: { select: { name: true } } },
      orderBy: [{ active: "desc" }, { createdAt: "asc" }],
    }),
    prisma.job.findMany({
      where: access.scope,
      select: {
        id: true,
        assignedMembershipId: true,
        customer: { select: { name: true } },
        property: { select: { addressLine1: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    prisma.timeEntry.findMany({
      where: {
        ...access.scope,
        startedAt: { lt: weekEnd },
        OR: [{ endedAt: null }, { endedAt: { gt: weekStart } }],
      },
      include: {
        membership: { include: { user: { select: { name: true } } } },
        job: {
          select: {
            customer: { select: { name: true } },
            property: { select: { addressLine1: true } },
          },
        },
      },
      orderBy: { startedAt: "asc" },
    }),
    prisma.timesheetWeek.findMany({
      where: {
        ...access.scope,
        weekStartedAt: weekStart,
      },
    }),
    prisma.timeEntryAdjustment.findMany({
      where: {
        ...access.scope,
        timeEntry: {
          startedAt: { lt: weekEnd },
          OR: [{ endedAt: null }, { endedAt: { gt: weekStart } }],
        },
      },
      include: {
        actor: { include: { user: { select: { name: true } } } },
      },
      orderBy: { createdAt: "desc" },
      take: 80,
    }),
  ]);

  const weekByMembership = new Map(weeks.map((week) => [week.membershipId, week]));
  const jobOptions: TimeCardJobOption[] = jobs.map((job) => ({
    id: job.id,
    label: jobLabel(job),
    assignedMembershipId: job.assignedMembershipId,
  }));

  const entryDtos: TimeCardEntry[] = entries.map((entry) => {
    const activityType = isTimeActivityType(entry.activityType) ? entry.activityType : "OTHER";
    const status = isTimeEntryStatus(entry.status) ? entry.status : "READY";
    const hours = hoursBetween(entry.startedAt, entry.endedAt, now);
    return {
      id: entry.id,
      membershipId: entry.membershipId,
      workerName: entry.membership.user.name,
      workerRole: entry.membership.role,
      jobId: entry.jobId,
      jobLabel: entry.job ? jobLabel(entry.job) : null,
      activityType,
      activityLabel: TIME_ACTIVITY_LABELS[activityType],
      status,
      statusLabel: TIME_STATUS_LABELS[status],
      source: entry.source,
      startedAt: entry.startedAt.toISOString(),
      endedAt: entry.endedAt?.toISOString() ?? null,
      startedAtLabel: formatTime(entry.startedAt),
      endedAtLabel: entry.endedAt ? formatTime(entry.endedAt) : null,
      clockLabel: entry.endedAt
        ? `${formatTime(entry.startedAt)} – ${formatTime(entry.endedAt)}`
        : `${formatTime(entry.startedAt)} – Now`,
      totalHours: hours,
      totalLabel: formatDurationClock(hours),
      note: entry.note,
      startDate: toEntryDateInput(entry.startedAt),
      startTime: toEntryTimeInput(entry.startedAt),
      endDate: entry.endedAt ? toEntryDateInput(entry.endedAt) : "",
      endTime: entry.endedAt ? toEntryTimeInput(entry.endedAt) : "",
      canEdit: canEditTimeEntry(entry.status),
    };
  });

  const workers: TimeCardWorker[] = memberships.map((membership) => {
    const workerEntries = entries.filter((entry) => entry.membershipId === membership.id);
    const running = workerEntries.find((entry) => entry.status === "RUNNING");
    const week = weekByMembership.get(membership.id);
    const wage = membership.hourlyWage != null ? Number(membership.hourlyWage.toString()) : null;
    return {
      membershipId: membership.id,
      name: membership.user.name,
      role: membership.role,
      active: membership.active,
      hourlyWageLabel: wage != null ? `${formatMoney(wage)} / hr` : null,
      hourlyWageInput: wage != null ? wage.toFixed(2) : "",
      weekStatus: week?.status === "APPROVED" ? "APPROVED" : "OPEN",
      payrollReady: week?.status === "APPROVED",
      clockedIn: Boolean(running),
      currentActivityLabel: running
        ? TIME_ACTIVITY_LABELS[isTimeActivityType(running.activityType) ? running.activityType : "OTHER"]
        : null,
    };
  });

  const adjustmentDtos: TimeCardAdjustment[] = adjustments.map((item) => ({
    id: item.id,
    timeEntryId: item.timeEntryId,
    action: item.action,
    reason: item.reason,
    createdAtLabel: formatTime(item.createdAt),
    actorName: item.actor.user.name,
  }));

  const clockedNow = workers.filter((worker) => worker.clockedIn && worker.active);
  const todayEntries = entries.filter((entry) => entry.startedAt < dayEnd && (entry.endedAt == null || entry.endedAt > dayStart));
  const todayHours = todayEntries.reduce(
    (sum, entry) => sum + hoursBetween(entry.startedAt, entry.endedAt, now),
    0,
  );
  const todayJobs = new Set(todayEntries.map((entry) => entry.jobId).filter(Boolean));
  const awaiting = workers.filter((worker) => {
    const workerEntries = entries.filter((entry) => entry.membershipId === worker.membershipId);
    return (
      worker.active &&
      !worker.payrollReady &&
      workerEntries.some((entry) => entry.status === "NEEDS_REVIEW" || entry.status === "READY")
    );
  });
  const weekPaid = paidHours(
    entries.map((entry) => ({
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      activityType: entry.activityType,
    })),
    now,
  );
  let weekCost = 0;
  let hasWeekCost = false;
  for (const worker of workers) {
    const wage = worker.hourlyWageInput ? Number(worker.hourlyWageInput) : null;
    const hours = paidHours(
      entries
        .filter((entry) => entry.membershipId === worker.membershipId)
        .map((entry) => ({
          startedAt: new Date(entry.startedAt),
          endedAt: entry.endedAt,
          activityType: entry.activityType,
        })),
      now,
    );
    const cost = estimateLaborCost(hours, wage);
    if (cost != null) {
      weekCost += cost;
      hasWeekCost = true;
    }
  }

  const kpis: TimeCardKpi[] = [
    {
      label: "Clocked In Now",
      value: String(clockedNow.length),
      sublabel:
        clockedNow.length === 0
          ? "Nobody clocked in"
          : clockedNow.map((worker) => worker.name.split(" ")[0]).join(" + "),
      defaultIconId: "clock",
    },
    {
      label: "Hours Today",
      value: todayHours.toFixed(1),
      sublabel: todayJobs.size > 0 ? `Across ${todayJobs.size} job${todayJobs.size === 1 ? "" : "s"}` : "No job time yet",
      defaultIconId: "timer",
    },
    {
      label: "Awaiting Approval",
      value: String(awaiting.length),
      sublabel: awaiting.length === 1 ? "Timesheet" : "Timesheets",
      defaultIconId: "alert-triangle",
    },
    {
      label: "Week Labor Cost",
      value: hasWeekCost ? formatMoney(weekCost) : "—",
      sublabel: `${weekPaid.toFixed(1)} hours · estimate`,
      defaultIconId: "circle-dollar",
    },
  ];

  const activeWorkers = workers.filter((worker) => worker.active);
  const payrollReadyCount = activeWorkers.filter((worker) => worker.payrollReady).length;

  return (
    <PageContainer width="2xl">
      <PageHeader
        title="Time Cards"
        description="Crew time, wages, weekly hours and labor cost — all tied back to real jobs."
      />

      <FounderDesignRoot
        pageKey="time-cards"
        isFounder={Boolean(founder)}
        savedTokens={founderTokens}
        kpiCardLabels={kpis.map((kpi) => kpi.label)}
      >
        <FounderRegion id="kpi">
          <KpiCardsLayout gridClassName="grid-cols-2 lg:grid-cols-4" defaultGapPx={20}>
            {kpis.map((kpi, index) => (
              <TunableKpiCard
                key={kpi.label}
                index={index}
                label={kpi.label}
                value={kpi.value}
                sublabel={kpi.sublabel}
                defaultIconId={kpi.defaultIconId}
                variant="workspace"
                pageKey="time-cards"
              />
            ))}
          </KpiCardsLayout>
        </FounderRegion>

        <TimeCardsWorkspace
          view={view}
          date={formatISODate(selectedDate)}
          weekStartedAt={formatISODate(weekStart)}
          weekLabel={formatDate(weekStart)}
          workers={workers}
          jobs={jobOptions}
          entries={entryDtos}
          adjustments={adjustmentDtos}
          selectedMembershipId={params.worker ?? workers[0]?.membershipId ?? null}
          payrollReadyCount={payrollReadyCount}
          weekWorkerCount={activeWorkers.length}
        />
      </FounderDesignRoot>
    </PageContainer>
  );
}

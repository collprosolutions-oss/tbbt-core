import type { Metadata } from "next";
import { AvailabilityExceptionRequestForm } from "@/components/field/availability-exception-request-form";
import { FieldJobCard } from "@/components/field/field-job-card";
import { JobReassignmentRequestForm } from "@/components/field/job-reassignment-request-form";
import { FieldTimeClock } from "@/components/field/field-time-clock";
import { FieldTimeCorrectionRequests } from "@/components/field/field-time-correction-requests";
import { FIELD_JOB_SELECT, groupFieldJobs, isUpcomingFieldJob } from "@/lib/field-jobs";
import {
  NATIVE_ASSIGNED_JOB_NEUTRAL_LABEL,
  nativeAssignedJobLabel,
} from "@/lib/native-assigned-stops";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import { formatTime } from "@/lib/format";
import { addDays, formatISODate, startOfDay } from "@/lib/schedule";
import { requireFieldWorkspace } from "@/lib/field-access";
import { requireBusinessAccess } from "@/lib/access";
import { ScheduleCalendarSubscriptionPanel } from "@/components/schedule/schedule-calendar-subscription-panel";
import { loadScheduleCalendarSubscriptionStatus } from "@/lib/schedule-calendar-subscription";
import { prisma } from "@/lib/prisma";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { hasProductCapability } from "@/lib/product-entitlements";
import { calculateDailyCapacity } from "@/lib/workforce-capacity";
import { capacityJobsFromRows, loadSchedulingPolicy, loadWorkforceMembers } from "@/lib/workforce-data";
import { loadSelfAvailabilityExceptionRequests } from "@/lib/workforce-availability-request-ops";
import { loadSelfJobReassignmentRequests } from "@/lib/job-reassignment-request-ops";
import { loadAvailabilitySettings } from "@/lib/availability-data";
import {
  TIME_ACTIVITY_LABELS,
  canRequestTimeCorrection,
  formatDateInput,
  formatTimeInput,
  isTimeActivityType,
  isTimeCorrectionRequestStatus,
  weekRange,
} from "@/lib/time-cards";

export const metadata: Metadata = {
  title: "My Jobs",
};

/**
 * Field Home ("MY JOBS"). Deliberately shows ONLY Jobs assigned to the
 * authenticated member, in this one business (see requireFieldWorkspace()
 * in src/lib/field-access.ts) -- never other employees' jobs, other
 * customers, Estimates, Invoices, Services, Settings, owner Dashboard, or
 * the business-wide Schedule. There is nothing else to browse to from
 * here; every link on this page opens exactly one assigned Job.
 */
export default async function FieldHomePage() {
  const field = await requireFieldWorkspace();
  const access = await requireBusinessAccess();
  const calendarSubscription = await loadScheduleCalendarSubscriptionStatus(
    prisma,
    access,
    "assigned",
  );
  const timeZone = resolveBusinessTimeZone(field.workspace.business);

  const jobs = await prisma.job.findMany({
    where: {
      businessId: field.businessId,
      assignedMembershipId: field.membershipId,
    },
    select: FIELD_JOB_SELECT,
    orderBy: { scheduledAt: "asc" },
  });

  const groups = groupFieldJobs(jobs, startOfDay(new Date(), timeZone), timeZone);
  const [settings, policy, members] = await Promise.all([
    loadAvailabilitySettings(prisma, field.businessId),
    loadSchedulingPolicy(prisma, field.businessId),
    loadWorkforceMembers(prisma, field.businessId),
  ]);
  const self = members.find((member) => member.membershipId === field.membershipId);
  const myCapacity = calculateDailyCapacity({
    day: startOfDay(new Date(), timeZone),
    settings,
    policy,
    jobs: capacityJobsFromRows(
      jobs.map((job) => ({
        id: job.id,
        scheduledAt: job.scheduledAt,
        scheduledDurationMinutes: job.scheduledDurationMinutes,
        assignedMembershipId: field.membershipId,
        status: job.status,
      })),
    ),
    member: self,
  });
  const { start: recentStart } = weekRange(addDays(new Date(), -7, timeZone), timeZone);
  const ownEntries = await prisma.timeEntry.findMany({
    where: {
      businessId: field.businessId,
      membershipId: field.membershipId,
      endedAt: { not: null },
      startedAt: { gte: recentStart },
    },
    include: {
      job: {
        select: {
          customer: { select: { name: true } },
          property: { select: { id: true, businessId: true, addressLine1: true } },
        },
      },
      correctionRequests: {
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
    orderBy: { startedAt: "desc" },
    take: 12,
  });
  const ownWeeks = await prisma.timesheetWeek.findMany({
    where: {
      businessId: field.businessId,
      membershipId: field.membershipId,
      weekStartedAt: { gte: recentStart },
    },
    take: 12,
  });
  const canRequestAvailability =
    field.workspace.role === "MEMBER" &&
    (await hasProductCapability(
      prisma,
      field.businessId,
      PRODUCT_CAPABILITIES.TEAM_MANAGEMENT,
    ));
  const availabilityRequests = canRequestAvailability
    ? await loadSelfAvailabilityExceptionRequests(prisma, {
        businessId: field.businessId,
        membershipId: field.membershipId,
      })
    : [];
  const canRequestReassignment =
    field.workspace.role === "MEMBER" &&
    (await hasProductCapability(
      prisma,
      field.businessId,
      PRODUCT_CAPABILITIES.JOBS_TASKS,
    ));
  const reassignmentRequests = canRequestReassignment
    ? await loadSelfJobReassignmentRequests(prisma, {
        businessId: field.businessId,
        membershipId: field.membershipId,
      })
    : [];
  const upcomingRequestableJobs = groups.upcoming.filter((job) =>
    isUpcomingFieldJob(job, startOfDay(new Date(), timeZone), timeZone),
  );
  const running = await prisma.timeEntry.findFirst({
    where: {
      businessId: field.businessId,
      membershipId: field.membershipId,
      status: "RUNNING",
      endedAt: null,
    },
    include: {
      job: {
        select: {
          customer: { select: { name: true } },
          property: { select: { id: true, businessId: true, addressLine1: true } },
        },
      },
    },
    orderBy: { startedAt: "desc" },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">My Jobs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Only jobs assigned to you, {field.workspace.user.name}.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Your {formatISODate(startOfDay(new Date(), timeZone))} schedule: {myCapacity.knownScheduledMinutes} min
          known, {myCapacity.remainingMinutes} min remaining
          {myCapacity.overloaded ? " — this day looks full" : ""}. Other workers and the Fill-In Bench stay hidden.
        </p>
        <p className="mt-2 text-sm">
          <a href="/field/calendar-export/download" className="underline underline-offset-4">
            Download my assigned calendar
          </a>
        </p>
        <div className="mt-3">
          <ScheduleCalendarSubscriptionPanel
            status={calendarSubscription}
            title="Assigned calendar subscription"
            description="Optional private feed of jobs currently assigned to you. Only job IDs, statuses, and recorded windows. Reassignment or deactivation stops the feed immediately. Rotate or revoke if the URL leaks."
          />
        </div>
      </div>

      {canRequestAvailability ? (
        <AvailabilityExceptionRequestForm
          membershipId={field.membershipId}
          requests={availabilityRequests.map((request) => ({
            id: request.id,
            date: request.date,
            kind: request.kind,
            startMinutes: request.startMinutes,
            endMinutes: request.endMinutes,
            note: request.note,
            status: request.status,
          }))}
        />
      ) : null}

      {canRequestReassignment ? (
        <JobReassignmentRequestForm
          jobs={upcomingRequestableJobs.map((job) => ({
            id: job.id,
            label: nativeAssignedJobLabel(job, field.businessId, NATIVE_ASSIGNED_JOB_NEUTRAL_LABEL) ??
              NATIVE_ASSIGNED_JOB_NEUTRAL_LABEL,
          }))}
          requests={reassignmentRequests.map((request) => ({
            id: request.id,
            jobId: request.jobId,
            jobLabel: request.jobLabel,
            reason: request.reason,
            status: request.status,
          }))}
        />
      ) : null}

      <FieldTimeClock
        membershipId={field.membershipId}
        running={
          running
            ? {
                activityType: running.activityType,
                activityLabel:
                  TIME_ACTIVITY_LABELS[
                    isTimeActivityType(running.activityType) ? running.activityType : "OTHER"
                  ],
                jobLabel: nativeAssignedJobLabel(running.job, field.businessId),
                startedAtLabel: formatTime(running.startedAt, timeZone),
              }
            : null
        }
        assignedJobs={jobs.map((job) => ({
          id: job.id,
          label: nativeAssignedJobLabel(job, field.businessId, NATIVE_ASSIGNED_JOB_NEUTRAL_LABEL) ??
            NATIVE_ASSIGNED_JOB_NEUTRAL_LABEL,
        }))}
      />

      <FieldTimeCorrectionRequests
        entries={ownEntries.flatMap((entry) => {
          if (!entry.endedAt) return [];
          const week = ownWeeks.find(
            (row) =>
              row.weekStartedAt.getTime() === weekRange(entry.startedAt, timeZone).start.getTime(),
          );
          const latest = entry.correctionRequests[0];
          const requestStatus =
            latest && isTimeCorrectionRequestStatus(latest.status) ? latest.status : null;
          const gate = canRequestTimeCorrection({
            entryStatus: entry.status,
            endedAt: entry.endedAt,
            weekStatus: week?.status,
          });
          const canRequest = gate.ok && requestStatus !== "PENDING";
          return [
            {
              id: entry.id,
              activityLabel:
                TIME_ACTIVITY_LABELS[
                  isTimeActivityType(entry.activityType) ? entry.activityType : "OTHER"
                ],
              jobLabel: nativeAssignedJobLabel(entry.job, field.businessId),
              clockLabel: `${formatTime(entry.startedAt, timeZone)} – ${formatTime(entry.endedAt, timeZone)}`,
              startDate: formatDateInput(entry.startedAt, timeZone),
              startTime: formatTimeInput(entry.startedAt, timeZone),
              endDate: formatDateInput(entry.endedAt, timeZone),
              endTime: formatTimeInput(entry.endedAt, timeZone),
              canRequest,
              blockedReason: canRequest
                ? null
                : requestStatus === "PENDING"
                  ? "Waiting for the owner to accept or decline."
                  : (gate.error ?? null),
              requestStatus,
              requestReason: latest?.reason ?? null,
              proposedClockLabel: latest
                ? `${formatTime(latest.proposedStartedAt, timeZone)} – ${formatTime(latest.proposedEndedAt, timeZone)}`
                : null,
            },
          ];
        })}
      />

      <JobGroup
        title="Today"
        jobs={groups.today}
        emptyLabel="Nothing assigned for today."
        timeZone={timeZone}
        businessId={field.businessId}
      />
      <JobGroup
        title="Upcoming"
        jobs={groups.upcoming}
        emptyLabel="No upcoming jobs assigned."
        timeZone={timeZone}
        businessId={field.businessId}
      />
      <JobGroup
        title="Completed / Recent"
        jobs={groups.completed}
        emptyLabel="No completed jobs yet."
        timeZone={timeZone}
        businessId={field.businessId}
      />
    </div>
  );
}

function JobGroup({
  title,
  jobs,
  emptyLabel,
  timeZone,
  businessId,
}: {
  title: string;
  jobs: ReturnType<typeof groupFieldJobs>["today"];
  emptyLabel: string;
  timeZone: string;
  businessId: string;
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h2>
      {jobs.length === 0 ? (
        <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
          {emptyLabel}
        </p>
      ) : (
        <div className="space-y-2">
          {jobs.map((job) => (
            <FieldJobCard key={job.id} job={job} timeZone={timeZone} businessId={businessId} />
          ))}
        </div>
      )}
    </section>
  );
}

import type { Metadata } from "next";
import { FieldJobCard } from "@/components/field/field-job-card";
import { FieldTimeClock } from "@/components/field/field-time-clock";
import { FIELD_JOB_SELECT, groupFieldJobs } from "@/lib/field-jobs";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import { formatTime } from "@/lib/format";
import { formatISODate, startOfDay } from "@/lib/schedule";
import { requireFieldWorkspace } from "@/lib/field-access";
import { prisma } from "@/lib/prisma";
import { calculateDailyCapacity } from "@/lib/workforce-capacity";
import { capacityJobsFromRows, loadSchedulingPolicy, loadWorkforceMembers } from "@/lib/workforce-data";
import { loadAvailabilitySettings } from "@/lib/availability-data";
import { TIME_ACTIVITY_LABELS, isTimeActivityType } from "@/lib/time-cards";

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
          property: { select: { addressLine1: true } },
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
      </div>

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
                jobLabel: running.job?.customer?.name ?? running.job?.property?.addressLine1 ?? null,
                startedAtLabel: formatTime(running.startedAt, timeZone),
              }
            : null
        }
        assignedJobs={jobs.map((job) => ({
          id: job.id,
          label: job.customer?.name ?? job.property?.addressLine1 ?? "Assigned job",
        }))}
      />

      <JobGroup title="Today" jobs={groups.today} emptyLabel="Nothing assigned for today." timeZone={timeZone} />
      <JobGroup title="Upcoming" jobs={groups.upcoming} emptyLabel="No upcoming jobs assigned." timeZone={timeZone} />
      <JobGroup
        title="Completed / Recent"
        jobs={groups.completed}
        emptyLabel="No completed jobs yet."
        timeZone={timeZone}
      />
    </div>
  );
}

function JobGroup({
  title,
  jobs,
  emptyLabel,
  timeZone,
}: {
  title: string;
  jobs: ReturnType<typeof groupFieldJobs>["today"];
  emptyLabel: string;
  timeZone: string;
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
            <FieldJobCard key={job.id} job={job} timeZone={timeZone} />
          ))}
        </div>
      )}
    </section>
  );
}

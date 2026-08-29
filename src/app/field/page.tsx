import type { Metadata } from "next";
import { FieldJobCard } from "@/components/field/field-job-card";
import { FIELD_JOB_SELECT, groupFieldJobs } from "@/lib/field-jobs";
import { startOfDay } from "@/lib/schedule";
import { requireFieldWorkspace } from "@/lib/field-access";
import { prisma } from "@/lib/prisma";

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

  const jobs = await prisma.job.findMany({
    where: {
      businessId: field.businessId,
      assignedMembershipId: field.membershipId,
    },
    select: FIELD_JOB_SELECT,
    orderBy: { scheduledAt: "asc" },
  });

  const groups = groupFieldJobs(jobs, startOfDay(new Date()));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">My Jobs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Only jobs assigned to you, {field.workspace.user.name}.
        </p>
      </div>

      <JobGroup title="Today" jobs={groups.today} emptyLabel="Nothing assigned for today." />
      <JobGroup title="Upcoming" jobs={groups.upcoming} emptyLabel="No upcoming jobs assigned." />
      <JobGroup
        title="Completed / Recent"
        jobs={groups.completed}
        emptyLabel="No completed jobs yet."
      />
    </div>
  );
}

function JobGroup({
  title,
  jobs,
  emptyLabel,
}: {
  title: string;
  jobs: ReturnType<typeof groupFieldJobs>["today"];
  emptyLabel: string;
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
            <FieldJobCard key={job.id} job={job} />
          ))}
        </div>
      )}
    </section>
  );
}

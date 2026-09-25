import Link from "next/link";
import { AssignJobMemberForm, type EligibleMember } from "@/components/jobs/assign-job-member-form";
import { CopyProjectLinkButton } from "@/components/jobs/copy-project-link-button";
import { StartJobButton } from "@/components/jobs/start-job-button";
import { StatusBadge } from "@/components/status-badge";
import { CopyDirectionsLinkButton } from "@/components/today/copy-directions-link-button";
import { Button } from "@/components/ui/button";
import type { OwnerTodayJobView } from "@/lib/owner-today";

export function OwnerTodayJobCard({
  job,
  eligibleMembers = [],
  showAssign = false,
  showStart = false,
}: {
  job: OwnerTodayJobView;
  eligibleMembers?: EligibleMember[];
  showAssign?: boolean;
  showStart?: boolean;
}) {
  return (
    <article className="rounded-xl border border-border/80 bg-card p-3.5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="truncate text-base font-semibold">{job.customerName}</p>
          {job.timeWindowLabel ? (
            <p className="text-sm tabular-nums text-muted-foreground">{job.timeWindowLabel}</p>
          ) : null}
          {job.address ? (
            <p className="text-sm text-muted-foreground">{job.address}</p>
          ) : null}
        </div>
        <StatusBadge status={job.status} />
      </div>

      <dl className="mt-3 grid gap-1.5 text-sm">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <dt className="text-muted-foreground">Assignment</dt>
          <dd className="font-medium">
            {job.assignment.kind === "UNASSIGNED" ? "Unassigned today" : job.assignment.label}
          </dd>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <dt className="text-muted-foreground">Appointment</dt>
          <dd className="font-medium">{job.appointment.label}</dd>
        </div>
        {job.materialPickupRecorded ? (
          <div className="flex flex-wrap items-baseline gap-x-2">
            <dt className="text-muted-foreground">Materials</dt>
            <dd className="font-medium">Pickup recorded</dd>
          </div>
        ) : null}
      </dl>

      {job.appointment.customerNote ? (
        <p className="mt-2 text-sm">Customer note: “{job.appointment.customerNote}”</p>
      ) : null}
      {job.appointment.notificationMessage ? (
        <p className="mt-2 text-sm text-amber-800 dark:text-amber-300">
          {job.appointment.notificationMessage}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button asChild size="sm">
          <Link href={job.jobHref}>Open job</Link>
        </Button>
        {job.customerHref ? (
          <Button asChild size="sm" variant="outline">
            <Link href={job.customerHref}>Open customer</Link>
          </Button>
        ) : null}
        {job.fieldHref ? (
          <Button asChild size="sm" variant="outline">
            <Link href={job.fieldHref}>Open field view</Link>
          </Button>
        ) : null}
        <CopyProjectLinkButton projectToken={job.projectToken} label="Copy portal link" />
        {job.directionsHref ? (
          <CopyDirectionsLinkButton href={job.directionsHref} />
        ) : null}
        {showStart && job.canStart && !job.appointmentConfirmed ? (
          <Button asChild size="sm" variant="outline">
            <Link href={job.jobHref}>Start on work order</Link>
          </Button>
        ) : null}
      </div>

      {showStart && job.canStart && job.appointmentConfirmed ? (
        <div className="mt-3">
          <StartJobButton jobId={job.jobId} appointmentConfirmed />
        </div>
      ) : null}

      {showAssign && job.assignment.kind === "UNASSIGNED" && eligibleMembers.length > 0 ? (
        <div className="mt-3 border-t border-border/70 pt-3">
          <AssignJobMemberForm
            jobId={job.jobId}
            eligibleMembers={eligibleMembers}
            assignedMembershipId={null}
          />
        </div>
      ) : null}
    </article>
  );
}

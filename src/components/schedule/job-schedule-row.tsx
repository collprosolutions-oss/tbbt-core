import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { formatAddress, formatTime } from "@/lib/format";
import { jobScopeSummary, type ScheduleJob } from "@/lib/schedule";

/**
 * Full-width row for Week / Day / Crew views: enough to identify the job
 * without opening it, per the MONTH VIEW / WEEK VIEW / DAY VIEW spec.
 * Clicking anywhere on the row opens the existing Job / Work Order.
 */
export function JobScheduleRow({
  job,
  hasConflict,
}: {
  job: ScheduleJob;
  hasConflict?: boolean;
}) {
  const scope = jobScopeSummary(job);
  return (
    <Link
      href={`/jobs/${job.id}`}
      className="block rounded-lg border bg-background p-3 text-sm transition-colors hover:bg-muted/40"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <p className="truncate font-medium">
            {job.customer?.name ?? "Customer"}
          </p>
          {job.property ? (
            <p className="truncate text-xs text-muted-foreground">
              {formatAddress(job.property)}
            </p>
          ) : null}
          {scope ? (
            <p className="truncate text-xs text-muted-foreground">{scope}</p>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-1 text-right">
          {job.scheduledAt ? (
            <span className="text-xs font-semibold">
              {formatTime(job.scheduledAt)}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">No time set</span>
          )}
          <StatusBadge status={job.status} />
        </div>
      </div>
      {hasConflict ? (
        <p className="mt-2 flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400">
          <AlertTriangle className="size-3" />
          Possible scheduling conflict
        </p>
      ) : null}
    </Link>
  );
}

import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { formatTime } from "@/lib/format";
import type { ScheduleJob } from "@/lib/schedule";
import { cn } from "@/lib/utils";

const STATUS_PILL_CLASSES: Record<string, string> = {
  SCHEDULED: "bg-primary/10 text-primary",
  IN_PROGRESS: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100",
  COMPLETED: "bg-muted text-muted-foreground",
  UNSCHEDULED: "bg-muted text-muted-foreground",
};

/**
 * Compact Month-cell entry -- per the MONTH VIEW spec, just enough to
 * identify the job (customer, time if known, status color), never the full
 * Work Order. Clicking it opens the existing Job / Work Order directly.
 */
export function JobPill({
  job,
  hasConflict,
}: {
  job: ScheduleJob;
  hasConflict?: boolean;
}) {
  return (
    <Link
      href={`/jobs/${job.id}`}
      title={`${job.customer?.name ?? "Customer"} · ${job.status}${hasConflict ? " · Possible scheduling conflict" : ""}`}
      className={cn(
        "flex items-center gap-1 overflow-hidden rounded px-1 py-0.5 text-[10px] font-medium sm:text-[11px]",
        STATUS_PILL_CLASSES[job.status] ?? "bg-muted text-foreground",
      )}
    >
      {hasConflict ? (
        <AlertTriangle className="size-2.5 shrink-0 text-amber-600 dark:text-amber-400" />
      ) : null}
      {job.scheduledAt ? (
        <span className="shrink-0 tabular-nums">
          {formatTime(job.scheduledAt)}
        </span>
      ) : null}
      <span className="truncate">{job.customer?.name ?? "Customer"}</span>
    </Link>
  );
}

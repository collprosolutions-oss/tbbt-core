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
  timeZone,
}: {
  job: ScheduleJob;
  hasConflict?: boolean;
  timeZone?: string;
}) {
  const customerName = job.customer?.name ?? "Customer";
  const assignedName = job.assignedMembership?.user.name.trim() ?? "";
  const assignmentLabel = assignedName ? `Assigned: ${assignedName}` : "Unassigned";
  const title = `${customerName} · ${job.status} · ${assignmentLabel}${hasConflict ? " · Possible scheduling conflict" : ""}`;
  return (
    <Link
      href={`/jobs/${job.id}`}
      title={title}
      aria-label={title}
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
          {formatTime(job.scheduledAt, timeZone)}
        </span>
      ) : null}
      <span className="min-w-0 truncate">{customerName}</span>
      <span className="min-w-0 max-w-[46%] truncate font-normal opacity-80">
        {assignedName || "Unassigned"}
      </span>
    </Link>
  );
}

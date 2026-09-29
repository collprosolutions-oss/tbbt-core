import { formatDateTime } from "@/lib/format";
import type { CustomerJobMilestone } from "@/lib/job-milestones";
import { StatusBadge } from "@/components/status-badge";

/**
 * Customer-visible OWNER milestones only. The caller must already filter
 * to customerVisible rows for the token-scoped Job. This list never
 * decides visibility and never infers completion from Job/Invoice status.
 */
export function ProjectMilestonesList({
  milestones,
}: {
  milestones: CustomerJobMilestone[];
}) {
  if (milestones.length === 0) {
    return null;
  }

  return (
    <ol className="space-y-3">
      {milestones.map((milestone, index) => (
        <li key={milestone.id} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">
            {index + 1}. {milestone.title}
          </span>
          <StatusBadge status={milestone.status} />
          {milestone.completedAt ? (
            <span className="text-muted-foreground">
              Completed {formatDateTime(milestone.completedAt)}
            </span>
          ) : (
            <span className="text-muted-foreground">In progress</span>
          )}
        </li>
      ))}
    </ol>
  );
}

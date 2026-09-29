import { formatDateTime } from "@/lib/format";
import type { CustomerJobMilestone } from "@/lib/job-milestones";

/**
 * Customer-visible OWNER milestones only. The caller must already filter
 * to customerVisible rows for the token-scoped Job. This list never
 * decides visibility and never infers completion from Job/Invoice status.
 * A cancelled Job still shows the same OWNER-exposed OPEN/COMPLETED labels.
 */
export function ProjectMilestonesList({
  milestones,
  timeZone,
}: {
  milestones: CustomerJobMilestone[];
  timeZone: string;
}) {
  if (milestones.length === 0) {
    return null;
  }

  return (
    <ol className="space-y-3">
      {milestones.map((milestone, index) => (
        <li
          key={`${milestone.sortOrder}-${index}`}
          className="flex flex-wrap items-center gap-2 text-sm"
        >
          <span className="font-medium">
            {index + 1}. {milestone.title}
          </span>
          <span>{milestone.statusLabel}</span>
          {milestone.completedAt ? (
            <span className="text-muted-foreground">
              {formatDateTime(milestone.completedAt, timeZone)}
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

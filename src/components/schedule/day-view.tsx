import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { JobScheduleRow } from "@/components/schedule/job-schedule-row";
import type { ScheduleJob } from "@/lib/schedule";

/**
 * Focused day view: this day's scheduled Jobs in chronological order
 * (jobs is already ordered by scheduledAt asc by the caller's query).
 */
export function DayView({
  jobs,
  conflicts,
  isToday,
}: {
  jobs: ScheduleJob[];
  conflicts: Map<string, ScheduleJob[]>;
  isToday: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{isToday ? "Today's jobs" : "Jobs this day"}</CardTitle>
        <CardDescription>
          {jobs.length === 0
            ? isToday
              ? "No jobs are scheduled today."
              : "No jobs are scheduled on this day."
            : `${jobs.length} job${jobs.length === 1 ? "" : "s"} in chronological order.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing to show for this day.
          </p>
        ) : (
          jobs.map((job) => (
            <JobScheduleRow
              key={job.id}
              job={job}
              hasConflict={conflicts.has(job.id)}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}

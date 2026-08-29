import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
 * Crew view, deliberately built only to the extent current real data
 * supports it (see the CREW VIEW section of the Phase 3 / Step 3 spec):
 * Job has no employee/crew assignment field yet, so every scheduled or
 * in-progress Job here is truthfully "Unassigned" -- this is a real,
 * structural state, not an invented one.
 *
 * WHAT ACTIVATES LATER: once the (not-yet-built) Employee Field Workflow
 * adds a real assignment relation to Job, this view is the seam where a
 * per-employee grouping replaces the single "Unassigned" bucket below --
 * no calendar rework needed, just swapping this bucket for a real one.
 */
export function CrewView({
  jobs,
  monthLabel,
}: {
  jobs: ScheduleJob[];
  monthLabel: string;
}) {
  return (
    <div className="space-y-4">
      <Alert>
        <AlertTitle>Crew assignment isn&apos;t built yet</AlertTitle>
        <AlertDescription>
          Employee Field Workflow (a future build step) will add real
          crew/employee assignment to Jobs. Until then, every scheduled or
          in-progress Job shows as Unassigned below — that reflects that no
          assignment field exists yet, not a guess.
        </AlertDescription>
      </Alert>
      <Card>
        <CardHeader>
          <CardTitle>Unassigned — {monthLabel}</CardTitle>
          <CardDescription>
            Every scheduled or in-progress Job this month, since none can be
            assigned to a crew yet.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No scheduled or in-progress jobs this month.
            </p>
          ) : (
            jobs.map((job) => <JobScheduleRow key={job.id} job={job} />)
          )}
        </CardContent>
      </Card>
    </div>
  );
}

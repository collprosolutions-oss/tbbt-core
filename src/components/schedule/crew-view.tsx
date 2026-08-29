import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { JobScheduleRow } from "@/components/schedule/job-schedule-row";
import { groupJobsByAssignedMember, type ScheduleJob } from "@/lib/schedule";

/**
 * Crew view, now grouped by the real Job assignment relationship (Phase 3 /
 * Step 4 Employee Field Workflow -- see Job.assignedMembershipId in
 * prisma/schema.prisma and groupJobsByAssignedMember() in
 * src/lib/schedule.ts). Assignment supports exactly ONE member per Job
 * today, so each group below is one member's real scheduled/in-progress
 * Jobs; anything with no assignment shows separately under Unassigned --
 * still a real, structural state (existing Jobs remain valid and
 * Unassigned), not a placeholder.
 *
 * This intentionally does not add crew/team management (schedules,
 * capacity, availability) -- it only visualizes the assignment Jobs
 * already carry.
 */
export function CrewView({
  jobs,
  monthLabel,
}: {
  jobs: ScheduleJob[];
  monthLabel: string;
}) {
  const groups = groupJobsByAssignedMember(jobs);

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <Card key={group.member?.id ?? "unassigned"}>
          <CardHeader>
            <CardTitle>
              {group.member ? group.member.name : "Unassigned"} —{" "}
              {monthLabel}
            </CardTitle>
            <CardDescription>
              {group.member
                ? `Scheduled or in-progress jobs assigned to ${group.member.name} this month.`
                : "Scheduled or in-progress jobs with no assigned field employee yet."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {group.jobs.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No scheduled or in-progress jobs this month.
              </p>
            ) : (
              group.jobs.map((job) => <JobScheduleRow key={job.id} job={job} />)
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScheduleJobForm } from "@/components/jobs/schedule-job-form";
import { formatAddress } from "@/lib/format";

export type UnscheduledJobLite = {
  id: string;
  customer: { name: string } | null;
  property: {
    addressLine1: string;
    addressLine2: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
  } | null;
};

/**
 * The one place OWNER/ADMIN can see, and act on, Jobs that still need
 * scheduling -- across every calendar view (see the UNSCHEDULED JOBS
 * section of the spec). Reuses the exact same ScheduleJobForm + scheduleJob
 * server action the Job / Work Order page already uses -- no duplicated
 * scheduling logic.
 */
export function UnscheduledJobsPanel({
  jobs,
  totalCount,
}: {
  jobs: UnscheduledJobLite[];
  totalCount: number;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Unscheduled Jobs</CardTitle>
        <CardDescription>
          Jobs waiting for a first appointment. Schedule right here, or open
          the full Work Order.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No unscheduled jobs right now.
          </p>
        ) : (
          <>
            {jobs.map((job) => (
              <div key={job.id} className="space-y-3 rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {job.customer?.name ?? "Customer"}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {job.property
                        ? formatAddress(job.property)
                        : "No service address"}
                    </p>
                  </div>
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/jobs/${job.id}`}>Open Work Order</Link>
                  </Button>
                </div>
                <ScheduleJobForm
                  jobId={job.id}
                  date=""
                  time=""
                  durationPreset=""
                  customHours=""
                  isScheduled={false}
                />
              </div>
            ))}
            {totalCount > jobs.length ? (
              <p className="text-xs text-muted-foreground">
                Showing {jobs.length} of {totalCount} unscheduled jobs.{" "}
                <Link
                  href="/jobs?view=list"
                  className="underline underline-offset-4"
                >
                  See all in List view
                </Link>
                .
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

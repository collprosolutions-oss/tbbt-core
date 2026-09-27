import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  jobPropertyExportPickerTruncationMessage,
  type ExportableCompletedJobProperty,
} from "@/lib/job-property-export";

export function JobPropertyExportPicker({
  jobs,
  truncated,
  limit,
}: {
  jobs: ExportableCompletedJobProperty[];
  truncated: boolean;
  limit: number;
}) {
  if (jobs.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No completed job/property pairs</CardTitle>
          <CardDescription>
            Only same-business completed jobs that already have a recorded property can be
            exported. This picker does not invent jobs or properties.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Select a completed job</CardTitle>
        <CardDescription>
          Each row is a recorded completed job and its same-business property. The download stays
          redacted unless you expressly authorize private customer data or photos.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {truncated ? (
          <p className="text-sm text-muted-foreground">{jobPropertyExportPickerTruncationMessage(limit)}</p>
        ) : null}
        <ul className="divide-y">
          {jobs.map((job) => (
            <li key={job.jobId} className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0">
              <div className="text-sm">
                <p className="font-medium">{job.propertyLabel || "Recorded property"}</p>
                <p className="text-muted-foreground">
                  {[job.city, job.region].filter(Boolean).join(", ") || "Location not recorded"}
                </p>
              </div>
              <Link
                href={`/jobs/${job.jobId}/handoff-export`}
                className="text-sm underline underline-offset-4"
              >
                Review and export
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

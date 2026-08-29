"use client";

import { useActionState } from "react";
import {
  resolveJobProblemReport,
  type JobProblemReportActionState,
} from "@/app/actions/job-problem-report";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { formatDateTime } from "@/lib/format";

export type JobProblemReportItem = {
  id: string;
  description: string;
  status: string;
  createdAt: Date;
  membership: { user: { name: string } };
};

const initialState: JobProblemReportActionState = {};

/**
 * Read-only-except-resolve list on the internal Work Order: factual field
 * issues the assigned MEMBER reported against this Job (see
 * reportJobProblem in src/app/actions/field-job.ts). Never affects Job
 * status, approved scope, price, or the Invoice -- resolving one only
 * changes its own status.
 */
export function JobProblemReportList({
  reports,
}: {
  reports: JobProblemReportItem[];
}) {
  if (reports.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No field reports yet.</p>
    );
  }

  return (
    <ul className="space-y-3">
      {reports.map((report) => (
        <ReportRow key={report.id} report={report} />
      ))}
    </ul>
  );
}

function ReportRow({ report }: { report: JobProblemReportItem }) {
  const [state, formAction, pending] = useActionState(
    resolveJobProblemReport,
    initialState,
  );

  return (
    <li className="space-y-2 rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={report.status} />
        <span className="text-xs text-muted-foreground">
          Reported by {report.membership.user.name} ·{" "}
          {formatDateTime(report.createdAt)}
        </span>
      </div>
      <p className="whitespace-pre-wrap">{report.description}</p>
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {report.status === "OPEN" ? (
        <form action={formAction}>
          <input type="hidden" name="reportId" value={report.id} />
          <Button type="submit" size="sm" variant="outline" disabled={pending}>
            {pending ? "Saving…" : "Mark Resolved"}
          </Button>
        </form>
      ) : null}
    </li>
  );
}

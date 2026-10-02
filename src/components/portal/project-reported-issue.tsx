import { formatDateTime } from "@/lib/format";
import {
  JOB_CUSTOMER_ISSUE_PORTAL_CLOSED_MESSAGE,
  JOB_CUSTOMER_ISSUE_PORTAL_HEADING,
  JOB_CUSTOMER_ISSUE_PORTAL_RECEIVED_MESSAGE,
} from "@/lib/job-customer-issue";
import type { CustomerVisibleIssue } from "@/lib/job-customer-issue";

/**
 * Customer-visible issue status only. The caller must already load by
 * project token. This component never receives owner notes, decisions,
 * storage keys, or other jobs.
 */
export function ProjectReportedIssue({
  issue,
  timeZone,
}: {
  issue: CustomerVisibleIssue;
  timeZone: string;
}) {
  const closed = issue.customerVisibleStatus === "CLOSED";
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{JOB_CUSTOMER_ISSUE_PORTAL_HEADING}</p>
      <p className="text-xs text-muted-foreground">
        {issue.customerVisibleStatusLabel} · {issue.categoryLabel}
      </p>
      <p className="whitespace-pre-wrap text-sm">{issue.description}</p>
      {issue.attachments.length > 0 ? (
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          {issue.attachments.map((attachment) => (
            <li key={attachment.originalFilename}>{attachment.originalFilename}</li>
          ))}
        </ul>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Reported {formatDateTime(issue.recordedAt, timeZone)}
      </p>
      <p className="text-sm">
        {closed
          ? JOB_CUSTOMER_ISSUE_PORTAL_CLOSED_MESSAGE
          : JOB_CUSTOMER_ISSUE_PORTAL_RECEIVED_MESSAGE}
      </p>
    </div>
  );
}

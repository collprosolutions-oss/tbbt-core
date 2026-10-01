import { formatDateTime } from "@/lib/format";
import {
  JOB_AFTERCARE_PORTAL_DESCRIPTION,
  JOB_AFTERCARE_PORTAL_HEADING,
} from "@/lib/job-aftercare";
import type { CustomerPublishedAftercare } from "@/lib/job-aftercare";

/**
 * Published aftercare only. The caller must already load by project token
 * and filter to PUBLISHED. This component never receives drafts or owner notes.
 */
export function ProjectAftercare({
  aftercare,
  timeZone,
}: {
  aftercare: CustomerPublishedAftercare;
  timeZone: string;
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{JOB_AFTERCARE_PORTAL_HEADING}</p>
      <p className="text-xs text-muted-foreground">{JOB_AFTERCARE_PORTAL_DESCRIPTION}</p>
      <p className="whitespace-pre-wrap text-sm">{aftercare.instructions}</p>
      {aftercare.publishedAt ? (
        <p className="text-xs text-muted-foreground">
          Published {formatDateTime(aftercare.publishedAt, timeZone)}
        </p>
      ) : null}
    </div>
  );
}

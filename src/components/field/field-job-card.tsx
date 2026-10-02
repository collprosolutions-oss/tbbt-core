import Link from "next/link";
import { StatusBadge } from "@/components/status-badge";
import { formatDateTime } from "@/lib/format";
import type { FieldJob } from "@/lib/field-jobs";
import { nativeAssignedJobDisplayAddress } from "@/lib/native-assigned-stops";

/**
 * Large-tap-target Field Home list row. Links straight to the Field Job
 * page for that assigned job -- no separate "view details" step.
 */
export function FieldJobCard({
  job,
  timeZone,
  businessId,
}: {
  job: FieldJob;
  timeZone: string;
  businessId: string;
}) {
  const address = nativeAssignedJobDisplayAddress(job.property, businessId);
  return (
    <Link
      href={`/field/jobs/${job.id}`}
      className="block rounded-xl border bg-background p-4 shadow-sm transition-colors active:bg-muted/60"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="truncate text-base font-semibold">
            {job.customer?.name ?? "Customer"}
          </p>
          {address ? (
            <p className="truncate text-sm text-muted-foreground">{address}</p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            {job.scheduledAt
              ? formatDateTime(job.scheduledAt, timeZone)
              : "Not yet scheduled"}
          </p>
        </div>
        <StatusBadge status={job.status} />
      </div>
    </Link>
  );
}

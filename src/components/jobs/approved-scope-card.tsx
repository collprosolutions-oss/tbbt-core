import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatMoney } from "@/lib/format";
import type { ApprovedWorkOrderScope } from "@/lib/job-work-order";

/**
 * Shared, read-only "approved scope" display used by BOTH the internal
 * owner/admin Work Order page (src/app/(app)/jobs/[jobId]/page.tsx) and the
 * Customer Project Portal (src/app/p/[token]/page.tsx). Only ever shows
 * description/quantity/unit price/line total and the approved grand total --
 * the same subset of fields already shown to the customer on the public
 * estimate page -- never internal notes, margins, or cost basis.
 */
export function ApprovedScopeCard({
  scope,
  title = "Approved Scope",
}: {
  scope: ApprovedWorkOrderScope;
  title?: string;
}) {
  if (scope.source === "none") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>
            No approved estimate is linked to this job yet.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>
          {scope.source === "version"
            ? `Exactly what was approved (Estimate Version ${scope.versionNumber}). This never changes, even if the estimate is edited later.`
            : "From this job's linked estimate. This job was created before per-version approval tracking existed."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {scope.lineItems.length === 0 ? (
          <p className="text-muted-foreground">No line items.</p>
        ) : (
          <ul className="space-y-2">
            {scope.lineItems.map((item, index) => (
              <li key={index} className="flex justify-between gap-3">
                <span className="min-w-0 flex-1 break-words">
                  {item.description} × {item.quantity.toString()} @{" "}
                  {formatMoney(item.unitPrice)}
                </span>
                <span className="shrink-0">{formatMoney(item.total)}</span>
              </li>
            ))}
          </ul>
        )}
        {scope.source === "version" && scope.laborMinimumAdjustment.gt(0) ? (
          <p>
            Labor Minimum Service Fee Adjustment —{" "}
            {formatMoney(scope.laborMinimumAdjustment)}
          </p>
        ) : null}
        <p className="font-medium">
          Approved total: {formatMoney(scope.total)}
        </p>
      </CardContent>
    </Card>
  );
}

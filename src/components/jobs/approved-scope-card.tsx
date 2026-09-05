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
 * Shared, read-only "approved scope" display used by the internal
 * owner/admin Work Order page (src/app/(app)/jobs/[jobId]/page.tsx), the
 * Customer Project Portal (src/app/p/[token]/page.tsx), AND the assigned
 * MEMBER's Field Job page (src/app/field/jobs/[jobId]/page.tsx). By
 * default it shows description/quantity/unit price/line total and the
 * approved grand total -- the same subset of fields already shown to the
 * customer on the public estimate page -- never internal notes, margins,
 * or cost basis.
 *
 * `hideFinancials` is the ONE field-worker-privacy exception: the Field
 * Job page passes it `true` so a MEMBER sees exactly the operational
 * scope (what work was approved, and how much of it) with NO customer
 * pricing or owner financial intelligence -- no unit price, no line
 * total, no Labor Minimum Service Fee Adjustment (purely financial, no
 * operational meaning), and no approved total. This only controls what
 * gets RENDERED (never CSS-hidden): the owner/admin Work Order page and
 * the Customer Project Portal never pass this prop, so their financial
 * display is completely unchanged.
 */
export function ApprovedScopeCard({
  scope,
  title = "Approved Scope",
  hideFinancials = false,
  scanColumns = false,
}: {
  scope: ApprovedWorkOrderScope;
  title?: string;
  /** MEMBER field-safe mode -- see the component doc comment above. */
  hideFinancials?: boolean;
  /**
   * Presentation-only: on md+ screens, show description / quantity /
   * unit price / total in columns. Does not change which fields exist
   * or which history is shown. The Customer Project Portal opts in;
   * Work Order and Field Job keep the original stacked rows.
   */
  scanColumns?: boolean;
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
        ) : scanColumns && !hideFinancials ? (
          <div className="space-y-2">
            <div className="hidden text-xs font-medium text-muted-foreground md:grid md:grid-cols-[minmax(0,1fr)_5rem_6.5rem_6rem] md:gap-3">
              <span>Service</span>
              <span className="md:text-right">Qty</span>
              <span className="md:text-right">Unit price</span>
              <span className="md:text-right">Total</span>
            </div>
            <ul className="space-y-2">
              {scope.lineItems.map((item, index) => (
                <li
                  key={index}
                  className="flex justify-between gap-3 md:grid md:grid-cols-[minmax(0,1fr)_5rem_6.5rem_6rem] md:items-baseline"
                >
                  <span className="min-w-0 flex-1 break-words md:flex-none">
                    <span>{item.description}</span>
                    <span className="md:hidden">
                      {" "}
                      × {item.quantity.toString()} @ {formatMoney(item.unitPrice)}
                    </span>
                  </span>
                  <span className="hidden md:block md:text-right">
                    {item.quantity.toString()}
                  </span>
                  <span className="hidden md:block md:text-right">
                    {formatMoney(item.unitPrice)}
                  </span>
                  <span className="shrink-0 md:text-right">
                    {formatMoney(item.total)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <ul className="space-y-2">
            {scope.lineItems.map((item, index) => (
              <li key={index} className="flex justify-between gap-3">
                <span className="min-w-0 flex-1 break-words">
                  {item.description} × {item.quantity.toString()}
                  {hideFinancials ? null : (
                    <> @ {formatMoney(item.unitPrice)}</>
                  )}
                </span>
                {hideFinancials ? null : (
                  <span className="shrink-0">{formatMoney(item.total)}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {!hideFinancials &&
        scope.source === "version" &&
        scope.laborMinimumAdjustment.gt(0) ? (
          <p>
            Labor Minimum Service Fee Adjustment —{" "}
            {formatMoney(scope.laborMinimumAdjustment)}
          </p>
        ) : null}
        {hideFinancials ? null : (
          <p className="font-medium">
            Approved total: {formatMoney(scope.total)}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

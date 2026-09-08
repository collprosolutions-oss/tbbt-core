import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { IncludedWorkDisplay } from "@/components/estimates/included-work-display";
import { ESTIMATE_LABOR_SECTION_TITLE, ESTIMATE_MATERIALS_SECTION_TITLE, ESTIMATE_OTHER_SECTION_TITLE } from "@/lib/estimate-document";
import { resolveCustomerMaterialsTotal } from "@/lib/customer-materials-total";
import { lineItemTitle } from "@/lib/estimate-line-scope";
import { formatMoney } from "@/lib/format";
import type { ApprovedWorkOrderScope, WorkOrderLineItem } from "@/lib/job-work-order";

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
 *
 * `hideMaterialLinePricing` is the customer-document privacy exception
 * used only by the Project Portal: MATERIAL rows render Description |
 * Qty, plus one approved Materials lump-sum total. LABOR (and OTHER)
 * pricing stays visible. Owner Work Order and Field Job never pass it.
 */
export function ApprovedScopeCard({
  scope,
  title = "Approved Scope",
  hideFinancials = false,
  scanColumns = false,
  hideMaterialLinePricing = false,
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
  /** Customer portal only: hide per-item MATERIAL prices. */
  hideMaterialLinePricing?: boolean;
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

  const hideMaterialPrices = hideMaterialLinePricing && !hideFinancials;
  const laborItems = scope.lineItems.filter((item) => item.type === "LABOR");
  const materialItems = scope.lineItems.filter((item) => item.type === "MATERIAL");
  const otherItems = scope.lineItems.filter(
    (item) => item.type !== "LABOR" && item.type !== "MATERIAL",
  );
  const materialsTotal = resolveCustomerMaterialsTotal(materialItems).amount;

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
        ) : hideMaterialPrices ? (
          <div className="space-y-6">
            {laborItems.length > 0 ? (
              <section>
                <h3 className="text-xs font-semibold tracking-wider text-muted-foreground">
                  {ESTIMATE_LABOR_SECTION_TITLE}
                </h3>
                <PricedLineList items={laborItems} scanColumns={scanColumns} />
              </section>
            ) : null}
            {materialItems.length > 0 ? (
              <section className={laborItems.length > 0 ? "border-t-2 border-border pt-6" : undefined}>
                <h3 className="text-xs font-semibold tracking-wider text-muted-foreground">
                  {ESTIMATE_MATERIALS_SECTION_TITLE}
                </h3>
                <CompactMaterialList items={materialItems} />
                <p className="mt-2 flex justify-between gap-3 font-medium">
                  <span>Materials</span>
                  <span className="tabular-nums">{formatMoney(materialsTotal)}</span>
                </p>
              </section>
            ) : null}
            {otherItems.length > 0 ? (
              <section
                className={
                  laborItems.length > 0 || materialItems.length > 0
                    ? "border-t-2 border-border pt-6"
                    : undefined
                }
              >
                <h3 className="text-xs font-semibold tracking-wider text-muted-foreground">
                  {ESTIMATE_OTHER_SECTION_TITLE}
                </h3>
                <PricedLineList items={otherItems} scanColumns={scanColumns} />
              </section>
            ) : null}
          </div>
        ) : scanColumns && !hideFinancials ? (
          <PricedLineList items={scope.lineItems} scanColumns />
        ) : (
          <ul className="space-y-2">
            {scope.lineItems.map((item, index) => (
              <li key={index} className="space-y-1">
                <div className="flex justify-between gap-3">
                  <span className="min-w-0 flex-1 break-words">
                    {lineItemTitle(item.description)} × {item.quantity.toString()}
                    {hideFinancials ? null : (
                      <> @ {formatMoney(item.unitPrice)}</>
                    )}
                  </span>
                  {hideFinancials ? null : (
                    <span className="shrink-0">{formatMoney(item.total)}</span>
                  )}
                </div>
                <IncludedWorkDisplay description={item.description} />
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

function PricedLineList({
  items,
  scanColumns,
}: {
  items: WorkOrderLineItem[];
  scanColumns: boolean;
}) {
  if (!scanColumns) {
    return (
      <ul className="mt-2 space-y-2">
        {items.map((item, index) => (
          <li key={index} className="space-y-1">
            <div className="flex justify-between gap-3">
              <span className="min-w-0 flex-1 break-words">
                {lineItemTitle(item.description)} × {item.quantity.toString()} @{" "}
                {formatMoney(item.unitPrice)}
              </span>
              <span className="shrink-0">{formatMoney(item.total)}</span>
            </div>
            <IncludedWorkDisplay description={item.description} />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="mt-2 space-y-2">
      <div className="hidden text-xs font-medium text-muted-foreground md:grid md:grid-cols-[minmax(0,1fr)_5rem_6.5rem_6rem] md:gap-3">
        <span>Service</span>
        <span className="md:text-right">Qty</span>
        <span className="md:text-right">Unit price</span>
        <span className="md:text-right">Total</span>
      </div>
      <ul className="space-y-2">
        {items.map((item, index) => (
          <li
            key={index}
            className="flex justify-between gap-3 md:grid md:grid-cols-[minmax(0,1fr)_5rem_6.5rem_6rem] md:items-baseline"
          >
            <span className="min-w-0 flex-1 break-words md:flex-none">
              <span>{lineItemTitle(item.description)}</span>
              <span className="md:hidden">
                {" "}
                × {item.quantity.toString()} @ {formatMoney(item.unitPrice)}
              </span>
              <IncludedWorkDisplay description={item.description} />
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
  );
}

function CompactMaterialList({ items }: { items: WorkOrderLineItem[] }) {
  return (
    <div className="mt-1.5">
      <div className="mb-0.5 flex items-baseline gap-2 text-[11px] font-semibold tracking-wider text-muted-foreground">
        <span>Description</span>
        <span className="flex-1" />
        <span>Qty</span>
      </div>
      <ul className="customer-materials-compact text-sm leading-5">
        {items.map((item, index) => (
          <li key={index} className="flex items-baseline gap-2 py-px">
            <span className="min-w-0">{lineItemTitle(item.description)}</span>
            <span
              aria-hidden
              className="min-w-3 flex-1 translate-y-[-0.35em] border-b border-dotted border-muted-foreground/40"
            />
            <span className="shrink-0 tabular-nums">{item.quantity.toString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

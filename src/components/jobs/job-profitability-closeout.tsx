import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/format";
import {
  CLOSEOUT_IN_PROGRESS_MESSAGE,
  PROFITABILITY_CANNOT_BE_CALCULATED_MESSAGE,
  type CloseoutCoverageState,
  type CloseoutHoursFact,
  type CloseoutMoneyFact,
  type JobProfitabilityCloseout,
  type LikeVariance,
} from "@/lib/job-profitability-closeout";
import { formatDurationClock } from "@/lib/time-cards";

const COVERAGE_ROWS: Array<{ key: keyof JobProfitabilityCloseout["coverage"]; label: string }> = [
  { key: "estimate", label: "Estimate" },
  { key: "laborTime", label: "Labor time" },
  { key: "laborCost", label: "Labor cost" },
  { key: "materials", label: "Materials" },
  { key: "expenses", label: "Expenses" },
  { key: "invoice", label: "Invoice" },
  { key: "payments", label: "Payments" },
];

function moneyOrMessage(fact: CloseoutMoneyFact) {
  if (fact.amount != null) return formatMoney(fact.amount);
  return fact.message ?? "—";
}

function hoursOrMessage(fact: CloseoutHoursFact) {
  if (fact.hours != null) return formatDurationClock(fact.hours);
  return fact.message ?? "—";
}

function coverageClass(state: CloseoutCoverageState) {
  if (state === "Complete") return "text-foreground";
  if (state === "Partial") return "text-amber-800";
  return "text-muted-foreground";
}

function VarianceRow({
  label,
  variance,
  kind,
}: {
  label: string;
  variance: LikeVariance;
  kind: "money" | "hours";
}) {
  if (!variance) return null;
  const format = (value: number) => {
    if (kind === "money") return formatMoney(value);
    const sign = value < 0 ? "-" : "";
    return `${sign}${formatDurationClock(Math.abs(value))}`;
  };
  return (
    <div className="grid gap-1 border-b border-border/50 py-2 last:border-0 sm:grid-cols-[1fr_auto_auto_auto] sm:items-center sm:gap-4">
      <p>{label}</p>
      <p className="tabular-nums text-muted-foreground">Est. {format(variance.estimated)}</p>
      <p className="tabular-nums text-muted-foreground">Act. {format(variance.actual)}</p>
      <p className="tabular-nums">Var. {format(variance.variance)}</p>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-medium tabular-nums">{value}</p>
    </div>
  );
}

export function JobProfitabilityCloseoutView({ closeout }: { closeout: JobProfitabilityCloseout }) {
  return (
    <div className="space-y-4">
      {closeout.closeoutInProgress ? (
        <Card>
          <CardHeader>
            <CardTitle>Closeout status</CardTitle>
            <CardDescription>
              This job is {closeout.jobStatus.replaceAll("_", " ").toLowerCase()}. Recorded values
              are shown below, but final profitability is not available yet.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="font-medium">{CLOSEOUT_IN_PROGRESS_MESSAGE}</p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Data coverage</CardTitle>
          <CardDescription>
            Deterministic coverage of recorded facts for this job. This is not AI confidence.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-2 sm:grid-cols-2">
            {COVERAGE_ROWS.map((row) => (
              <div key={row.key} className="flex items-center justify-between gap-3 border-b border-border/50 py-1.5 last:border-0">
                <dt>{row.label}</dt>
                <dd className={coverageClass(closeout.coverage[row.key])}>{closeout.coverage[row.key]}</dd>
              </div>
            ))}
          </dl>
          {closeout.readsTruncated ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Nested reads hit the closeout bound, so coverage is treated as partial.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sold / estimated</CardTitle>
          <CardDescription>
            Approved estimate truth only. A draft or sent version is not substituted when an
            approved version exists. Labor and material line totals are customer charges, not
            internal cost.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Fact
            label="Approved estimate total"
            value={
              closeout.sold.approvedEstimateTotal != null
                ? formatMoney(closeout.sold.approvedEstimateTotal)
                : "Estimate not recorded"
            }
          />
          <Fact
            label="Estimated labor lines"
            value={
              closeout.sold.estimatedLaborLineTotal != null
                ? formatMoney(closeout.sold.estimatedLaborLineTotal)
                : "—"
            }
          />
          <Fact
            label="Estimated material lines"
            value={
              closeout.sold.estimatedMaterialLineTotal != null
                ? formatMoney(closeout.sold.estimatedMaterialLineTotal)
                : "—"
            }
          />
          <Fact
            label="Estimated other lines"
            value={
              closeout.sold.estimatedOtherLineTotal != null
                ? formatMoney(closeout.sold.estimatedOtherLineTotal)
                : "—"
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Actual work</CardTitle>
          <CardDescription>
            Approved JOB time is labor hours. Travel and material-pickup time stay separate.
            Labor cost uses approved wage snapshots only.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Fact label="Recorded job hours" value={hoursOrMessage(closeout.actualWork.jobHours)} />
          <Fact
            label="Travel time"
            value={
              closeout.actualWork.travelHours.hours != null
                ? hoursOrMessage(closeout.actualWork.travelHours)
                : "Not recorded"
            }
          />
          <Fact
            label="Material-pickup time"
            value={
              closeout.actualWork.materialPickupHours.hours != null
                ? hoursOrMessage(closeout.actualWork.materialPickupHours)
                : "Not recorded"
            }
          />
          <Fact label="Recorded labor cost" value={moneyOrMessage(closeout.actualWork.laborCost)} />
          <Fact label="Recorded material cost" value={moneyOrMessage(closeout.actualWork.materialCost)} />
          <Fact
            label="Job-linked expenses"
            value={moneyOrMessage(closeout.actualWork.jobLinkedExpenses)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Billing</CardTitle>
          <CardDescription>{closeout.profitability.revenueDefinition}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Fact label="Invoice total" value={formatMoney(closeout.billing.invoiceTotal)} />
          <Fact label="Recorded payments" value={formatMoney(closeout.billing.recordedPayments)} />
          <Fact label="Outstanding balance" value={formatMoney(closeout.billing.outstandingBalance)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Profitability</CardTitle>
          <CardDescription>{closeout.profitability.costDefinition}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {closeout.profitability.available ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <Fact
                label="Recorded revenue"
                value={
                  closeout.profitability.recordedRevenue != null
                    ? formatMoney(closeout.profitability.recordedRevenue)
                    : "—"
                }
              />
              <Fact
                label="Recorded attributable cost"
                value={
                  closeout.profitability.recordedAttributableCost != null
                    ? formatMoney(closeout.profitability.recordedAttributableCost)
                    : "—"
                }
              />
              <Fact
                label="Gross profit"
                value={
                  closeout.profitability.grossProfit != null
                    ? formatMoney(closeout.profitability.grossProfit)
                    : "—"
                }
              />
            </div>
          ) : (
            <p className="font-medium">
              {closeout.profitability.message ?? PROFITABILITY_CANNOT_BE_CALCULATED_MESSAGE}
            </p>
          )}
          {closeout.profitability.available && closeout.profitability.grossMarginPct != null ? (
            <p className="text-sm text-muted-foreground">
              Gross margin {closeout.profitability.grossMarginPct}% on recorded billed revenue.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Actual vs estimate</CardTitle>
          <CardDescription>
            Only like values are compared. Estimated labor dollars are not compared to hours.
            Customer charges are not treated as internal cost.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <VarianceRow
            label="Labor hours"
            variance={closeout.variance.laborHours}
            kind="hours"
          />
          <VarianceRow
            label="Labor cost"
            variance={closeout.variance.laborCost}
            kind="money"
          />
          <VarianceRow
            label="Material cost"
            variance={closeout.variance.materialsCost}
            kind="money"
          />
          <VarianceRow
            label="Estimate total vs invoice total"
            variance={closeout.variance.estimateVsInvoice}
            kind="money"
          />
          <VarianceRow
            label="Invoice total vs payments"
            variance={closeout.variance.invoiceVsPayments}
            kind="money"
          />
          {!closeout.variance.laborHours &&
          !closeout.variance.laborCost &&
          !closeout.variance.materialsCost &&
          !closeout.variance.estimateVsInvoice &&
          !closeout.variance.invoiceVsPayments ? (
            <p className="text-sm text-muted-foreground">
              No like-to-like variance can be calculated from the recorded data.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <StatusBadge status={closeout.jobStatus} />
        <span>Times display in {closeout.timeZone}. Stored UTC timestamps are not rewritten.</span>
      </div>
    </div>
  );
}

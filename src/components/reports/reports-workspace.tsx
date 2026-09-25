import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { FounderRegion } from "@/components/founder-design/region";
import { DateRangeControls } from "@/components/reports/date-range-controls";
import { ReportChart } from "@/components/reports/report-chart";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate, formatMoney } from "@/lib/format";
import {
  REPORT_AREA_LABELS,
  REPORT_AREAS,
  type BuiltReport,
  type ReportArea,
} from "@/lib/reports";
import { formatDurationClock } from "@/lib/time-cards";
import { cn } from "@/lib/utils";
import { RecurringPatternReview } from "@/components/reports/recurring-pattern-review";
import type { ReportsWorkspaceProps } from "@/components/reports/types";

function changeLabel(changePercent: number | null): string | null {
  if (changePercent == null) return null;
  const rounded = Math.round(changePercent * 10) / 10;
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${rounded}% vs prior period`;
}

function Money({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  return <span className="tabular-nums">{formatMoney(value)}</span>;
}

export function ReportsWorkspace({ area, rangePreset, from, to, report, intelligence }: ReportsWorkspaceProps) {
  const otherParams = new URLSearchParams();
  if (rangePreset !== "month") otherParams.set("range", rangePreset);
  if (rangePreset === "custom" && from) otherParams.set("from", from);
  if (rangePreset === "custom" && to) otherParams.set("to", to);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_var(--tbbt-panel-width,300px)]">
      <div className="min-w-0 space-y-4">
        <FounderRegion id="nav" className="tbbt-founder-box">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-3">
            <nav className="flex flex-wrap items-center gap-1.5 overflow-x-auto">
              {REPORT_AREAS.map((item) => {
                const params = new URLSearchParams(otherParams);
                if (item !== "overview") params.set("area", item);
                const query = params.toString();
                const active = item === area;
                return (
                  <Link
                    key={item}
                    href={`/reports${query ? `?${query}` : ""}`}
                    className={cn(
                      "rounded-md border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors",
                      active
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    )}
                  >
                    {REPORT_AREA_LABELS[item]}
                  </Link>
                );
              })}
            </nav>
            <DateRangeControls preset={rangePreset} from={from} to={to} />
          </div>
          <p className="pt-2 text-xs text-muted-foreground">
            {report.range.label}
            {report.range.comparable ? " · compared with the prior equivalent period" : " · no prior-period comparison"}
          </p>
        </FounderRegion>

        {intelligence && area === "overview" ? (
          <Card>
            <CardHeader>
              <CardTitle>Profitability overview</CardTitle>
              <CardDescription>
                Recorded facts first. {intelligence.messages.bank} {intelligence.messages.accounting}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="grid gap-3 sm:grid-cols-2">
                <MiniStat
                  label="Collected cash"
                  value={<Money value={intelligence.cashFlow.collectedCustomerPayments} />}
                  hint={intelligence.cashFlow.coverage}
                />
                <MiniStat
                  label="Outstanding receivables"
                  value={<Money value={intelligence.outstandingReceivables.amount} />}
                  hint={`${intelligence.outstandingReceivables.count} sent, unpaid · not cash`}
                />
                <MiniStat
                  label="Known cash out"
                  value={<Money value={intelligence.cashFlow.knownOutflows} />}
                  hint="Recorded expenses + processed payroll"
                />
                <MiniStat
                  label="Jobs in view"
                  value={String(intelligence.jobProfitability.length)}
                  hint={
                    intelligence.jobMarginSnapshot[0]
                      ? `${intelligence.jobMarginSnapshot[0].label} · selected-range snapshot`
                      : "No jobs with recorded financial activity"
                  }
                />
              </div>
              <p className="text-xs text-muted-foreground">{intelligence.cashFlow.message}</p>
              <div className="flex flex-wrap gap-2">
                <Button asChild size="sm" variant="outline">
                  <Link href="/reports?area=receivables">Receivables</Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link href="/reports?area=job-profitability">Job margin</Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link href="/reports?area=cash-flow">Known cash flow</Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link href="/business-health">Open BSOS</Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : null}

        <FounderRegion id="charts">
          <ReportCharts area={area} report={report} />
        </FounderRegion>

        <FounderRegion id="table">
          <ReportBody area={area} report={report} intelligence={intelligence} />
        </FounderRegion>
      </div>

      <FounderRegion id="attention" className="min-w-0">
        <Card>
          <CardHeader>
            <CardTitle>Needs attention</CardTitle>
            <CardDescription>
              {report.attention.length + (intelligence?.attention.length ?? 0) === 0
                ? "Nothing waiting right now."
                : `${report.attention.length + (intelligence?.attention.length ?? 0)} record${report.attention.length + (intelligence?.attention.length ?? 0) === 1 ? "" : "s"} needing a look.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {report.attention.length + (intelligence?.attention.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">No outstanding invoices, unbilled completed jobs, or missing wage snapshots in this view.</p>
            ) : (
              [...(intelligence?.attention ?? []), ...report.attention].slice(0, 12).map((item) => (
                <Link
                  key={item.key}
                  href={item.href}
                  className="block rounded-lg border border-border/70 bg-card/40 p-2.5 text-sm transition-colors hover:bg-accent/40"
                >
                  <p className="font-medium">{item.label}</p>
                  <p className="text-xs text-muted-foreground">{item.detail}</p>
                </Link>
              ))
            )}
          </CardContent>
        </Card>
      </FounderRegion>
    </div>
  );
}

function ReportCharts({ area, report }: { area: ReportArea; report: BuiltReport }) {
  if (area === "expenses") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Recorded expenses</CardTitle>
          <CardDescription>Expense records in this range, using each expense&apos;s occurred-on date.</CardDescription>
        </CardHeader>
        <CardContent>
          <ReportChart points={report.expensesByDay} emptyLabel="No recorded expenses in this range." />
        </CardContent>
      </Card>
    );
  }

  if (area === "vendor-spending") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Vendor spending</CardTitle>
          <CardDescription>Grouped by recorded vendor only. Blank vendor fields are omitted.</CardDescription>
        </CardHeader>
        <CardContent>
          <ReportChart
            points={report.vendorSpending.map((row) => ({
              key: row.id,
              label: row.name,
              amount: row.amount,
            }))}
            emptyLabel="No recorded vendors in this range."
          />
        </CardContent>
      </Card>
    );
  }

  if (area === "profit-loss") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{report.profitLoss.label}</CardTitle>
          <CardDescription>Paid invoice revenue and recorded expenses in this range.</CardDescription>
        </CardHeader>
        <CardContent>
          <ReportChart
            points={[
              { key: "revenue", label: "Paid revenue", amount: report.profitLoss.revenue },
              { key: "expenses", label: "Recorded expenses", amount: report.profitLoss.expenses },
            ]}
            emptyLabel="No paid revenue or recorded expenses in this range."
          />
        </CardContent>
      </Card>
    );
  }

  if (area === "revenue" || area === "overview") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Paid revenue</CardTitle>
          <CardDescription>Paid invoices in this range, using each invoice&apos;s paid date.</CardDescription>
        </CardHeader>
        <CardContent>
          <ReportChart points={report.revenueByDay} emptyLabel="No paid invoices in this range." />
        </CardContent>
      </Card>
    );
  }

  if (area === "payroll-labor") {
    const points = report.workerLabor.map((row) => ({
      key: row.membershipId,
      label: row.workerName,
      amount: row.approvedHours,
    }));
    return (
      <Card>
        <CardHeader>
          <CardTitle>Approved hours by worker</CardTitle>
          <CardDescription>Approved Time Cards only. Breaks are unpaid and contribute 0 hours.</CardDescription>
        </CardHeader>
        <CardContent>
          <ReportChart points={points} emptyLabel="No approved time in this range." />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Charts</CardTitle>
        <CardDescription>
          {area === "services"
            ? "Service charts appear only when a job can be attributed to one catalog item."
            : "Use the table below for this report."}
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

function ReportBody({
  area,
  report,
  intelligence,
}: {
  area: ReportArea;
  report: BuiltReport;
  intelligence?: ReportsWorkspaceProps["intelligence"];
}) {
  if (area === "expenses") {
    return (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <MiniStat
            label="Recorded expenses"
            value={<Money value={report.recordedExpenses.current} />}
            hint={changeLabel(report.recordedExpenses.changePercent) ?? "Occurred-on date in this range"}
          />
          <MiniStat
            label="Expense records"
            value={String(report.expenseRecords.length)}
            hint="All recorded expense rows in this range"
          />
        </div>
        <ReportTable
          title="Expenses by category"
          description="Category totals from recorded expenses. Totals must reconcile to the period total."
          headers={["Category", "Records", "Amount"]}
          empty="No recorded expenses in this range."
          rows={report.expensesByCategory.map((row) => ({
            key: row.id,
            href: row.href,
            cells: [row.name, String(row.count), <Money key="a" value={row.amount} />],
            mobile: `${row.name} · ${formatMoney(row.amount)}`,
          }))}
        />
        <ReportTable
          title="Expense records"
          description="Drill-down of recorded expenses in this range."
          headers={["Date", "Description", "Category", "Vendor", "Amount"]}
          empty="No recorded expenses in this range."
          rows={report.expenseRecords.map((row) => ({
            key: row.id,
            href: row.href,
            cells: [
              formatDate(row.occurredOn),
              row.description,
              row.categoryLabel,
              row.vendor ?? "—",
              <Money key="a" value={row.amount} />,
            ],
            mobile: `${row.description} · ${formatMoney(row.amount)}`,
          }))}
        />
      </div>
    );
  }

  if (area === "vendor-spending") {
    return (
      <ReportTable
        title="Vendor spending"
        description="Spending grouped by recorded vendor. Blank vendor fields are omitted — TBBT does not invent a vendor name."
        headers={["Vendor", "Records", "Amount"]}
        empty="No recorded vendors in this range."
        rows={report.vendorSpending.map((row) => ({
          key: row.id,
          href: row.href,
          cells: [row.name, String(row.count), <Money key="a" value={row.amount} />],
          mobile: `${row.name} · ${formatMoney(row.amount)}`,
        }))}
      />
    );
  }

  if (area === "profit-loss") {
    return <ProfitLossCard report={report} />;
  }

  if (area === "job-profitability") {
    if (intelligence) {
      return (
        <ReportTable
          title="Job profitability"
          description="Billed and collected are separate. Gross profit is billed revenue minus known direct cost (wage + optional burden + job expenses). Unpaid invoices are never collected cash."
          headers={["Customer", "Status", "Billed", "Collected", "Direct cost", "Gross profit", "Margin %"]}
          empty="No jobs with invoices, approved labor, or recorded job expenses in this range."
          rows={intelligence.jobProfitability.map((row) => ({
            key: row.jobId,
            href: row.href,
            cells: [
              row.customerName,
              <StatusBadge key="s" status={row.status} />,
              <Money key="b" value={row.billedRevenue} />,
              <Money key="c" value={row.collectedRevenue} />,
              row.knownTotalDirectCost == null ? "Incomplete" : <Money key="d" value={row.knownTotalDirectCost} />,
              <Money key="g" value={row.grossProfit} />,
              row.grossMarginPct == null ? "—" : `${row.grossMarginPct}%`,
            ],
            mobile: `${row.customerName} · billed ${formatMoney(row.billedRevenue)} · collected ${formatMoney(row.collectedRevenue)}`,
          }))}
        />
      );
    }
    return (
      <ReportTable
        title="Job profitability"
        description={`${report.jobMarginLabel} is paid revenue minus approved labor and recorded job-allocated expenses. Unallocated expenses are not assigned to a job.`}
        headers={["Customer", "Status", "Paid", "Labor", "Hours", "Job expenses", report.jobMarginLabel]}
        empty="No jobs with invoices, approved labor, or recorded job expenses in this range."
        rows={report.jobProfitability.map((row) => ({
          key: row.jobId,
          href: row.href,
          cells: [
            row.customerName,
            <StatusBadge key="s" status={row.status} />,
            <Money key="p" value={row.paidRevenue} />,
            row.laborCostIncomplete ? "Incomplete" : <Money key="l" value={row.laborCost} />,
            formatDurationClock(row.approvedHours),
            <Money key="e" value={row.recordedJobExpense} />,
            <Money key="m" value={row.recordedMargin} />,
          ],
          mobile: `${row.customerName} · paid ${formatMoney(row.paidRevenue)}`,
        }))}
      />
    );
  }

  if (area === "payroll-labor") {
    return (
      <div className="space-y-4">
        <ReportTable
          title="Approved labor by worker"
          description="Approved Time Cards only. TBBT does not calculate taxes or deductions."
          headers={["Worker", "Approved hours", "Labor cost", "Job entries"]}
          empty="No approved time in this range."
          rows={report.workerLabor.map((row) => ({
            key: row.membershipId,
            href: "/time-cards",
            cells: [
              row.workerName,
              formatDurationClock(row.approvedHours),
              row.laborCostIncomplete ? "Incomplete" : <Money key="c" value={row.laborCost} />,
              String(row.jobCount),
            ],
            mobile: `${row.workerName} · ${formatDurationClock(row.approvedHours)}`,
          }))}
        />
        <ReportTable
          title="Recorded payroll runs"
          description="AUTHORIZED or PROCESSED runs whose pay period overlaps this range. Snapshots are not recomputed."
          headers={["Period", "Status", "Workers", "Hours", "Gross labor"]}
          empty="No authorized or processed payroll runs overlap this range."
          rows={report.payrollRuns.map((run) => ({
            key: run.id,
            href: `/payroll?run=${run.id}`,
            cells: [
              run.periodLabel,
              run.status,
              String(run.authorizedWorkerCount ?? "—"),
              run.hours == null ? "—" : formatDurationClock(run.hours),
              <Money key="g" value={run.gross} />,
            ],
            mobile: `${run.periodLabel} · ${run.status}`,
          }))}
        />
      </div>
    );
  }

  if (area === "customers") {
    if (intelligence) {
      return (
        <ReportTable
          title="Customer profitability"
          description="Invoiced is sent + paid. Collected is recorded payments. Outstanding is unpaid sent invoices."
          headers={["Customer", "Jobs", "Invoiced", "Collected", "Direct cost", "Gross profit", "Outstanding"]}
          empty="No customer financial activity in this range."
          rows={intelligence.customerProfitability.map((row) => ({
            key: row.customerId,
            href: row.href,
            cells: [
              row.name,
              String(row.jobCount),
              <Money key="i" value={row.invoiced} />,
              <Money key="c" value={row.collected} />,
              row.knownDirectCost == null ? "Incomplete" : <Money key="d" value={row.knownDirectCost} />,
              <Money key="g" value={row.grossProfit} />,
              <Money key="o" value={row.outstandingReceivables} />,
            ],
            mobile: `${row.name} · collected ${formatMoney(row.collected)}`,
          }))}
        />
      );
    }
    return (
      <ReportTable
        title="Customers"
        description="New = created in this range. Repeat = more than one completed job or paid invoice on record."
        headers={["Customer", "New", "Repeat", "Paid revenue", "Completed jobs"]}
        empty="No customer activity in this range."
        rows={report.customers.map((row) => ({
          key: row.id,
          href: row.href,
          cells: [
            row.name,
            row.isNew ? "New" : "—",
            row.isRepeat ? "Repeat" : "—",
            <Money key="r" value={row.paidRevenue} />,
            String(row.completedJobs),
          ],
          mobile: `${row.name} · ${formatMoney(row.paidRevenue)}`,
        }))}
      />
    );
  }

  if (area === "services") {
    if (intelligence) {
      return (
        <ReportTable
          title="Service profitability"
          description="Jobs are attributed only when they map to exactly one catalog service. Unattributed work is not split across services."
          headers={["Service", "Jobs", "Billed", "Direct cost", "Gross profit", "Margin %", "Avg ticket"]}
          empty="No attributable service activity in this range."
          rows={intelligence.serviceProfitability.map((row) => ({
            key: row.catalogItemId ?? "unattributed",
            href: "/services",
            cells: [
              row.attributed ? row.name : `${row.name} (not attributed)`,
              String(row.jobs),
              row.revenue == null ? "—" : <Money key="r" value={row.revenue} />,
              row.directCost == null ? "Incomplete" : <Money key="d" value={row.directCost} />,
              <Money key="g" value={row.grossProfit} />,
              row.grossMargin == null ? "—" : `${row.grossMargin}%`,
              <Money key="a" value={row.averageTicket} />,
            ],
            mobile: `${row.name} · ${row.jobs} jobs`,
          }))}
        />
      );
    }
    return (
      <ReportTable
        title="Services"
        description="Revenue is shown only when a paid invoice's job maps to exactly one catalog service."
        headers={["Service", "Requested", "Estimated", "Completed", "Revenue"]}
        empty="No service activity in this range."
        rows={report.services.map((row) => ({
          key: row.catalogItemId ?? "unattributed",
          href: "/services",
          cells: [
            row.name,
            String(row.requested),
            String(row.estimated),
            String(row.completed),
            row.revenueAttributed ? <Money key="r" value={row.revenue} /> : "Not attributed",
          ],
          mobile: `${row.name} · ${row.requested} requested`,
        }))}
      />
    );
  }

  if (area === "receivables" && intelligence) {
    return (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {(["0-30", "31-60", "61-90", "90+"] as const).map((bucket) => (
            <MiniStat
              key={bucket}
              label={`${bucket} days`}
              value={<Money value={intelligence.receivables.buckets[bucket].amount} />}
              hint={`${intelligence.receivables.buckets[bucket].count} invoices · age from issued date`}
            />
          ))}
        </div>
        <ReportTable
          title="Unpaid sent invoices"
          description="Balance due is invoice total minus recorded payments. Due dates are not invented."
          headers={["Customer", "Age", "Bucket", "Invoice", "Collected", "Balance due"]}
          empty="No unpaid sent invoices."
          rows={intelligence.receivables.rows.map((row) => ({
            key: row.invoiceId,
            href: row.href,
            cells: [
              row.customerName,
              `${row.ageDays} days`,
              row.agingBucket,
              <Money key="t" value={row.invoiceTotal} />,
              <Money key="c" value={row.collectedAgainstInvoice} />,
              <Money key="b" value={row.balanceDue} />,
            ],
            mobile: `${row.customerName} · ${formatMoney(row.balanceDue)} · ${row.ageDays}d`,
          }))}
        />
      </div>
    );
  }

  if (area === "cash-flow" && intelligence) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Known cash flow</CardTitle>
            <CardDescription>{intelligence.cashFlow.message}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <PnlRow label="Collected customer payments" value={<Money value={intelligence.cashFlow.collectedCustomerPayments} />} />
            <PnlRow label="Recorded expenses" value={<Money value={intelligence.cashFlow.recordedExpenseOutflows} />} />
            <PnlRow label="Processed payroll" value={<Money value={intelligence.cashFlow.processedPayrollOutflows} />} hint="AUTHORIZED payroll is not treated as cash out" />
            <PnlRow label="Known net" value={<Money value={intelligence.cashFlow.netKnown} />} hint="Not a bank balance" />
            <p className="text-xs text-muted-foreground">{intelligence.cashFlow.coverage}</p>
            <p className="text-xs text-muted-foreground">
              Banking: {intelligence.bankConnected ? "Connected" : "Not Connected"}. Accounting:{" "}
              {intelligence.accountingConnected ? "Connected" : "Not Connected"}.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (area === "estimate-accuracy" && intelligence) {
    return (
      <ReportTable
        title="Estimate vs actual"
        description="Estimated LABOR quantity/cost and MATERIAL lines versus approved time and recorded materials. Missing estimates stay blank."
        headers={["Customer", "Est. hours", "Actual hours", "Est. materials", "Actual materials", "Cost variance"]}
        empty="No jobs with estimate or actual cost records in this range."
        rows={intelligence.jobProfitability.map((row) => ({
          key: row.jobId,
          href: row.href,
          cells: [
            row.customerName,
            row.estimateActual.estimatedLaborHours == null ? "—" : formatDurationClock(row.estimateActual.estimatedLaborHours),
            formatDurationClock(row.estimateActual.actualLaborHours),
            <Money key="em" value={row.estimateActual.estimatedMaterials} />,
            <Money key="am" value={row.estimateActual.actualMaterials} />,
            <Money key="v" value={row.estimateActual.totalCostVariance} />,
          ],
          mobile: `${row.customerName} · variance ${row.estimateActual.totalCostVariance ?? "—"}`,
        }))}
      />
    );
  }

  if (area === "pricing" && intelligence) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Pricing signals</CardTitle>
            <CardDescription>
              Deterministic owner-review signals from completed historical data. Catalog prices are never changed automatically.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {intelligence.pricingRecommendations.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Not enough completed jobs with complete cost data for a pricing signal.
              </p>
            ) : (
              intelligence.pricingRecommendations.map((row) => (
                <div key={row.key} className="rounded-lg border border-border/70 p-3 text-sm">
                  <p className="font-medium">{row.title}</p>
                  <p className="text-xs text-muted-foreground">Sample {row.sampleSize} · {row.currentResult}</p>
                  <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                    {row.evidence.map((fact) => (
                      <li key={fact}>{fact}</li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs">{row.proposedAction}</p>
                </div>
              ))
            )}
          </CardContent>
        </Card>
        <ReportTable
          title="Likely recurring costs"
          description="Detected from expense history. Confirming a pattern does not create a liability."
          headers={["Description", "Vendor", "Suggested", "Count", "Status", "Review"]}
          empty="No repeating expense patterns on file."
          rows={intelligence.recurringSuggestions.map((row) => ({
            key: row.patternKey,
            href: row.href,
            cells: [
              row.description,
              row.vendor ?? "—",
              <Money key="a" value={row.suggestedAmount} />,
              String(row.occurrenceCount),
              row.ownerStatus,
              <RecurringPatternReview key="r" row={row} />,
            ],
            mobile: `${row.description} · ${row.ownerStatus}`,
          }))}
        />
      </div>
    );
  }

  if (area === "taxes") {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Tax records</CardTitle>
            <CardDescription>{report.taxDisclaimer}</CardDescription>
          </CardHeader>
        </Card>
        <ReportTable
          title="Held records"
          description="Paid invoices and authorized/processed payroll snapshots only."
          headers={["Date", "Record", "Amount", "Detail"]}
          empty="No paid invoices or recorded payroll in this range."
          rows={report.taxRecords.map((row) => ({
            key: row.id,
            href: row.href,
            cells: [row.dateLabel, row.description, <Money key="a" value={row.amount} />, row.extra || "—"],
            mobile: `${row.dateLabel} · ${row.description}`,
          }))}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {area === "overview" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <MiniStat
            label="Paid revenue"
            value={<Money value={report.paidRevenue.current} />}
            hint={changeLabel(report.paidRevenue.changePercent)}
          />
          <MiniStat
            label="Outstanding"
            value={<Money value={report.outstanding.current} />}
            hint={`${report.outstanding.count} sent, unpaid · current snapshot`}
          />
          <MiniStat
            label="Approved labor"
            value={
              report.labor.laborCostIncomplete ? "Incomplete" : <Money value={report.labor.laborCost} />
            }
            hint={`${formatDurationClock(report.labor.approvedHours)} approved hours`}
          />
          <MiniStat
            label="New customers"
            value={String(report.newCustomers.current)}
            hint={changeLabel(report.newCustomers.changePercent)}
          />
          <MiniStat
            label="Recorded expenses"
            value={<Money value={report.recordedExpenses.current} />}
            hint={changeLabel(report.recordedExpenses.changePercent) ?? "Occurred-on date in this range"}
          />
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          <MiniStat label="Paid revenue" value={<Money value={report.paidRevenue.current} />} hint="PAID invoices · paid date" />
          <MiniStat
            label="Issued invoices"
            value={String(report.issuedInvoiceCount.current)}
            hint={
              report.averageIssuedInvoice == null
                ? "SENT + PAID created in range"
                : `Avg ${formatMoney(report.averageIssuedInvoice)}`
            }
          />
          <MiniStat
            label="Outstanding"
            value={<Money value={report.outstanding.current} />}
            hint="Currently SENT"
          />
        </div>
      )}
      <ReportTable
        title={area === "overview" ? "Invoices in this range" : "Invoice detail"}
        description="Draft invoices are listed when created in range but never counted as revenue."
        headers={["Customer", "Status", "Amount", "Paid", "Created"]}
        empty="No invoices in this range."
        rows={report.invoices.map((invoice) => ({
          key: invoice.id,
          href: `/invoices/${invoice.id}`,
          cells: [
            invoice.customerName,
            <StatusBadge key="s" status={invoice.status} />,
            <Money key="t" value={invoice.total} />,
            invoice.paidAt ? formatDate(invoice.paidAt) : "—",
            formatDate(invoice.createdAt),
          ],
          mobile: `${invoice.customerName} · ${invoice.status} · ${formatMoney(invoice.total)}`,
        }))}
      />
      {report.revenueByCustomer.length > 0 ? (
        <ReportTable
          title="Revenue by customer"
          description="Paid invoices only."
          headers={["Customer", "Paid invoices", "Revenue"]}
          empty="No paid revenue by customer."
          rows={report.revenueByCustomer.map((row) => ({
            key: row.id,
            href: row.href,
            cells: [row.name, String(row.count), <Money key="a" value={row.amount} />],
            mobile: `${row.name} · ${formatMoney(row.amount)}`,
          }))}
        />
      ) : null}
      {report.revenueByService.length > 0 ? (
        <ReportTable
          title="Revenue by service"
          description="Only jobs that map to exactly one catalog service."
          headers={["Service", "Paid invoices", "Revenue"]}
          empty="No attributable service revenue."
          rows={report.revenueByService.map((row) => ({
            key: row.id,
            href: row.href,
            cells: [row.name, String(row.count), <Money key="a" value={row.amount} />],
            mobile: `${row.name} · ${formatMoney(row.amount)}`,
          }))}
        />
      ) : null}
    </div>
  );
}

function ProfitLossCard({ report }: { report: BuiltReport }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{report.profitLoss.label}</CardTitle>
        <CardDescription>{report.profitLoss.message}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <PnlRow label="Paid revenue" value={<Money value={report.profitLoss.revenue} />} />
        <PnlRow label="Recorded expenses" value={<Money value={report.profitLoss.expenses} />} />
        <PnlRow label={report.profitLoss.label} value={<Money value={report.profitLoss.recordedNet} />} />
        <PnlRow
          label="Approved labor cost"
          value={
            report.profitLoss.laborCostIncomplete ? (
              <span className="text-muted-foreground">Incomplete</span>
            ) : (
              <Money value={report.profitLoss.laborCost} />
            )
          }
          hint="Informational — not subtracted again in TBBT-recorded net"
        />
      </CardContent>
    </Card>
  );
}

function PnlRow({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/50 py-2 last:border-b-0">
      <div>
        <p className="text-muted-foreground">{label}</p>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="text-right font-medium">{value}</div>
    </div>
  );
}

function MiniStat({ label, value, hint }: { label: string; value: ReactNode; hint?: string | null }) {
  return (
    <Card>
      <CardContent className="space-y-1 p-4">
        <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
        <p className="text-xl font-semibold tabular-nums">{value}</p>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

function ReportTable({
  title,
  description,
  headers,
  rows,
  empty,
}: {
  title: string;
  description: string;
  headers: string[];
  empty: string;
  rows: Array<{ key: string; href: string; cells: ReactNode[]; mobile: string }>;
}) {
  if (rows.length === 0) {
    return <EmptyState title={title} description={empty} />;
  }

  return (
    <Card className="overflow-hidden border-border/70 p-0 shadow-sm">
      <CardHeader className="border-b border-border/60 px-4 py-3">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <div className="hidden sm:block">
        <div className="overflow-x-auto">
          <table className="w-full" style={{ fontSize: "var(--tbbt-table-font-size, 14px)" }}>
            <thead>
              <tr
                className="border-b border-border/70 bg-muted/50 text-left font-semibold tracking-wide text-muted-foreground uppercase"
                style={
                  {
                    "--th-py": "var(--tbbt-table-header-py, 14px)",
                    "--cell-px": "var(--tbbt-table-cell-px, 8px)",
                    fontSize: "var(--tbbt-table-header-font-size, 12px)",
                  } as CSSProperties
                }
              >
                {headers.map((header) => (
                  <th key={header} className="font-semibold" style={{ padding: "var(--th-py) var(--cell-px)" }}>
                    {header}
                  </th>
                ))}
                <th className="text-right font-semibold" style={{ padding: "var(--th-py) var(--cell-px)" }}>
                  Open
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.key}
                  className="border-b border-border/60 last:border-b-0"
                  style={
                    {
                      "--tr-py": "var(--tbbt-table-row-py, 16px)",
                      "--cell-px": "var(--tbbt-table-cell-px, 8px)",
                    } as CSSProperties
                  }
                >
                  {row.cells.map((cell, index) => (
                    <td key={`${row.key}:${index}`} className="align-top" style={{ padding: "var(--tr-py) var(--cell-px)" }}>
                      {cell}
                    </td>
                  ))}
                  <td className="text-right" style={{ padding: "var(--tr-py) var(--cell-px)" }}>
                    <Button asChild size="sm" variant="outline">
                      <Link href={row.href}>Open</Link>
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="space-y-2 p-3 sm:hidden">
        {rows.map((row) => (
          <Link
            key={row.key}
            href={row.href}
            className="block rounded-lg border border-border/70 p-3 text-sm"
          >
            {row.mobile}
          </Link>
        ))}
      </div>
    </Card>
  );
}

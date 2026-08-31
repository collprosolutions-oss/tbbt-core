import Link from "next/link";
import { PipelineFollowUpForm } from "@/components/pipeline/follow-up-form";
import { PipelineNotesForm } from "@/components/pipeline/notes-form";
import { PipelineStageForm } from "@/components/pipeline/stage-form";
import type { PipelineWorkspaceProps } from "@/components/pipeline/types";
import { EmptyState } from "@/components/empty-state";
import { FounderRegion } from "@/components/founder-design/region";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate, formatMoney } from "@/lib/format";
import { formatISODate } from "@/lib/schedule";
import {
  ATTENTION_KIND_LABELS,
  FOLLOW_UP_STATUS_LABELS,
  PIPELINE_ACTIVITY_FILTER_LABELS,
  PIPELINE_ACTIVITY_FILTERS,
  PIPELINE_LOSS_REASON_LABELS,
  PIPELINE_STAGE_LABELS,
  PIPELINE_STAGES,
  isPipelineLossReason,
  type PipelineStage,
} from "@/lib/pipeline";
import type { PipelineOpportunityView } from "@/lib/pipeline-data";
import { cn } from "@/lib/utils";

function hrefWith(source: PipelineWorkspaceProps["source"], patch: Record<string, string | undefined>) {
  const params = new URLSearchParams();
  const next = {
    q: source.query.q,
    stage: source.query.stage === "all" ? "" : source.query.stage,
    activity: source.query.activity === "all" ? "" : source.query.activity,
    selected: source.query.selected,
    ...patch,
  };
  if (next.q) params.set("q", next.q);
  if (next.stage) params.set("stage", next.stage);
  if (next.activity) params.set("activity", next.activity);
  if (next.selected) params.set("selected", next.selected);
  const query = params.toString();
  return query ? `/pipeline?${query}` : "/pipeline";
}

function moneyOrDash(value: string | null) {
  return value ? formatMoney(value) : "—";
}

function ageLabel(days: number) {
  if (days === 0) return "Today";
  if (days === 1) return "1 day";
  return `${days} days`;
}

export function PipelineWorkspace({ source }: PipelineWorkspaceProps) {
  const selected = source.selected;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_var(--tbbt-panel-width,300px)]">
      <div className="min-w-0 space-y-4">
        <FounderRegion id="nav" className="tbbt-founder-box">
          <form method="get" action="/pipeline" className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
            {source.query.selected ? <input type="hidden" name="selected" value={source.query.selected} /> : null}
            <label className="min-w-0 flex-1 text-xs text-muted-foreground">
              Search
              <input
                name="q"
                defaultValue={source.query.q}
                placeholder="Customer, service, or request"
                className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
              />
            </label>
            <label className="text-xs text-muted-foreground">
              Stage
              <select
                name="stage"
                defaultValue={source.query.stage === "all" ? "" : source.query.stage}
                className="mt-1 block w-full rounded-md border border-input bg-background px-2 py-2 text-sm text-foreground"
              >
                <option value="">All stages</option>
                {PIPELINE_STAGES.map((stage) => (
                  <option key={stage} value={stage}>
                    {PIPELINE_STAGE_LABELS[stage]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-muted-foreground">
              Activity
              <select
                name="activity"
                defaultValue={source.query.activity === "all" ? "" : source.query.activity}
                className="mt-1 block w-full rounded-md border border-input bg-background px-2 py-2 text-sm text-foreground"
              >
                {PIPELINE_ACTIVITY_FILTERS.map((filter) => (
                  <option key={filter} value={filter === "all" ? "" : filter}>
                    {PIPELINE_ACTIVITY_FILTER_LABELS[filter]}
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit" size="sm">
              Apply
            </Button>
          </form>
        </FounderRegion>

        <FounderRegion id="board">
          <MobileBoard source={source} />
          <DesktopBoard source={source} />
        </FounderRegion>
      </div>

      <div className="min-w-0 space-y-4">
        <FounderRegion id="details">
          {selected ? (
            <OpportunityDetail source={source} row={selected} />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Opportunity detail</CardTitle>
                <CardDescription>Select a card to see the sales summary.</CardDescription>
              </CardHeader>
            </Card>
          )}
        </FounderRegion>

        <FounderRegion id="attention">
          <Card>
            <CardHeader>
              <CardTitle>Needs attention</CardTitle>
              <CardDescription>From real follow-up dates, sent estimates, and new leads.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {source.attention.length === 0 ? (
                <p className="text-xs text-muted-foreground">Nothing needs owner action right now.</p>
              ) : (
                <ul className="space-y-2">
                  {source.attention.slice(0, 8).map((row) => (
                    <li key={row.key}>
                      <Link
                        href={hrefWith(source, { selected: row.key })}
                        className="block rounded-md border border-border/70 p-2 hover:bg-accent/40"
                      >
                        <p className="font-medium">{row.customerName}</p>
                        <p className="text-xs text-muted-foreground">{row.summary}</p>
                        <p className="text-xs text-muted-foreground">{row.kindLabels.join(" · ")}</p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </FounderRegion>
      </div>
    </div>
  );
}

function DesktopBoard({ source }: PipelineWorkspaceProps) {
  const stages = source.query.stage === "all" ? PIPELINE_STAGES : [source.query.stage];
  return (
    <div className="hidden min-w-0 lg:block">
      <div className="flex gap-3 overflow-x-auto pb-2">
        {stages.map((stage) => {
          const column = source.byStage[stage];
          return (
            <section
              key={stage}
              className="flex w-[240px] shrink-0 flex-col rounded-lg border border-border/70 bg-muted/20"
            >
              <header className="border-b border-border/60 px-3 py-2">
                <p className="text-sm font-semibold">{PIPELINE_STAGE_LABELS[stage]}</p>
                <p className="text-xs text-muted-foreground">
                  {column.count} · {moneyOrDash(column.value)}
                </p>
              </header>
              <div className="flex flex-1 flex-col gap-2 p-2">
                {column.rows.length === 0 ? (
                  <p className="px-1 py-3 text-xs text-muted-foreground">None</p>
                ) : (
                  column.rows.map((row) => <OpportunityCard key={row.key} source={source} row={row} />)
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function MobileBoard({ source }: PipelineWorkspaceProps) {
  const mobileStage: PipelineStage =
    source.query.stage === "all" ? (source.selected?.stage ?? "NEW_LEAD") : source.query.stage;
  const column = source.byStage[mobileStage];

  return (
    <div className="space-y-3 lg:hidden">
      <nav className="flex gap-1.5 overflow-x-auto pb-1">
        {PIPELINE_STAGES.map((stage) => {
          const active = stage === mobileStage;
          return (
            <Link
              key={stage}
              href={hrefWith(source, { stage, selected: source.selected?.stage === stage ? source.selected.key : "" })}
              className={cn(
                "shrink-0 rounded-md border px-3 py-1.5 text-xs font-medium",
                active
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground",
              )}
            >
              {PIPELINE_STAGE_LABELS[stage]} ({source.byStage[stage].count})
            </Link>
          );
        })}
      </nav>
      {column.rows.length === 0 ? (
        <EmptyState title={`No ${PIPELINE_STAGE_LABELS[mobileStage].toLowerCase()} opportunities`} />
      ) : (
        <div className="space-y-2">
          {column.rows.map((row) => (
            <OpportunityCard key={row.key} source={source} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

function OpportunityCard({
  source,
  row,
}: {
  source: PipelineWorkspaceProps["source"];
  row: PipelineOpportunityView;
}) {
  const selected = source.selected?.key === row.key;
  return (
    <FounderRegion id="card">
      <Link
        href={hrefWith(source, { selected: row.key, stage: source.query.stage === "all" ? "" : source.query.stage })}
        className={cn(
          "block rounded-md border bg-card p-3 text-sm shadow-sm transition-colors hover:bg-accent/30",
          selected ? "border-primary" : "border-border/70",
        )}
      >
        <p className="font-medium">{row.customerName}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{row.requestSummary}</p>
        {row.propertyLabel ? <p className="mt-1 text-xs text-muted-foreground">{row.propertyLabel}</p> : null}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {row.estimateValue ? (
            <span className="text-xs font-semibold">{formatMoney(row.estimateValue)}</span>
          ) : (
            <span className="text-xs text-muted-foreground">No estimate value</span>
          )}
          {row.estimateStatus ? <StatusBadge status={row.estimateStatus} /> : null}
          {row.jobStatus ? <StatusBadge status={row.jobStatus} /> : null}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {ageLabel(row.ageDays)} · {FOLLOW_UP_STATUS_LABELS[row.followUp]}
        </p>
      </Link>
    </FounderRegion>
  );
}

function OpportunityDetail({
  source,
  row,
}: {
  source: PipelineWorkspaceProps["source"];
  row: PipelineOpportunityView;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{row.customerName}</CardTitle>
        <CardDescription>
          {PIPELINE_STAGE_LABELS[row.stage]}
          {row.propertyLabel ? ` · ${row.propertyLabel}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="space-y-1">
          <p>
            <span className="text-muted-foreground">Requested work: </span>
            {row.requestedWork || row.requestSummary}
          </p>
          <p>
            <span className="text-muted-foreground">Request: </span>
            {row.serviceRequestId ? row.requestStatus || "Open" : "No linked request"}
          </p>
          <p>
            <span className="text-muted-foreground">Estimate: </span>
            {row.estimateId
              ? `${row.estimateStatus ?? "Draft"}${row.estimateValue ? ` · ${formatMoney(row.estimateValue)}` : ""}`
              : "None on file"}
          </p>
          <p>
            <span className="text-muted-foreground">Job: </span>
            {row.jobId ? row.jobStatus : "None"}
          </p>
          <p>
            <span className="text-muted-foreground">Last activity: </span>
            {formatDate(row.lastActivity)} · {ageLabel(row.ageDays)} old
          </p>
          <p>
            <span className="text-muted-foreground">Follow-up: </span>
            {row.followUpOn
              ? `${formatDate(row.followUpOn)} · ${FOLLOW_UP_STATUS_LABELS[row.followUp]}`
              : "Not set"}
          </p>
          {row.stage === "LOST" ? (
            <p>
              <span className="text-muted-foreground">Lost reason: </span>
              {row.lossReason && isPipelineLossReason(row.lossReason)
                ? PIPELINE_LOSS_REASON_LABELS[row.lossReason]
                : "Not recorded"}
              {row.lossReasonNote ? ` — ${row.lossReasonNote}` : ""}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          {row.serviceRequestId ? (
            <Button asChild size="sm" variant="outline">
              <Link href="/requests">Open request</Link>
            </Button>
          ) : null}
          {row.customerId ? (
            <Button asChild size="sm" variant="outline">
              <Link href={`/customers/${row.customerId}`}>Open customer</Link>
            </Button>
          ) : null}
          {row.estimateId ? (
            <Button asChild size="sm" variant="outline">
              <Link href={`/estimates/${row.estimateId}`}>Open estimate</Link>
            </Button>
          ) : null}
          {row.jobId ? (
            <Button asChild size="sm" variant="outline">
              <Link href={`/jobs/${row.jobId}`}>Open job</Link>
            </Button>
          ) : null}
        </div>

        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Sales stage</p>
          <PipelineStageForm
            opportunityKey={row.key}
            stage={row.stage}
            estimateStatus={row.estimateStatus}
            hasJob={Boolean(row.jobId)}
            lossReason={row.lossReason}
            lossReasonNote={row.lossReasonNote}
          />
        </div>

        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Follow-up</p>
          <PipelineFollowUpForm
            opportunityKey={row.key}
            followUpOn={row.followUpOn ? formatISODate(row.followUpOn) : ""}
          />
        </div>

        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Pipeline notes</p>
          <PipelineNotesForm opportunityKey={row.key} notes={row.notes ?? ""} />
        </div>

        {row.attention.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {row.attention.map((kind) => ATTENTION_KIND_LABELS[kind]).join(" · ")}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

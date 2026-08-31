import Link from "next/link";
import { KnowledgeArchiveButton } from "@/components/knowledge/archive-button";
import { KnowledgeCreateForm } from "@/components/knowledge/create-form";
import { KnowledgeEditForm } from "@/components/knowledge/edit-form";
import { KnowledgeReviewButton } from "@/components/knowledge/review-button";
import type { KnowledgeWorkspaceProps } from "@/components/knowledge/types";
import { EmptyState } from "@/components/empty-state";
import { FounderRegion } from "@/components/founder-design/region";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import {
  KNOWLEDGE_AREA_LABELS,
  KNOWLEDGE_AREAS,
  KNOWLEDGE_TRUST_LABELS,
  KNOWLEDGE_TRUST_STATES,
  LEARNING_LOOP_AVAILABILITY_LABELS,
  TAKEOFF_UNAVAILABLE_MESSAGE,
  type KnowledgeTrustState,
} from "@/lib/knowledge";
import type { KnowledgeEntryView, KnowledgeSource } from "@/lib/knowledge-data";
import { cn } from "@/lib/utils";

const TRUST_VARIANTS: Record<KnowledgeTrustState, "success" | "default" | "outline" | "warning" | "destructive"> = {
  VERIFIED: "success",
  SUPPORTED: "default",
  ESTIMATE: "outline",
  NEEDS_REVIEW: "warning",
  CONFLICT: "destructive",
  UNKNOWN: "outline",
};

function hrefWith(source: KnowledgeSource, patch: Record<string, string | undefined>) {
  const params = new URLSearchParams();
  const next = {
    area: source.query.area === "overview" ? "" : source.query.area,
    q: source.query.q,
    trust: source.query.trust === "all" ? "" : source.query.trust,
    review: source.query.review === "all" ? "" : source.query.review,
    archive: source.query.archive === "active" ? "" : source.query.archive,
    selected: source.query.selected,
    ...patch,
  };
  if (next.area) params.set("area", next.area);
  if (next.q) params.set("q", next.q);
  if (next.trust) params.set("trust", next.trust);
  if (next.review) params.set("review", next.review);
  if (next.archive) params.set("archive", next.archive);
  if (next.selected) params.set("selected", next.selected);
  const query = params.toString();
  return query ? `/knowledge?${query}` : "/knowledge";
}

function TrustBadge({ state }: { state: KnowledgeTrustState }) {
  return <Badge variant={TRUST_VARIANTS[state]}>{KNOWLEDGE_TRUST_LABELS[state]}</Badge>;
}

export function KnowledgeWorkspace({ area, source }: KnowledgeWorkspaceProps) {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_var(--tbbt-panel-width,300px)]">
      <div className="min-w-0 space-y-4">
        <FounderRegion id="nav" className="tbbt-founder-box">
          <nav className="flex flex-wrap items-center gap-1.5 overflow-x-auto border-b border-border/60 pb-3">
            {KNOWLEDGE_AREAS.map((item) => {
              const active = item === area;
              return (
                <Link
                  key={item}
                  href={hrefWith(source, { area: item === "overview" ? "" : item, selected: undefined })}
                  className={cn(
                    "rounded-md border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors",
                    active
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  {KNOWLEDGE_AREA_LABELS[item]}
                </Link>
              );
            })}
          </nav>
          <form method="get" action="/knowledge" className="flex flex-col gap-3 pt-3 sm:flex-row sm:flex-wrap sm:items-end">
            {area !== "overview" ? <input type="hidden" name="area" value={area} /> : null}
            {source.query.selected ? <input type="hidden" name="selected" value={source.query.selected} /> : null}
            <label className="min-w-0 flex-1 text-xs text-muted-foreground">
              Search
              <input
                name="q"
                defaultValue={source.query.q}
                placeholder="Title, notes, or source label"
                className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
              />
            </label>
            <label className="text-xs text-muted-foreground">
              Trust
              <select
                name="trust"
                defaultValue={source.query.trust === "all" ? "" : source.query.trust}
                className="mt-1 block w-full rounded-md border border-input bg-background px-2 py-2 text-sm text-foreground"
              >
                <option value="">All trust states</option>
                {KNOWLEDGE_TRUST_STATES.map((state) => (
                  <option key={state} value={state}>
                    {KNOWLEDGE_TRUST_LABELS[state]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-muted-foreground">
              Review
              <select
                name="review"
                defaultValue={source.query.review === "all" ? "" : source.query.review}
                className="mt-1 block w-full rounded-md border border-input bg-background px-2 py-2 text-sm text-foreground"
              >
                <option value="">All</option>
                <option value="needs-review">Needs review</option>
              </select>
            </label>
            <label className="text-xs text-muted-foreground">
              Status
              <select
                name="archive"
                defaultValue={source.query.archive === "active" ? "" : source.query.archive}
                className="mt-1 block w-full rounded-md border border-input bg-background px-2 py-2 text-sm text-foreground"
              >
                <option value="">Active</option>
                <option value="archived">Archived</option>
                <option value="all">All</option>
              </select>
            </label>
            <Button type="submit" size="sm" variant="outline">
              Apply
            </Button>
          </form>
          <p className="pt-2 text-xs text-muted-foreground">{source.noAiMessage}</p>
        </FounderRegion>

        {area === "overview" ? <OverviewBody source={source} /> : <CategoryBody area={area} source={source} />}
      </div>

      <div className="min-w-0 space-y-4">
        <FounderRegion id="details">
          <DetailCard source={source} />
        </FounderRegion>
        <FounderRegion id="attention">
          <NeedsReviewCard source={source} />
        </FounderRegion>
        <FounderRegion id="loop">
          <LearningLoopCard source={source} />
        </FounderRegion>
      </div>
    </div>
  );
}

function OverviewBody({ source }: { source: KnowledgeSource }) {
  return (
    <>
      <FounderRegion id="list">
        <Card>
          <CardHeader>
            <CardTitle>Recent knowledge</CardTitle>
            <CardDescription>Owner-recorded entries only. Age is shown; staleness is not invented.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {source.recent.length === 0 ? (
              <p className="text-sm text-muted-foreground">No knowledge entries yet.</p>
            ) : (
              source.recent.map((row) => <EntryCard key={row.id} entry={row} source={source} />)
            )}
          </CardContent>
        </Card>
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Knowledge by category</CardTitle>
            <CardDescription>One Knowledge Hub. These are organizational counts, not separate databases.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2">
            {source.byCategory.map((row) => (
              <div key={row.category} className="rounded-md border border-border/70 px-3 py-2 text-sm">
                <p className="font-medium">{row.label}</p>
                <p className="text-xs text-muted-foreground">
                  {row.count} active {row.count === 1 ? "entry" : "entries"}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Business knowledge sources</CardTitle>
            <CardDescription>
              Operational records that can be referenced. They are not automatically learned knowledge.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <SourceLine label="Services" count={source.sources.services.count} available={source.sources.services.available} />
            <SourceLine label="Completed jobs" count={source.sources.completedJobs.count} available={source.sources.completedJobs.available} />
            <SourceLine label="Approved estimates" count={source.sources.approvedEstimates.count} available={source.sources.approvedEstimates.available} />
            <SourceLine label="Recorded expenses" count={source.sources.expenses.count} available={source.sources.expenses.available} />
            <SourceLine label="Approved time entries" count={source.sources.approvedTime.count} available={source.sources.approvedTime.available} />
            <SourceLine label="Marketing content" count={source.sources.marketing.count} available={source.sources.marketing.available} />
            <SourceLine label="Reviews" count={source.sources.reviews.count} available={source.sources.reviews.available} />
            <p className="pt-1 text-xs text-muted-foreground">{source.takeoff.message}</p>
            {source.unapprovedTimePresent ? (
              <p className="text-xs text-muted-foreground">
                Running or unapproved time is not used as historical labor truth.
              </p>
            ) : null}
            {source.incompleteJobsPresent ? (
              <p className="text-xs text-muted-foreground">
                In-progress and scheduled jobs are not completed experience.
              </p>
            ) : null}
          </CardContent>
        </Card>
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Create knowledge</CardTitle>
            <CardDescription>The owner decides what becomes durable business knowledge.</CardDescription>
          </CardHeader>
          <CardContent>
            <KnowledgeCreateForm area="overview" source={source} />
          </CardContent>
        </Card>
      </FounderRegion>
    </>
  );
}

function CategoryBody({
  area,
  source,
}: {
  area: KnowledgeWorkspaceProps["area"];
  source: KnowledgeSource;
}) {
  return (
    <FounderRegion id="list">
      <Card>
        <CardHeader>
          <CardTitle>{KNOWLEDGE_AREA_LABELS[area]}</CardTitle>
          <CardDescription>{categoryDescription(area, source)}</CardDescription>
        </CardHeader>
      </Card>
      {area === "estimating" ? (
        <Card>
          <CardHeader>
            <CardTitle>Approved estimates</CardTitle>
            <CardDescription>Read-only source availability. Pricing is not inferred here.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {source.sources.approvedEstimatesList.length === 0 ? (
              <p className="text-muted-foreground">No approved estimates are available to reference.</p>
            ) : (
              source.sources.approvedEstimatesList.slice(0, 8).map((row) => (
                <div key={row.id} className="rounded-md border border-border/70 p-3">
                  <p className="font-medium">{row.scope}</p>
                  <p className="text-xs text-muted-foreground">
                    {row.status}
                    {row.total ? ` · ${formatMoney(row.total)}` : ""} · {formatDate(row.date)}
                    {row.relatedJobId ? ` · Job ${row.relatedJobStatus}` : ""}
                  </p>
                  <Button asChild size="sm" variant="ghost" className="mt-1 h-8 px-2">
                    <Link href={`/estimates/${row.id}`}>Open estimate</Link>
                  </Button>
                </div>
              ))
            )}
            <p className="text-xs text-muted-foreground">{TAKEOFF_UNAVAILABLE_MESSAGE}</p>
          </CardContent>
        </Card>
      ) : null}
      {area === "services" ? (
        <Card>
          <CardHeader>
            <CardTitle>Service catalog</CardTitle>
            <CardDescription>Existing services. Knowledge Hub does not change pricing.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {source.sources.servicesList.length === 0 ? (
              <p className="text-muted-foreground">No catalog services are recorded yet.</p>
            ) : (
              source.sources.servicesList.slice(0, 8).map((row) => (
                <div key={row.id} className="rounded-md border border-border/70 p-3">
                  <p className="font-medium">{row.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {row.category} · {row.pricingMode}
                    {row.price && row.pricingMode !== "CUSTOM_QUOTE"
                      ? ` · ${row.pricingMode === "FIXED" ? "Fixed" : "Starting at"} ${formatMoney(row.price)}`
                      : ""}
                  </p>
                </div>
              ))
            )}
            <Button asChild size="sm" variant="outline">
              <Link href="/services">Open services</Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}
      {area === "procedures" ? (
        <Card>
          <CardHeader>
            <CardTitle>Completed jobs</CardTitle>
            <CardDescription>Potential sources. Completed jobs are not auto-converted into knowledge.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {source.sources.completedJobsList.length === 0 ? (
              <p className="text-muted-foreground">No completed jobs are available to reference.</p>
            ) : (
              source.sources.completedJobsList.slice(0, 8).map((row) => (
                <div key={row.id} className="rounded-md border border-border/70 p-3">
                  <p className="font-medium">{row.work}</p>
                  <p className="text-xs text-muted-foreground">
                    {row.customerName} · {row.status} · {formatDate(row.completedAt)}
                  </p>
                  <Button asChild size="sm" variant="ghost" className="mt-1 h-8 px-2">
                    <Link href={`/jobs/${row.id}`}>Open job</Link>
                  </Button>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      ) : null}
      {area === "vendors" ? (
        <Card>
          <CardHeader>
            <CardTitle>Recorded expenses</CardTitle>
            <CardDescription>Vendor names are context only. No ratings or unit-cost conclusions.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {source.sources.expensesList.length === 0 ? (
              <p className="text-muted-foreground">No expenses are recorded yet.</p>
            ) : (
              source.sources.expensesList.slice(0, 8).map((row) => (
                <div key={row.id} className="rounded-md border border-border/70 p-3">
                  <p className="font-medium">{row.description}</p>
                  <p className="text-xs text-muted-foreground">
                    {row.vendor ?? "No vendor recorded"}
                    {row.amount ? ` · ${formatMoney(row.amount)}` : ""} · {row.category}
                  </p>
                </div>
              ))
            )}
            <Button asChild size="sm" variant="outline">
              <Link href="/expenses">Open expenses</Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}
      {area === "marketing" ? (
        <Card>
          <CardHeader>
            <CardTitle>Marketing foundation</CardTitle>
            <CardDescription>Read-only. Knowledge Hub does not alter or publish marketing content.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {source.sources.marketingList.length === 0 ? (
              <p className="text-muted-foreground">No marketing content is recorded yet.</p>
            ) : (
              source.sources.marketingList.slice(0, 8).map((row) => (
                <div key={row.id} className="rounded-md border border-border/70 p-3">
                  <p className="font-medium">{row.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {row.contentType} · {row.status}
                  </p>
                </div>
              ))
            )}
            <Button asChild size="sm" variant="outline">
              <Link href="/marketing">Open marketing</Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}
      {source.entries.length === 0 ? (
        <EmptyState
          title="No knowledge in this view"
          description="Create an owner-recorded entry, or clear search and filters."
        />
      ) : (
        source.entries.map((row) => <EntryCard key={row.id} entry={row} source={source} />)
      )}
      <Card>
        <CardHeader>
          <CardTitle>Create knowledge</CardTitle>
          <CardDescription>Require a title and useful notes. Tenant scope comes from the signed-in workspace.</CardDescription>
        </CardHeader>
        <CardContent>
          <KnowledgeCreateForm area={area} source={source} />
        </CardContent>
      </Card>
    </FounderRegion>
  );
}

function categoryDescription(area: KnowledgeWorkspaceProps["area"], source: KnowledgeSource) {
  if (area === "services") return "Service catalog is a reference. Knowledge about a service is separate from its price.";
  if (area === "estimating") return source.takeoff.message;
  if (area === "procedures") return "Reusable job procedures. Only completed jobs can be referenced as experience.";
  if (area === "policies") return "Reusable business policy. Individual customer notes are not auto-promoted.";
  if (area === "vendors") return "Owner-created vendor/material notes. Expenses provide context, not ratings.";
  if (area === "marketing") return "Brand voice, terminology, and marketing rules. Nothing is auto-published.";
  if (area === "safety") return "Distinguish owner procedure, verified external reference, and unverified notes.";
  if (area === "training") return "Internal how-to. MEMBER cannot access Knowledge Hub in this step.";
  return source.noAiMessage;
}

function SourceLine({
  label,
  count,
  available,
}: {
  label: string;
  count: number;
  available: boolean;
}) {
  return (
    <p>
      <span className="font-medium">{label}</span>
      {" · "}
      {available ? `${count} recorded` : "none recorded"}
    </p>
  );
}

function EntryCard({ entry, source }: { entry: KnowledgeEntryView; source: KnowledgeSource }) {
  const selected = source.selected?.id === entry.id;
  return (
    <Card className={cn(selected && "ring-1 ring-primary/40")}>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">{entry.title}</CardTitle>
            <CardDescription>
              {entry.categoryLabel} · {entry.sourceTypeLabel}
              {entry.archived ? " · Archived" : ""}
            </CardDescription>
          </div>
          <TrustBadge state={entry.trustState} />
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="line-clamp-3 text-muted-foreground">{entry.body}</p>
        <Button asChild size="sm" variant={selected ? "default" : "outline"}>
          <Link href={hrefWith(source, { selected: entry.id })}>Open detail</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function DetailCard({ source }: { source: KnowledgeSource }) {
  const entry = source.selected;
  if (!entry) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Knowledge detail</CardTitle>
          <CardDescription>Select an entry to review provenance and trust.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{entry.title}</CardTitle>
        <CardDescription>{entry.categoryLabel}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="flex flex-wrap gap-2">
          <TrustBadge state={entry.trustState} />
          <Badge variant="outline">{entry.sourceTypeLabel}</Badge>
          {entry.archived ? <Badge variant="outline">Archived</Badge> : null}
        </div>
        <p className="whitespace-pre-wrap">{entry.body}</p>
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>
            Source: {entry.sourceTypeLabel}
            {entry.sourceKindLabel ? ` · ${entry.sourceKindLabel}` : ""}
            {entry.sourceLabel ? ` · ${entry.sourceLabel}` : ""}
          </p>
          <p>Created {formatDateTime(entry.createdAt)}{entry.createdByName ? ` by ${entry.createdByName}` : ""}</p>
          <p>Updated {formatDateTime(entry.updatedAt)}</p>
          <p>
            Last reviewed{" "}
            {entry.lastReviewedAt
              ? `${formatDateTime(entry.lastReviewedAt)}${entry.lastReviewedByName ? ` by ${entry.lastReviewedByName}` : ""}`
              : "not yet"}
          </p>
        </div>
        {entry.referencedRecord ? (
          <div className="rounded-md border border-border/70 p-3">
            <p className="font-medium">{entry.referencedRecord.label}</p>
            <p className="text-xs text-muted-foreground">{entry.referencedRecord.detail}</p>
            {entry.referencedRecord.href ? (
              <Button asChild size="sm" variant="ghost" className="mt-1 h-8 px-2">
                <Link href={entry.referencedRecord.href}>Open source record</Link>
              </Button>
            ) : null}
          </div>
        ) : null}
        <KnowledgeReviewButton entryId={entry.id} />
        <KnowledgeArchiveButton entryId={entry.id} archived={entry.archived} />
        <KnowledgeEditForm entry={entry} />
      </CardContent>
    </Card>
  );
}

function NeedsReviewCard({ source }: { source: KnowledgeSource }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Needs review</CardTitle>
        <CardDescription>Entries marked Needs review or Conflict. Age does not invent staleness.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {source.needsReview.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing is flagged for review.</p>
        ) : (
          <ul className="space-y-2">
            {source.needsReview.slice(0, 6).map((row) => (
              <li key={row.id} className="rounded-md border border-border/70 p-2">
                <p className="font-medium">{row.title}</p>
                <p className="text-xs text-muted-foreground">
                  {row.trustLabel} · {row.categoryLabel}
                </p>
                <Button asChild size="sm" variant="ghost" className="mt-1 h-8 px-2">
                  <Link href={hrefWith(source, { selected: row.id, review: "needs-review" })}>Open</Link>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function LearningLoopCard({ source }: { source: KnowledgeSource }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Learning loop</CardTitle>
        <CardDescription>Foundation only. Unfinished stages do not operate today.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {source.learningLoop.map((step, index) => (
          <div key={step.id} className="rounded-md border border-border/70 px-3 py-2">
            <p className="font-medium">
              {index + 1}. {step.label}
            </p>
            <p className="text-xs text-muted-foreground">
              {LEARNING_LOOP_AVAILABILITY_LABELS[step.availability]}
              {step.id === "takeoff" || step.id === "actual-materials" ? ` · ${source.takeoff.message}` : ""}
            </p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

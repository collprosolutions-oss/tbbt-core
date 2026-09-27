import Link from "next/link";
import { PartnerVendorCreateForm } from "@/components/partner-vendor-directory/create-form";
import { PartnerVendorReviewForm } from "@/components/partner-vendor-directory/review-form";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import {
  DIRECTORY_KIND_LABELS,
  DIRECTORY_KINDS,
  DIRECTORY_REVIEW_LABELS,
  DIRECTORY_REVIEW_STATUSES,
  DIRECTORY_ROUTE,
  DIRECTORY_SOURCE_LABELS,
  DIRECTORY_SOURCES,
} from "@/lib/partner-vendor-directory";
import type { DirectoryOpportunityView, DirectoryWorkspace } from "@/lib/partner-vendor-directory";
import { cn } from "@/lib/utils";

function hrefWith(workspace: DirectoryWorkspace, patch: Record<string, string | undefined>) {
  const params = new URLSearchParams();
  const next = {
    q: workspace.query.q,
    kind: workspace.query.kind === "all" ? "" : workspace.query.kind,
    source: workspace.query.source === "all" ? "" : workspace.query.source,
    review: workspace.query.review === "all" ? "" : workspace.query.review,
    selected: workspace.query.selected,
    ...patch,
  };
  if (next.q) params.set("q", next.q);
  if (next.kind) params.set("kind", next.kind);
  if (next.source) params.set("source", next.source);
  if (next.review) params.set("review", next.review);
  if (next.selected) params.set("selected", next.selected);
  const query = params.toString();
  return query ? `${DIRECTORY_ROUTE}?${query}` : DIRECTORY_ROUTE;
}

function ReviewBadge({ opportunity }: { opportunity: DirectoryOpportunityView }) {
  const variant =
    opportunity.reviewStatus === "REVIEWED"
      ? "success"
      : opportunity.reviewStatus === "REJECTED"
        ? "destructive"
        : "warning";
  return <Badge variant={variant}>{opportunity.reviewLabel}</Badge>;
}

export function PartnerVendorDirectoryWorkspace({ workspace }: { workspace: DirectoryWorkspace }) {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)]">
      <div className="min-w-0 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Search this business</CardTitle>
            <CardDescription>{workspace.searchMessage}</CardDescription>
          </CardHeader>
          <CardContent>
            <form method="get" action={DIRECTORY_ROUTE} className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
              {workspace.query.selected ? (
                <input type="hidden" name="selected" value={workspace.query.selected} />
              ) : null}
              <label className="min-w-0 flex-1 text-xs text-muted-foreground">
                Search
                <input
                  name="q"
                  defaultValue={workspace.query.q}
                  placeholder="Name, notes, source, or linked record"
                  className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                />
              </label>
              <label className="text-xs text-muted-foreground">
                Kind
                <select
                  name="kind"
                  defaultValue={workspace.query.kind === "all" ? "" : workspace.query.kind}
                  className="mt-1 block w-full rounded-md border border-input bg-background px-2 py-2 text-sm text-foreground"
                >
                  <option value="">All kinds</option>
                  {DIRECTORY_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {DIRECTORY_KIND_LABELS[kind]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-muted-foreground">
                Source
                <select
                  name="source"
                  defaultValue={workspace.query.source === "all" ? "" : workspace.query.source}
                  className="mt-1 block w-full rounded-md border border-input bg-background px-2 py-2 text-sm text-foreground"
                >
                  <option value="">All sources</option>
                  {DIRECTORY_SOURCES.map((source) => (
                    <option key={source} value={source}>
                      {DIRECTORY_SOURCE_LABELS[source]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-muted-foreground">
                Review
                <select
                  name="review"
                  defaultValue={workspace.query.review === "all" ? "" : workspace.query.review}
                  className="mt-1 block w-full rounded-md border border-input bg-background px-2 py-2 text-sm text-foreground"
                >
                  <option value="">All review states</option>
                  {DIRECTORY_REVIEW_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {DIRECTORY_REVIEW_LABELS[status]}
                    </option>
                  ))}
                </select>
              </label>
              <Button type="submit" size="sm" variant="outline">
                Apply
              </Button>
            </form>
            <p className="pt-3 text-xs text-muted-foreground">{workspace.limitsMessage}</p>
            <p className="pt-1 text-xs text-muted-foreground">{workspace.linkMessage}</p>
            {workspace.overflow.opportunities || workspace.overflow.suppliers || workspace.overflow.referrals ? (
              <p className="pt-1 text-xs text-muted-foreground">{workspace.overflowMessage}</p>
            ) : null}
          </CardContent>
        </Card>

        <div className="grid gap-3 sm:grid-cols-4">
          <SummaryTile
            label={workspace.overflow.opportunities ? "Shown (capped)" : "Shown"}
            value={workspace.counts.total}
          />
          <SummaryTile label="Pending review" value={workspace.counts.pendingReview} />
          <SummaryTile label="Partners" value={workspace.counts.partners} />
          <SummaryTile label="Vendors" value={workspace.counts.vendors} />
        </div>

        {workspace.opportunities.length === 0 ? (
          <EmptyState
            title="No opportunities match"
            description="Record a partner or vendor opportunity for this business, or clear search filters. Nothing here is shared across businesses."
          />
        ) : (
          <div className="space-y-2">
            {workspace.overflow.opportunities ? (
              <p className="text-xs text-muted-foreground">
                Showing {workspace.opportunities.length} matching opportunities, capped at{" "}
                {workspace.readLimit}. More matching records may exist in this business.
              </p>
            ) : null}
            {workspace.opportunities.map((opportunity) => {
              const active = workspace.selected?.id === opportunity.id;
              return (
                <Link
                  key={opportunity.id}
                  href={hrefWith(workspace, { selected: opportunity.id })}
                  className={cn(
                    "block rounded-xl border px-4 py-3 transition-colors",
                    active ? "border-primary bg-primary/5" : "border-border hover:bg-accent/40",
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-foreground">{opportunity.name}</p>
                    <Badge variant="outline">{opportunity.kindLabel}</Badge>
                    <Badge variant="secondary">{opportunity.sourceLabel}</Badge>
                    <ReviewBadge opportunity={opportunity} />
                  </div>
                  {opportunity.summary ? (
                    <p className="mt-1 text-sm text-muted-foreground">{opportunity.summary}</p>
                  ) : null}
                  {opportunity.supplierName ? (
                    <p className="mt-1 text-xs text-muted-foreground">Linked supplier: {opportunity.supplierName}</p>
                  ) : null}
                  {opportunity.referralLabel ? (
                    <p className="mt-1 text-xs text-muted-foreground">Linked {opportunity.referralLabel}</p>
                  ) : null}
                </Link>
              );
            })}
          </div>
        )}
      </div>

      <div className="min-w-0 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Record opportunity</CardTitle>
            <CardDescription>
              Owner-managed notes for this workspace only. Existing Supplier and Referral rows can
              be reused when they already belong here.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PartnerVendorCreateForm workspace={workspace} />
          </CardContent>
        </Card>

        {workspace.selected ? (
          <Card>
            <CardHeader>
              <CardTitle>{workspace.selected.name}</CardTitle>
              <CardDescription>
                {workspace.selected.kindLabel} · {workspace.selected.sourceLabel} · updated{" "}
                {formatDateTime(workspace.selected.updatedAt)}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {workspace.selected.summary ? <p>{workspace.selected.summary}</p> : null}
              {workspace.selected.notes ? (
                <p className="text-muted-foreground">{workspace.selected.notes}</p>
              ) : null}
              {workspace.selected.supplierName ? (
                <p>Linked supplier: {workspace.selected.supplierName}</p>
              ) : null}
              {workspace.selected.referralLabel ? <p>Linked {workspace.selected.referralLabel}</p> : null}
              {workspace.selected.category ? <p>Category: {workspace.selected.category}</p> : null}
              {workspace.selected.locationDescription ? (
                <p>Location: {workspace.selected.locationDescription}</p>
              ) : null}
              <PartnerVendorReviewForm opportunity={workspace.selected} />
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

function SummaryTile({ label, value }: { label: string; value: number }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle>{value}</CardTitle>
      </CardHeader>
    </Card>
  );
}

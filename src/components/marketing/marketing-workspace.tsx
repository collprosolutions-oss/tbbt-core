import Link from "next/link";
import { ContentStatusButton } from "@/components/marketing/content-status-button";
import { CreateContentForm } from "@/components/marketing/create-content-form";
import { PhotoPermissionButton } from "@/components/marketing/photo-permission-button";
import { PlannedDateForm } from "@/components/marketing/planned-date-form";
import type { MarketingWorkspaceProps } from "@/components/marketing/types";
import { EmptyState } from "@/components/empty-state";
import { FounderRegion } from "@/components/founder-design/region";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate } from "@/lib/format";
import { formatISODate } from "@/lib/schedule";
import {
  CALENDAR_INTERNAL_MESSAGE,
  COMING_NEXT_MESSAGE,
  MARKETING_AREA_LABELS,
  MARKETING_AREAS,
  MARKETING_CHANNEL_LABELS,
  MARKETING_CONTENT_TYPE_LABELS,
  MARKETING_READINESS_LABELS,
  isImplementedMarketingArea,
  type MarketingArea,
  type MarketingChannel,
  type MarketingContentType,
} from "@/lib/marketing";
import { cn } from "@/lib/utils";

export function MarketingWorkspace({ area, source }: MarketingWorkspaceProps) {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_var(--tbbt-panel-width,300px)]">
      <div className="min-w-0 space-y-4">
        <FounderRegion id="nav" className="tbbt-founder-box">
          <nav className="flex flex-wrap items-center gap-1.5 overflow-x-auto border-b border-border/60 pb-3">
            {MARKETING_AREAS.map((item) => {
              const query = item === "overview" ? "" : `?area=${item}`;
              const active = item === area;
              return (
                <Link
                  key={item}
                  href={`/marketing${query}`}
                  className={cn(
                    "rounded-md border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors",
                    active
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  {MARKETING_AREA_LABELS[item]}
                </Link>
              );
            })}
          </nav>
          <p className="pt-2 text-xs text-muted-foreground">{source.channels.message}</p>
        </FounderRegion>

        <FounderRegion id="opportunities">
          {area === "grow" || area === "overview" || area === "completed-jobs" ? (
            <OpportunityBody area={area} source={source} />
          ) : null}
        </FounderRegion>

        <FounderRegion id="content">
          {area === "create-content" ||
          area === "social-posts" ||
          area === "overview" ||
          area === "brand-library" ||
          area === "lead-sources" ||
          !isImplementedMarketingArea(area) ? (
            <ContentBody area={area} source={source} />
          ) : null}
        </FounderRegion>

        <FounderRegion id="calendar">
          {area === "calendar" || area === "overview" ? <CalendarBody source={source} compact={area === "overview"} /> : null}
        </FounderRegion>
      </div>

      <FounderRegion id="rail" className="min-w-0">
        <Card>
          <CardHeader>
            <CardTitle>Growth opportunities</CardTitle>
            <CardDescription>From recorded TBBT jobs and content only.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>{source.counts.readyOpportunities} completed job{source.counts.readyOpportunities === 1 ? "" : "s"} with marketing-approved photos.</p>
            <p>{source.counts.needsPermission} completed job{source.counts.needsPermission === 1 ? "" : "s"} still need photo permission.</p>
            <p>{source.counts.awaitingReview} item{source.counts.awaitingReview === 1 ? "" : "s"} awaiting owner review.</p>
            <p className="text-xs text-muted-foreground">Review / referral follow-up is a later module. Not built here.</p>
            <Button asChild size="sm" variant="outline">
              <Link href="/marketing?area=grow">Open Grow My Business</Link>
            </Button>
          </CardContent>
        </Card>
      </FounderRegion>
    </div>
  );
}

function OpportunityBody({
  area,
  source,
}: {
  area: MarketingArea;
  source: MarketingWorkspaceProps["source"];
}) {
  if (area === "grow") {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Grow My Business</CardTitle>
            <CardDescription>Opportunities from recorded completed jobs and content. Nothing here is invented.</CardDescription>
          </CardHeader>
        </Card>
        <JobOpportunityList
          title="Ready to turn into content"
          empty="No completed jobs have marketing-approved photos yet."
          rows={source.grow.readyJobs}
        />
        <JobOpportunityList
          title="Need marketing permission"
          empty="No completed jobs are waiting on photo permission."
          rows={source.grow.needsPermission}
        />
        <Card>
          <CardHeader>
            <CardTitle>Reviews &amp; referrals</CardTitle>
            <CardDescription>Future opportunity only. The Reviews module is not built in this step.</CardDescription>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Services with little or no marketing content</CardTitle>
            <CardDescription>Active catalog services that have no marketing content linked through a completed job.</CardDescription>
          </CardHeader>
          <CardContent>
            {source.grow.servicesWithoutContent.length === 0 ? (
              <p className="text-sm text-muted-foreground">Every active service has at least one linked content record, or no catalog is on file.</p>
            ) : (
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {source.grow.servicesWithoutContent.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <JobOpportunityList
      title={area === "overview" ? "Completed jobs for marketing" : "Completed jobs"}
      empty="No completed jobs are on file for this business."
      rows={source.opportunities}
      showPhotos={area === "completed-jobs"}
    />
  );
}

function JobOpportunityList({
  title,
  empty,
  rows,
  showPhotos = false,
}: {
  title: string;
  empty: string;
  rows: MarketingWorkspaceProps["source"]["opportunities"];
  showPhotos?: boolean;
}) {
  if (rows.length === 0) {
    return <EmptyState title={title} description={empty} />;
  }

  return (
    <div className="space-y-3">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="grid gap-3">
        {rows.map((row) => (
          <Card key={row.jobId}>
            <CardHeader>
              <CardTitle className="text-base">{row.workPerformed}</CardTitle>
              <CardDescription>
                Internal job context · {row.customerName} · last updated {formatDate(row.lastUpdated)}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm">{MARKETING_READINESS_LABELS[row.readiness]}</p>
              <p className="text-xs text-muted-foreground">
                {row.approvedPhotoCount} of {row.photoCount} photo{row.photoCount === 1 ? "" : "s"} approved for marketing.
              </p>
              {showPhotos ? (
                <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {row.photos.map((photo) => (
                    <li key={photo.id} className="space-y-2 rounded-lg border border-border/70 p-2">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={photo.url} alt={photo.caption ?? ""} className="h-28 w-full rounded-md object-cover" />
                      <p className="text-xs text-muted-foreground">{photo.stage}</p>
                      <StatusBadge status={photo.marketingPermissionStatus === "APPROVED" ? "APPROVED" : "PRIVATE"} />
                      <PhotoPermissionButton
                        photoId={photo.id}
                        approved={photo.marketingPermissionStatus === "APPROVED"}
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button asChild size="sm" variant="outline">
                  <Link href={row.href}>Open job</Link>
                </Button>
                <Button asChild size="sm">
                  <Link href={`/marketing?area=create-content`}>Create content</Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function ContentBody({
  area,
  source,
}: {
  area: MarketingArea;
  source: MarketingWorkspaceProps["source"];
}) {
  if (!isImplementedMarketingArea(area)) {
    return (
      <EmptyState
        title={MARKETING_AREA_LABELS[area]}
        description={`${COMING_NEXT_MESSAGE} ${source.performance.message}`}
      />
    );
  }

  if (area === "create-content") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Create content</CardTitle>
          <CardDescription>
            Manual draft only. No AI provider is required. Only marketing-approved photos can be attached.
            Do not put customer contact details or private notes in the caption.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateContentForm source={source} />
        </CardContent>
      </Card>
    );
  }

  if (area === "brand-library") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Brand library</CardTitle>
          <CardDescription>References the existing Business record. This is not a second business profile.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>
            <span className="text-muted-foreground">Business name · </span>
            {source.brand.name}
          </p>
          <p>
            <span className="text-muted-foreground">Trade · </span>
            {source.brand.tradeLabel}
          </p>
          <div>
            <p className="text-muted-foreground">Logo on file</p>
            {source.brand.logoSrc ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={source.brand.logoSrc} alt="" className="mt-2 h-16 w-auto" />
            ) : (
              <p>No logo is stored on the Business record yet.</p>
            )}
          </div>
          <p>Service area is not stored on the Business record.</p>
          <p>Business description / tagline is not stored on the Business record.</p>
          <p>Public marketing contact is not stored on the Business record.</p>
        </CardContent>
      </Card>
    );
  }

  if (area === "lead-sources") {
    return (
      <EmptyState title="Lead sources" description={source.leadSources.message} />
    );
  }

  const rows =
    area === "social-posts"
      ? source.contents.filter((row) => row.status === "APPROVED")
      : source.contents;

  return (
    <div className="space-y-3">
      {area === "social-posts" ? (
        <Card>
          <CardHeader>
            <CardTitle>Social-ready posts</CardTitle>
            <CardDescription>{source.channels.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState
          title={area === "social-posts" ? "Approved posts" : "Marketing content"}
          description={
            area === "social-posts"
              ? "No approved social-ready posts yet."
              : "No marketing content drafts yet."
          }
        />
      ) : (
        rows.map((row) => (
          <Card key={row.id}>
            <CardHeader>
              <CardTitle className="text-base">{row.title}</CardTitle>
              <CardDescription>
                {MARKETING_CONTENT_TYPE_LABELS[row.contentType as MarketingContentType] ?? row.contentType}
                {" · "}
                {MARKETING_CHANNEL_LABELS[row.channelIntent as MarketingChannel] ?? row.channelIntent}
                {" · "}
                {formatDate(row.createdAt)}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <StatusBadge status={row.status} />
              {row.body ? <p className="whitespace-pre-wrap text-sm">{row.body}</p> : <p className="text-sm text-muted-foreground">No caption entered.</p>}
              {row.jobId ? (
                <p className="text-xs text-muted-foreground">
                  Source job on file{row.jobCustomerName ? " (internal context only)" : ""}.
                </p>
              ) : null}
              {row.photos.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {row.photos.map((photo) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={photo.id} src={photo.url} alt="" className="h-20 w-20 rounded-md object-cover" />
                  ))}
                </div>
              ) : null}
              <ContentStatusButton contentId={row.id} status={row.status} />
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

function CalendarBody({
  source,
  compact,
}: {
  source: MarketingWorkspaceProps["source"];
  compact?: boolean;
}) {
  const dated = source.contents.filter((row) => row.plannedFor);
  const items = compact ? dated.slice(0, 4) : source.contents;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Content calendar</CardTitle>
        <CardDescription>{CALENDAR_INTERNAL_MESSAGE}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No marketing content has an internal planning date yet.</p>
        ) : (
          items.map((row) => (
            <div key={row.id} className="space-y-2 rounded-lg border border-border/70 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">{row.title}</p>
                <StatusBadge status={row.status} />
              </div>
              <p className="text-xs text-muted-foreground">
                {row.plannedFor ? `Planned ${formatDate(row.plannedFor)}` : "No planned date"}
              </p>
              {!compact ? (
                <PlannedDateForm
                  contentId={row.id}
                  plannedFor={row.plannedFor ? formatISODate(row.plannedFor) : ""}
                />
              ) : null}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

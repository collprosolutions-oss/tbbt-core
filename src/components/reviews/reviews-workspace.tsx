import Link from "next/link";
import { PrepareRequestForm } from "@/components/reviews/prepare-request-form";
import { RecordReviewForm } from "@/components/reviews/record-review-form";
import { RecordStandaloneReviewForm } from "@/components/reviews/record-standalone-review-form";
import { RecoveryNotesForm } from "@/components/reviews/recovery-notes-form";
import { ReminderDateForm } from "@/components/reviews/reminder-date-form";
import { RequestEditForm } from "@/components/reviews/request-edit-form";
import { RequestStatusButton } from "@/components/reviews/request-status-button";
import { ResponseForm } from "@/components/reviews/response-form";
import { ResponseStatusButton } from "@/components/reviews/response-status-button";
import type { ReviewsWorkspaceProps } from "@/components/reviews/types";
import { EmptyState } from "@/components/empty-state";
import { FounderRegion } from "@/components/founder-design/region";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate, formatMoney } from "@/lib/format";
import { formatISODate } from "@/lib/schedule";
import {
  MARKETING_LINK_MESSAGE,
  NO_REVIEW_GATING_MESSAGE,
  PERFORMANCE_INTERNAL_MESSAGE,
  REQUEST_SEND_DISCLAIMER,
  REQUEST_WORKFLOW_LABELS,
  RESPONSE_PUBLISH_DISCLAIMER,
  REVIEW_AREA_LABELS,
  REVIEW_AREAS,
  REVIEW_PLATFORM_LABELS,
  REVIEW_RECEIVED_PLATFORM_LABELS,
  suggestedRequestText,
  suggestedResponseText,
  type ReviewArea,
  type ReviewPlatform,
  type ReviewReceivedPlatform,
} from "@/lib/reviews";
import { cn } from "@/lib/utils";

export function ReviewsWorkspace({ area, source }: ReviewsWorkspaceProps) {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_var(--tbbt-panel-width,300px)]">
      <div className="min-w-0 space-y-4">
        <FounderRegion id="nav" className="tbbt-founder-box">
          <nav className="flex flex-wrap items-center gap-1.5 overflow-x-auto border-b border-border/60 pb-3">
            {REVIEW_AREAS.map((item) => {
              const query = item === "overview" ? "" : `?area=${item}`;
              const active = item === area;
              return (
                <Link
                  key={item}
                  href={`/reviews${query}`}
                  className={cn(
                    "rounded-md border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors",
                    active
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  {REVIEW_AREA_LABELS[item]}
                </Link>
              );
            })}
          </nav>
          <p className="pt-2 text-xs text-muted-foreground">{source.platforms.message}</p>
        </FounderRegion>

        <FounderRegion id="opportunities">
          {area === "overview" || area === "opportunities" ? (
            <OpportunityBody area={area} source={source} />
          ) : null}
        </FounderRegion>

        <FounderRegion id="requests">
          {area === "overview" || area === "requests" ? (
            <RequestBody area={area} source={source} />
          ) : null}
        </FounderRegion>

        <FounderRegion id="reviews">
          {area === "overview" || area === "reviews" || area === "responses" || area === "performance" ? (
            <ReviewBody area={area} source={source} />
          ) : null}
        </FounderRegion>
      </div>

      <FounderRegion id="rail" className="min-w-0">
        <Card>
          <CardHeader>
            <CardTitle>Needs attention</CardTitle>
            <CardDescription>From recorded TBBT review activity only.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>{source.counts.opportunities} completed job{source.counts.opportunities === 1 ? "" : "s"} ready for a review request.</p>
            <p>{source.counts.awaitingAction} request{source.counts.awaitingAction === 1 ? "" : "s"} awaiting owner action.</p>
            <p>{source.counts.followUpsDue} follow-up{source.counts.followUpsDue === 1 ? "" : "s"} due.</p>
            <p>{source.counts.responsesNeedingAttention} review{source.counts.responsesNeedingAttention === 1 ? "" : "s"} flagged for attention.</p>
            {source.attention.length === 0 ? (
              <p className="text-xs text-muted-foreground">No low-rating reviews are waiting on recovery.</p>
            ) : (
              <ul className="space-y-2">
                {source.attention.slice(0, 4).map((row) => (
                  <li key={row.id} className="rounded-md border border-border/70 p-2">
                    <p className="font-medium">{row.customerName}</p>
                    <p className="text-xs text-muted-foreground">
                      {row.rating ? `${row.rating}★ recorded` : "No rating"} · {row.responseStatus}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            <Button asChild size="sm" variant="outline">
              <Link href="/reviews?area=responses">Open responses</Link>
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
  area: ReviewArea;
  source: ReviewsWorkspaceProps["source"];
}) {
  const rows = area === "overview" ? source.openOpportunities.slice(0, 4) : source.opportunities;
  return (
    <div className="space-y-3">
      <Card>
        <CardHeader>
          <CardTitle>{area === "overview" ? "Review opportunities" : "Completed jobs"}</CardTitle>
          <CardDescription>{NO_REVIEW_GATING_MESSAGE}</CardDescription>
        </CardHeader>
      </Card>
      {rows.length === 0 ? (
        <EmptyState
          title="No review opportunities"
          description="Completed customer jobs appear here. In-progress jobs are not review opportunities."
        />
      ) : (
        rows.map((row) => (
          <Card key={row.jobId}>
            <CardHeader>
              <CardTitle className="text-base">{row.workPerformed}</CardTitle>
              <CardDescription>
                {row.customerName} · completed {formatDate(row.completedAt)}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p>
                Invoice:{" "}
                {row.invoice
                  ? `${row.invoice.status}${row.invoice.paidAt ? ` · paid ${formatDate(row.invoice.paidAt)}` : ""} · ${formatMoney(row.invoice.total)}`
                  : "None on file"}
              </p>
              <p>{REQUEST_WORKFLOW_LABELS[row.workflowState]}</p>
              <p className="text-xs text-muted-foreground">Recommended next action: {row.nextActionLabel}</p>
              <div className="flex flex-wrap gap-2">
                <Button asChild size="sm" variant="outline">
                  <Link href={row.href}>Open job</Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link href={`/customers/${row.customerId}`}>Open customer</Link>
                </Button>
              </div>
              {area === "opportunities" && (!row.requestId || row.requestStatus === "CANCELLED") ? (
                <PrepareRequestForm
                  customerId={row.customerId}
                  jobId={row.jobId}
                  requestText={suggestedRequestText({
                    customerName: row.customerName,
                    businessName: source.businessName,
                  })}
                />
              ) : null}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

function RequestBody({
  area,
  source,
}: {
  area: ReviewArea;
  source: ReviewsWorkspaceProps["source"];
}) {
  const rows = area === "overview" ? source.requests.slice(0, 4) : source.requests;
  return (
    <div className="space-y-3">
      <Card>
        <CardHeader>
          <CardTitle>Review requests</CardTitle>
          <CardDescription>{REQUEST_SEND_DISCLAIMER}</CardDescription>
        </CardHeader>
      </Card>
      {rows.length === 0 ? (
        <EmptyState title="No review requests" description="Prepare a request from a completed job opportunity." />
      ) : (
        rows.map((row) => (
          <Card key={row.id}>
            <CardHeader>
              <CardTitle className="text-base">{row.customerName}</CardTitle>
              <CardDescription>
                {REVIEW_PLATFORM_LABELS[row.intendedPlatform as ReviewPlatform] ?? row.intendedPlatform}
                {" · "}
                {formatDate(row.createdAt)}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={row.status} />
                <span className="text-xs text-muted-foreground">{row.workflowLabel}</span>
              </div>
              {row.requestedAt ? (
                <p className="text-xs text-muted-foreground">Recorded as sent {formatDate(row.requestedAt)}</p>
              ) : (
                <p className="text-xs text-muted-foreground">Not recorded as sent yet.</p>
              )}
              {area === "requests" ? (
                <>
                  <p className="whitespace-pre-wrap text-sm">{row.requestText}</p>
                  {row.status !== "COMPLETED" && row.status !== "CANCELLED" ? (
                    <>
                      <RequestEditForm
                        requestId={row.id}
                        intendedPlatform={row.intendedPlatform}
                        requestText={row.requestText}
                        notes={row.notes ?? ""}
                      />
                      <ReminderDateForm
                        requestId={row.id}
                        reminderAt={row.reminderAt ? formatISODate(row.reminderAt) : ""}
                      />
                    </>
                  ) : null}
                  <RequestStatusButton requestId={row.id} status={row.status} />
                  {!row.hasReview && row.status !== "CANCELLED" ? (
                    <RecordReviewForm
                      customerId={row.customerId}
                      jobId={row.jobId}
                      reviewRequestId={row.id}
                    />
                  ) : null}
                </>
              ) : (
                <Button asChild size="sm" variant="outline">
                  <Link href="/reviews?area=requests">Open requests</Link>
                </Button>
              )}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

function ReviewBody({
  area,
  source,
}: {
  area: ReviewArea;
  source: ReviewsWorkspaceProps["source"];
}) {
  if (area === "performance") {
    const { performance } = source;
    return (
      <Card>
        <CardHeader>
          <CardTitle>TBBT-recorded activity</CardTitle>
          <CardDescription>{PERFORMANCE_INTERNAL_MESSAGE}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>Requests recorded as sent: {performance.requestsRecordedAsSent}</p>
          <p>Reviews recorded as received: {performance.reviewsRecorded}</p>
          <p>Responses approved internally: {performance.responsesApproved}</p>
          <p>Follow-ups currently due: {performance.followUpsDue}</p>
          <p>
            Request-to-review rate:{" "}
            {performance.requestToReviewRate === null
              ? "Not calculated — no sent requests on file."
              : `${performance.requestToReviewRate}% of recorded-sent requests`}
          </p>
          <p>
            Response completion:{" "}
            {performance.responseCompletionRate === null
              ? "Not calculated — no recorded reviews on file."
              : `${performance.responseCompletionRate}% of recorded reviews`}
          </p>
          <p className="text-xs text-muted-foreground">{source.platforms.message}</p>
        </CardContent>
      </Card>
    );
  }

  const rows =
    area === "responses"
      ? source.reviews.filter((row) => row.needsAttention || row.responseStatus !== "APPROVED")
      : area === "overview"
        ? source.reviews.slice(0, 4)
        : source.reviews;

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader>
          <CardTitle>{area === "responses" ? "Responses" : "Recorded reviews"}</CardTitle>
          <CardDescription>
            {area === "responses" ? RESPONSE_PUBLISH_DISCLAIMER : MARKETING_LINK_MESSAGE}
          </CardDescription>
        </CardHeader>
      </Card>
      {area === "reviews" ? (
        <Card>
          <CardHeader>
            <CardTitle>Record a review received elsewhere</CardTitle>
            <CardDescription>Owner-entered only. TBBT does not import Google or Facebook reviews.</CardDescription>
          </CardHeader>
          <CardContent>
            <RecordStandaloneReviewForm source={source} />
          </CardContent>
        </Card>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState
          title={area === "responses" ? "No responses needing work" : "No reviews recorded"}
          description={
            area === "responses"
              ? "Low-rating reviews and unfinished responses appear here."
              : "Record a review after a customer leaves one externally."
          }
        />
      ) : (
        rows.map((row) => (
          <Card key={row.id} className={row.needsAttention ? "border-destructive/40" : undefined}>
            <CardHeader>
              <CardTitle className="text-base">{row.customerName}</CardTitle>
              <CardDescription>
                {REVIEW_RECEIVED_PLATFORM_LABELS[row.platform as ReviewReceivedPlatform] ?? row.platform}
                {row.rating ? ` · ${row.rating}★` : " · no rating recorded"}
                {" · "}
                {formatDate(row.externalReviewDate ?? row.createdAt)}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex flex-wrap gap-2">
                <StatusBadge status={row.responseStatus} />
                {row.needsAttention ? <StatusBadge status="NEEDS_ATTENTION" /> : null}
              </div>
              {row.reviewText ? <p className="whitespace-pre-wrap">{row.reviewText}</p> : <p className="text-muted-foreground">No review text recorded.</p>}
              {row.externalUrl ? (
                <p className="text-xs text-muted-foreground">External URL on file (not fetched).</p>
              ) : null}
              {row.mayBeMarketingEligible ? (
                <p className="text-xs text-muted-foreground">{MARKETING_LINK_MESSAGE}</p>
              ) : null}
              {row.jobId ? (
                <Button asChild size="sm" variant="outline">
                  <Link href={`/jobs/${row.jobId}`}>Open job</Link>
                </Button>
              ) : null}
              {area !== "overview" ? (
                <>
                  {row.needsAttention ? (
                    <RecoveryNotesForm reviewId={row.id} recoveryNotes={row.recoveryNotes ?? ""} />
                  ) : null}
                  <ResponseForm reviewId={row.id} body={row.response?.body ?? suggestedResponseText()} />
                  {row.response ? <ResponseStatusButton responseId={row.response.id} status={row.response.status} /> : null}
                </>
              ) : (
                <Button asChild size="sm" variant="outline">
                  <Link href="/reviews?area=reviews">Open reviews</Link>
                </Button>
              )}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}


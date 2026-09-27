import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate } from "@/lib/format";
import {
  RETENTION_GROUP_TITLES,
  type RetentionCandidate,
  type RetentionFollowUpRow,
  type RetentionJourneyRow,
  type RetentionWorkspace,
} from "@/lib/growth/retention";

export function RetentionCenter({ workspace }: { workspace: RetentionWorkspace }) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Kpi label={RETENTION_GROUP_TITLES.NO_REVIEW_REQUEST} value={workspace.totals.noReviewRequest} />
        <Kpi label={RETENTION_GROUP_TITLES.NO_LATER_JOB} value={workspace.totals.noLaterJob} />
        <Kpi label={RETENTION_GROUP_TITLES.RECORDED_FOLLOW_UP} value={workspace.totals.recordedFollowUp} />
        <Kpi label={RETENTION_GROUP_TITLES.NO_REFERRAL_REQUEST} value={workspace.totals.noReferralRequest} />
        <Kpi label={RETENTION_GROUP_TITLES.INCOMPLETE_JOURNEY} value={workspace.totals.incompleteJourney} />
      </div>
      <p className="text-xs text-muted-foreground">
        Showing up to {workspace.candidateLimit} candidates per group. Absence of a review request or
        later job is checked for each shown record against this business, not inferred from the
        truncated list. Business timezone: {workspace.timeZone}.
      </p>

      <CandidateGroup
        title={RETENTION_GROUP_TITLES.NO_REVIEW_REQUEST}
        description={workspace.groups.noReviewRequest[0]?.fact}
        rows={workspace.groups.noReviewRequest}
        timeZone={workspace.timeZone}
        empty="No completed jobs without a same-business ReviewRequest in this window."
      />
      <CandidateGroup
        title={RETENTION_GROUP_TITLES.NO_LATER_JOB}
        description={workspace.groups.noLaterJob[0]?.fact}
        rows={workspace.groups.noLaterJob}
        timeZone={workspace.timeZone}
        empty="No past customers with a completed job and no later same-business Job in this window."
      />
      <FollowUpGroup rows={workspace.groups.recordedFollowUp} />
      <CandidateGroup
        title={RETENTION_GROUP_TITLES.NO_REFERRAL_REQUEST}
        description={workspace.groups.noReferralRequest[0]?.fact}
        rows={workspace.groups.noReferralRequest}
        timeZone={workspace.timeZone}
        empty="No completed jobs without a same-business ReferralRequest in this window."
      />
      <JourneyGroup rows={workspace.groups.incompleteJourney} />
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border/70 bg-card p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold">{value}</p>
    </div>
  );
}

function CandidateGroup({
  title,
  description,
  rows,
  timeZone,
  empty,
}: {
  title: string;
  description?: string;
  rows: RetentionCandidate[];
  timeZone: string;
  empty: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.length === 0 ? <EmptyState title="None recorded" description={empty} /> : null}
        {rows.map((row) => (
          <article key={`${row.group}-${row.lastCompletedJobId}`} className="rounded-md border border-border/60 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">{row.customerName}</p>
              {row.lastCompletedAgeLabel ? (
                <Badge variant="outline">{row.lastCompletedAgeLabel}</Badge>
              ) : (
                <Badge variant="outline">Completed date is not recorded as a JOB_COMPLETED event</Badge>
              )}
            </div>
            <dl className="mt-2 grid grid-cols-1 gap-1 text-sm text-muted-foreground sm:grid-cols-2">
              <div>Completed jobs recorded: {row.completedJobCount}</div>
              <div>
                Later job recorded: {row.laterJobRecorded ? "Yes" : "No"}
              </div>
              <div>
                Last completed job date:{" "}
                {row.lastCompletedAt ? formatDate(row.lastCompletedAt, timeZone) : "Not recorded"}
              </div>
              <div>Last invoice status: {row.lastInvoiceStatus ?? "None recorded"}</div>
              <div>Last review-request status: {row.lastReviewRequestStatus ?? "None recorded"}</div>
              <div>
                Last follow-up status:{" "}
                {row.lastFollowUpStatus
                  ? `${row.lastFollowUpStatus}${row.lastFollowUpKind ? ` (${row.lastFollowUpKind})` : ""}`
                  : "None recorded"}
              </div>
            </dl>
            <LinkRow links={row.links} />
          </article>
        ))}
      </CardContent>
    </Card>
  );
}

function FollowUpGroup({ rows }: { rows: RetentionFollowUpRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{RETENTION_GROUP_TITLES.RECORDED_FOLLOW_UP}</CardTitle>
        <CardDescription>
          {rows[0]?.fact ??
            "CustomerFollowUp status is the recorded row status. SENT is not delivery."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.length === 0 ? (
          <EmptyState title="None recorded" description="No CustomerFollowUp rows are on file in this window." />
        ) : null}
        {rows.map((row) => (
          <article key={row.followUpId} className="rounded-md border border-border/60 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">{row.customerName}</p>
              <Badge variant="outline">{row.statusLabel}</Badge>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              Kind: {row.kind}. Recorded status: {row.statusLabel}.
            </p>
            <LinkRow links={row.links} />
          </article>
        ))}
      </CardContent>
    </Card>
  );
}

function JourneyGroup({ rows }: { rows: RetentionJourneyRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{RETENTION_GROUP_TITLES.INCOMPLETE_JOURNEY}</CardTitle>
        <CardDescription>
          {rows[0]?.fact ??
            "These are the same Growth recovery queues already defined for incomplete recorded journeys."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.length === 0 ? (
          <EmptyState
            title="None recorded"
            description="No incomplete Growth recovery-queue items in this bounded window."
          />
        ) : null}
        {rows.map((row) => (
          <article
            key={`${row.queue}-${row.requestId ?? ""}-${row.estimateId ?? ""}`}
            className="rounded-md border border-border/60 p-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">{row.customerName}</p>
              <Badge variant="secondary">{row.queueLabel}</Badge>
            </div>
            <LinkRow links={row.links} />
          </article>
        ))}
      </CardContent>
    </Card>
  );
}

function LinkRow({ links }: { links: { href: string; label: string }[] }) {
  if (links.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-3 text-sm">
      {links.map((link) => (
        <Link key={`${link.href}-${link.label}`} href={link.href} className="text-primary underline-offset-4 hover:underline">
          {link.label}
        </Link>
      ))}
    </div>
  );
}

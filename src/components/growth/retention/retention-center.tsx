import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  recordRetentionFollowUpTaskAction,
  resolveRetentionFollowUpTaskStatusAction,
} from "@/app/actions/retention";
import { formatDate } from "@/lib/format";
import {
  RETENTION_FOLLOW_UP_FINDING_GROUPS,
  RETENTION_GROUP_TITLES,
  RETENTION_OWNER_FOLLOW_UP_MESSAGE,
  RETENTION_OWNER_RESOLVE_FOLLOW_UP_MESSAGE,
  isRetentionFollowUpTask,
  type RetentionCandidate,
  type RetentionFollowUpFindingGroup,
  type RetentionFollowUpRow,
  type RetentionJourneyRow,
  type RetentionWorkspace,
} from "@/lib/growth/retention";

export function RetentionCenter({
  workspace,
  canRecordFollowUp = false,
  canResolveFollowUp = false,
}: {
  workspace: RetentionWorkspace;
  canRecordFollowUp?: boolean;
  canResolveFollowUp?: boolean;
}) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Kpi label={RETENTION_GROUP_TITLES.NO_REVIEW_REQUEST} value={workspace.totals.noReviewRequest} />
        <Kpi label={RETENTION_GROUP_TITLES.NO_LATER_JOB} value={workspace.totals.noLaterJob} />
        <Kpi label={RETENTION_GROUP_TITLES.RECORDED_FOLLOW_UP} value={workspace.totals.recordedFollowUp} />
        <Kpi label={RETENTION_GROUP_TITLES.DUE_OR_OVERDUE} value={workspace.totals.dueOrOverdue} />
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
        canRecordFollowUp={canRecordFollowUp}
      />
      <CandidateGroup
        title={RETENTION_GROUP_TITLES.NO_LATER_JOB}
        description={workspace.groups.noLaterJob[0]?.fact}
        rows={workspace.groups.noLaterJob}
        timeZone={workspace.timeZone}
        empty="No past customers with a completed job and no later same-business Job in this window."
        canRecordFollowUp={canRecordFollowUp}
      />
      <FollowUpGroup
        rows={workspace.groups.recordedFollowUp}
        timeZone={workspace.timeZone}
        canResolveFollowUp={canResolveFollowUp}
      />
      <DueOrOverdueGroup rows={workspace.groups.dueOrOverdue} timeZone={workspace.timeZone} />
      <CandidateGroup
        title={RETENTION_GROUP_TITLES.NO_REFERRAL_REQUEST}
        description={workspace.groups.noReferralRequest[0]?.fact}
        rows={workspace.groups.noReferralRequest}
        timeZone={workspace.timeZone}
        empty="No completed jobs without a same-business ReferralRequest in this window."
        canRecordFollowUp={canRecordFollowUp}
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
  canRecordFollowUp,
}: {
  title: string;
  description?: string;
  rows: RetentionCandidate[];
  timeZone: string;
  empty: string;
  canRecordFollowUp: boolean;
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
            {canRecordFollowUp ? <RetentionFollowUpForm row={row} /> : null}
          </article>
        ))}
      </CardContent>
    </Card>
  );
}

function isFollowUpFindingGroup(
  group: RetentionCandidate["group"],
): group is RetentionFollowUpFindingGroup {
  return (RETENTION_FOLLOW_UP_FINDING_GROUPS as readonly string[]).includes(group);
}

function RetentionFollowUpForm({ row }: { row: RetentionCandidate }) {
  if (!isFollowUpFindingGroup(row.group)) return null;
  return (
    <ActionForm action={recordRetentionFollowUpTaskAction} className="mt-3 space-y-2">
      <input type="hidden" name="customerId" value={row.customerId} />
      <input type="hidden" name="jobId" value={row.lastCompletedJobId} />
      <input type="hidden" name="group" value={row.group} />
      <p className="text-xs text-muted-foreground">{RETENTION_OWNER_FOLLOW_UP_MESSAGE}</p>
      <label className="block text-xs text-muted-foreground">
        Due date (optional)
        <Input type="date" name="dueOn" className="mt-1 w-40" />
      </label>
      <Button type="submit" size="sm">
        Record follow-up task
      </Button>
    </ActionForm>
  );
}

function FollowUpGroup({
  rows,
  timeZone,
  canResolveFollowUp,
}: {
  rows: RetentionFollowUpRow[];
  timeZone: string;
  canResolveFollowUp: boolean;
}) {
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
              {row.dueAt
                ? ` Due date: ${formatDate(row.dueAt, timeZone)} (${row.dueStateLabel}).`
                : " No due date."}
            </p>
            <LinkRow links={row.links} />
            {canResolveFollowUp &&
            isRetentionFollowUpTask(row.origin) &&
            (row.status === "OPEN" || row.status === "DONE" || row.status === "CANCELLED") ? (
              <RetentionFollowUpResolveForm row={row} />
            ) : null}
          </article>
        ))}
      </CardContent>
    </Card>
  );
}

function DueOrOverdueGroup({
  rows,
  timeZone,
}: {
  rows: RetentionFollowUpRow[];
  timeZone: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{RETENTION_GROUP_TITLES.DUE_OR_OVERDUE}</CardTitle>
        <CardDescription>
          {rows[0]?.fact ??
            "Owner-recorded retention follow-up tasks whose due date is today or earlier in the business timezone. This is not a send."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.length === 0 ? (
          <EmptyState
            title="None recorded"
            description="No open owner-recorded follow-up tasks are due or overdue in this window."
          />
        ) : null}
        {rows.map((row) => (
          <article key={row.followUpId} className="rounded-md border border-border/60 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">{row.customerName}</p>
              <Badge variant={row.dueState === "OVERDUE" ? "destructive" : "outline"}>
                {row.dueStateLabel}
              </Badge>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              Kind: {row.kind}. Recorded status: {row.statusLabel}. Due date:{" "}
              {row.dueAt ? formatDate(row.dueAt, timeZone) : "Not recorded"}.
            </p>
            <LinkRow links={row.links} />
          </article>
        ))}
      </CardContent>
    </Card>
  );
}

function RetentionFollowUpResolveForm({ row }: { row: RetentionFollowUpRow }) {
  return (
    <div className="mt-3 space-y-2">
      <p className="text-xs text-muted-foreground">{RETENTION_OWNER_RESOLVE_FOLLOW_UP_MESSAGE}</p>
      <div className="flex flex-wrap gap-2">
        <ActionForm action={resolveRetentionFollowUpTaskStatusAction}>
          <input type="hidden" name="followUpId" value={row.followUpId} />
          <input type="hidden" name="status" value="DONE" />
          <Button type="submit" size="sm">
            Mark done
          </Button>
        </ActionForm>
        <ActionForm action={resolveRetentionFollowUpTaskStatusAction}>
          <input type="hidden" name="followUpId" value={row.followUpId} />
          <input type="hidden" name="status" value="CANCELLED" />
          <Button type="submit" size="sm" variant="outline">
            Cancel
          </Button>
        </ActionForm>
      </div>
    </div>
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

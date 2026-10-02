"use client";

import { useActionState } from "react";
import {
  recordJobCustomerIssueAction,
  recordJobCustomerIssueDecisionAction,
  reviewJobCustomerIssueAction,
  type JobCustomerIssueActionState,
} from "@/app/actions/job-customer-issue";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/status-badge";
import { formatDateTime } from "@/lib/format";
import type { JobCustomerIssueReview } from "@/lib/job-customer-issue-data";
import {
  JOB_CUSTOMER_ISSUE_CATEGORIES,
  JOB_CUSTOMER_ISSUE_CATEGORY_LABELS,
  JOB_CUSTOMER_ISSUE_DECISIONS,
  JOB_CUSTOMER_ISSUE_DECISION_LABELS,
  JOB_CUSTOMER_ISSUE_REPORTED_VIA,
  JOB_CUSTOMER_ISSUE_REPORTED_VIA_LABELS,
} from "@/lib/job-customer-issue";

const initialState: JobCustomerIssueActionState = {};

function warrantySourceLabel(source: string) {
  if (source === "VAULT") return "Business Vault";
  if (source === "AGREEMENT") return "Customer agreement";
  if (source === "ESTIMATE") return "Approved estimate";
  return source;
}

function ActionAlerts({ state }: { state: JobCustomerIssueActionState }) {
  return (
    <>
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.message ? (
        <Alert>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

function WarrantyTerms({ review }: { review: JobCustomerIssueReview }) {
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <p className="text-sm font-medium">Recorded warranty terms</p>
      <p className="text-xs text-muted-foreground">{review.warrantyDisclaimer}</p>
      {review.warrantyTerms.length === 0 ? (
        <p className="text-sm text-muted-foreground">{review.noWarrantyTermsMessage}</p>
      ) : (
        <ul className="space-y-2">
          {review.warrantyTerms.map((term) => (
            <li key={`${term.source}:${term.sourceId}`} className="space-y-1 text-sm">
              <p className="font-medium">{term.title}</p>
              <p className="text-xs text-muted-foreground">
                {warrantySourceLabel(term.source)}
                {term.effectiveOn ? ` · Effective ${term.effectiveOn}` : ""}
                {term.expiresOn ? ` · Recorded end ${term.expiresOn}` : ""}
                {term.recordStatus ? ` · ${term.recordStatus}` : ""}
              </p>
              {term.body ? <p className="whitespace-pre-wrap">{term.body}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RecordForm({ review }: { review: JobCustomerIssueReview }) {
  const [state, action, pending] = useActionState(
    recordJobCustomerIssueAction,
    initialState,
  );
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="jobId" value={review.jobId} />
      <ActionAlerts state={state} />
      <div className="space-y-1">
        <Label htmlFor="job-customer-issue-category">Issue type</Label>
        <select
          id="job-customer-issue-category"
          name="category"
          required
          className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          defaultValue="QUALITY_CONCERN"
        >
          {JOB_CUSTOMER_ISSUE_CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {JOB_CUSTOMER_ISSUE_CATEGORY_LABELS[value]}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="job-customer-issue-reported-via">How the customer reported it</Label>
        <select
          id="job-customer-issue-reported-via"
          name="reportedVia"
          required
          className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          defaultValue="PHONE"
        >
          {JOB_CUSTOMER_ISSUE_REPORTED_VIA.map((value) => (
            <option key={value} value={value}>
              {JOB_CUSTOMER_ISSUE_REPORTED_VIA_LABELS[value]}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="job-customer-issue-description">What the customer reported</Label>
        <textarea
          id="job-customer-issue-description"
          name="description"
          required
          rows={4}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        />
      </div>
      {review.attachableDocuments.length > 0 ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Private documents already on this job</legend>
          {review.attachableDocuments.map((document) => (
            <label key={document.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="storedAssetIds" value={document.id} />
              <span>{document.originalFilename}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Records the report only. Does not create a callback, invoice, schedule a
        job, or message the customer.
      </p>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Recording…" : "Record issue"}
      </Button>
    </form>
  );
}

function ReviewForm({
  issueId,
  ownerNotes,
}: {
  issueId: string;
  ownerNotes: string;
}) {
  const [state, action, pending] = useActionState(
    reviewJobCustomerIssueAction,
    initialState,
  );
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="issueId" value={issueId} />
      <ActionAlerts state={state} />
      <div className="space-y-1">
        <Label htmlFor={`job-customer-issue-review-notes-${issueId}`}>
          Private owner notes
        </Label>
        <textarea
          id={`job-customer-issue-review-notes-${issueId}`}
          name="ownerNotes"
          rows={3}
          defaultValue={ownerNotes}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Private notes stay hidden from the customer project link. This is not a
        coverage determination.
      </p>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Mark in review"}
      </Button>
    </form>
  );
}

function DecisionForm({
  issueId,
  ownerNotes,
}: {
  issueId: string;
  ownerNotes: string;
}) {
  const [state, action, pending] = useActionState(
    recordJobCustomerIssueDecisionAction,
    initialState,
  );
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="issueId" value={issueId} />
      <ActionAlerts state={state} />
      <div className="space-y-1">
        <Label htmlFor={`job-customer-issue-decision-${issueId}`}>
          Operational decision
        </Label>
        <select
          id={`job-customer-issue-decision-${issueId}`}
          name="decision"
          required
          className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          defaultValue="RECORDED_ONLY"
        >
          {JOB_CUSTOMER_ISSUE_DECISIONS.map((value) => (
            <option key={value} value={value}>
              {JOB_CUSTOMER_ISSUE_DECISION_LABELS[value]}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`job-customer-issue-decision-notes-${issueId}`}>
          Private owner notes
        </Label>
        <textarea
          id={`job-customer-issue-decision-notes-${issueId}`}
          name="ownerNotes"
          rows={3}
          defaultValue={ownerNotes}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Private owner findings only. This is not a coverage or legal
        determination and does not invoice, schedule, create a callback, or
        message the customer.
      </p>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Record decision"}
      </Button>
    </form>
  );
}

export function JobCustomerIssuePanel({ review }: { review: JobCustomerIssueReview }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{review.workflowMessage}</p>
      <WarrantyTerms review={review} />

      {review.canRecord ? <RecordForm review={review} /> : null}
      {!review.eligible ? (
        <p className="text-sm text-muted-foreground">
          A customer-reported issue can only be recorded against a completed job.
        </p>
      ) : null}
      {review.eligible && !review.canWrite ? (
        <p className="text-sm text-muted-foreground">
          Only the business owner can record, review, or close a
          customer-reported issue.
        </p>
      ) : null}

      {review.issues.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No customer-reported issues are recorded for this job.
        </p>
      ) : (
        <ul className="space-y-3">
          {review.issues.map((issue) => (
            <li key={issue.id} className="space-y-3 rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={issue.customerVisibleStatus} />
                <span className="text-xs text-muted-foreground">
                  {issue.categoryLabel} · {issue.reportedViaLabel} · Recorded{" "}
                  {formatDateTime(issue.recordedAt)}
                  {issue.recordedByName ? ` by ${issue.recordedByName}` : ""}
                </span>
              </div>
              <p className="whitespace-pre-wrap">{issue.description}</p>
              {issue.attachments.length > 0 ? (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    Attached private documents
                  </p>
                  <ul className="list-disc space-y-1 pl-5 text-xs">
                    {issue.attachments.map((attachment) => (
                      <li key={attachment.id}>{attachment.originalFilename}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {issue.decisionLabel ? (
                <p>
                  Private decision: {issue.decisionLabel}
                  {issue.decidedAt ? ` · ${formatDateTime(issue.decidedAt)}` : ""}
                </p>
              ) : null}
              {issue.ownerNotes ? (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    Private owner notes
                  </p>
                  <p className="whitespace-pre-wrap text-muted-foreground">
                    {issue.ownerNotes}
                  </p>
                </div>
              ) : null}
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Status history</p>
                <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
                  {issue.history.map((event) => (
                    <li key={event.id}>
                      {event.eventLabel} as {event.toCustomerVisibleStatus}
                      {event.fromCustomerVisibleStatus
                        ? ` from ${event.fromCustomerVisibleStatus}`
                        : ""}
                      {` · ${formatDateTime(event.createdAt)}`}
                      {event.actorName ? ` · ${event.actorName}` : ""}
                    </li>
                  ))}
                </ol>
              </div>
              {review.canWrite && issue.customerVisibleStatus === "RECEIVED" ? (
                <ReviewForm issueId={issue.id} ownerNotes={issue.ownerNotes} />
              ) : null}
              {review.canWrite &&
              (issue.customerVisibleStatus === "RECEIVED" ||
                issue.customerVisibleStatus === "IN_REVIEW") ? (
                <DecisionForm issueId={issue.id} ownerNotes={issue.ownerNotes} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

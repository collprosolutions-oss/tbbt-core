"use client";

import { useActionState } from "react";
import {
  recordJobCallbackAction,
  recordJobCallbackOutcomeAction,
  reviewJobCallbackAction,
  type JobCallbackActionState,
} from "@/app/actions/job-callback";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/status-badge";
import { formatDateTime } from "@/lib/format";
import type { JobCallbackReview } from "@/lib/job-callback-data";
import {
  JOB_CALLBACK_OUTCOME_LABELS,
  JOB_CALLBACK_OUTCOMES,
  JOB_CALLBACK_REPORTED_VIA,
  JOB_CALLBACK_REPORTED_VIA_LABELS,
  recordedCallbackOutcomeLabel,
  recordedCallbackStatusLabel,
  reportedViaLabel,
} from "@/lib/job-callback";

const initialState: JobCallbackActionState = {};

function warrantySourceLabel(source: string) {
  if (source === "VAULT") return "Business Vault";
  if (source === "AGREEMENT") return "Customer agreement";
  if (source === "ESTIMATE") return "Approved estimate";
  return source;
}

function ActionAlerts({ state }: { state: JobCallbackActionState }) {
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

function WarrantyTerms({ review }: { review: JobCallbackReview }) {
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

function RecordForm({ jobId }: { jobId: string }) {
  const [state, action, pending] = useActionState(recordJobCallbackAction, initialState);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="jobId" value={jobId} />
      <ActionAlerts state={state} />
      <div className="space-y-1">
        <Label htmlFor="job-callback-reported-via">How the customer reported it</Label>
        <select
          id="job-callback-reported-via"
          name="reportedVia"
          required
          className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          defaultValue="PHONE"
        >
          {JOB_CALLBACK_REPORTED_VIA.map((value) => (
            <option key={value} value={value}>
              {JOB_CALLBACK_REPORTED_VIA_LABELS[value]}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="job-callback-description">What the customer reported</Label>
        <textarea
          id="job-callback-description"
          name="description"
          required
          rows={4}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Records the report only. Does not create an invoice, schedule a job, or
        message the customer.
      </p>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Recording…" : "Record callback"}
      </Button>
    </form>
  );
}

function ReviewButton({ callbackId }: { callbackId: string }) {
  const [state, action, pending] = useActionState(reviewJobCallbackAction, initialState);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="callbackId" value={callbackId} />
      <ActionAlerts state={state} />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Mark reviewed"}
      </Button>
    </form>
  );
}

function OutcomeForm({ callbackId }: { callbackId: string }) {
  const [state, action, pending] = useActionState(
    recordJobCallbackOutcomeAction,
    initialState,
  );
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="callbackId" value={callbackId} />
      <ActionAlerts state={state} />
      <div className="space-y-1">
        <Label htmlFor={`job-callback-outcome-${callbackId}`}>Operational outcome</Label>
        <select
          id={`job-callback-outcome-${callbackId}`}
          name="outcome"
          required
          className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          defaultValue="RECORDED_ONLY"
        >
          {JOB_CALLBACK_OUTCOMES.map((value) => (
            <option key={value} value={value}>
              {JOB_CALLBACK_OUTCOME_LABELS[value]}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`job-callback-outcome-notes-${callbackId}`}>
          Outcome notes (optional)
        </Label>
        <textarea
          id={`job-callback-outcome-notes-${callbackId}`}
          name="outcomeNotes"
          rows={3}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Operational bookkeeping only. This is not a coverage or legal
        determination and does not invoice, schedule, or message the customer.
      </p>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Record outcome"}
      </Button>
    </form>
  );
}

export function JobCallbackPanel({ review }: { review: JobCallbackReview }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{review.workflowMessage}</p>
      <WarrantyTerms review={review} />

      {review.canRecord ? <RecordForm jobId={review.jobId} /> : null}
      {!review.eligible ? (
        <p className="text-sm text-muted-foreground">
          A customer-reported callback can only be recorded against a completed
          job.
        </p>
      ) : null}
      {review.eligible && !review.canWrite ? (
        <p className="text-sm text-muted-foreground">
          Only the business owner can record, review, or close a
          customer-reported callback.
        </p>
      ) : null}

      {review.callbacks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No customer-reported callbacks are recorded for this job.
        </p>
      ) : (
        <ul className="space-y-3">
          {review.callbacks.map((callback) => (
            <li key={callback.id} className="space-y-3 rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={callback.status} />
                <span className="text-xs text-muted-foreground">
                  {reportedViaLabel(callback.reportedVia)} · Recorded{" "}
                  {formatDateTime(callback.recordedAt)}
                  {callback.reportedVia === "PORTAL"
                    ? ""
                    : callback.recordedBy.user.name
                      ? ` by ${callback.recordedBy.user.name}`
                      : ""}
                </span>
              </div>
              <p className="whitespace-pre-wrap">{callback.description}</p>
              {callback.outcome ? (
                <p>
                  Outcome: {recordedCallbackOutcomeLabel(callback.outcome)}
                  {callback.outcomeAt
                    ? ` · ${formatDateTime(callback.outcomeAt)}`
                    : ""}
                </p>
              ) : null}
              {callback.outcomeNotes ? (
                <p className="whitespace-pre-wrap text-muted-foreground">
                  {callback.outcomeNotes}
                </p>
              ) : null}
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Status history</p>
                <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
                  {callback.events.map((event) => (
                    <li key={event.id}>
                      {event.eventType === "RECORDED"
                        ? "Recorded"
                        : event.eventType === "REVIEWED"
                          ? "Reviewed"
                          : "Outcome recorded"}{" "}
                      as {recordedCallbackStatusLabel(event.toStatus)}
                      {event.fromStatus
                        ? ` from ${recordedCallbackStatusLabel(event.fromStatus)}`
                        : ""}
                      {` · ${formatDateTime(event.createdAt)}`}
                      {event.actor.user.name ? ` · ${event.actor.user.name}` : ""}
                    </li>
                  ))}
                </ol>
              </div>
              {review.canWrite && callback.status === "RECORDED" ? (
                <ReviewButton callbackId={callback.id} />
              ) : null}
              {review.canWrite && callback.status === "UNDER_REVIEW" ? (
                <OutcomeForm callbackId={callback.id} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

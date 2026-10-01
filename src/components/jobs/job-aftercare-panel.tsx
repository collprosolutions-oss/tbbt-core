"use client";

import { useActionState } from "react";
import {
  publishJobAftercareAction,
  saveJobAftercareDraftAction,
  unpublishJobAftercareAction,
  type JobAftercareActionState,
} from "@/app/actions/job-aftercare";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/status-badge";
import { formatDateTime } from "@/lib/format";
import type { JobAftercareReview } from "@/lib/job-aftercare-data";
import { recordedAftercareStatusLabel } from "@/lib/job-aftercare";

const initialState: JobAftercareActionState = {};

function warrantySourceLabel(source: string) {
  if (source === "VAULT") return "Business Vault";
  if (source === "AGREEMENT") return "Customer agreement";
  if (source === "ESTIMATE") return "Approved estimate";
  return source;
}

function ActionAlerts({ state }: { state: JobAftercareActionState }) {
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

function WarrantyTerms({ review }: { review: JobAftercareReview }) {
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

function AftercareForm({ review }: { review: JobAftercareReview }) {
  const [state, action, pending] = useActionState(
    saveJobAftercareDraftAction,
    initialState,
  );
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="jobId" value={review.jobId} />
      <ActionAlerts state={state} />
      <div className="space-y-1">
        <Label htmlFor="job-aftercare-instructions">Aftercare instructions</Label>
        <textarea
          id="job-aftercare-instructions"
          name="instructions"
          required
          rows={6}
          defaultValue={review.aftercare?.draftInstructions ?? ""}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="job-aftercare-owner-notes">Private owner notes</Label>
        <textarea
          id="job-aftercare-owner-notes"
          name="ownerNotes"
          rows={3}
          defaultValue={review.aftercare?.ownerNotes ?? ""}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        />
        <p className="text-xs text-muted-foreground">
          Private to the owner. Never shown on the customer project link and never
          published with the instructions.
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        Saves a draft only. The customer project link stays unchanged until you
        publish. No customer message is sent.
      </p>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Save draft"}
      </Button>
    </form>
  );
}

function PublishButton({ jobId }: { jobId: string }) {
  const [state, action, pending] = useActionState(
    publishJobAftercareAction,
    initialState,
  );
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="jobId" value={jobId} />
      <ActionAlerts state={state} />
      <p className="text-xs text-muted-foreground">
        Publishing shows the current draft on this job&apos;s existing customer
        project link. It does not send a message.
      </p>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Publishing…" : "Publish to project link"}
      </Button>
    </form>
  );
}

function UnpublishButton({ jobId }: { jobId: string }) {
  const [state, action, pending] = useActionState(
    unpublishJobAftercareAction,
    initialState,
  );
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="jobId" value={jobId} />
      <ActionAlerts state={state} />
      <p className="text-xs text-muted-foreground">
        Unpublishing hides the instructions from the customer project link. The
        wording stays in owner history. No customer message is sent.
      </p>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Unpublishing…" : "Unpublish"}
      </Button>
    </form>
  );
}

export function JobAftercarePanel({ review }: { review: JobAftercareReview }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{review.workflowMessage}</p>
      <WarrantyTerms review={review} />

      {!review.eligible ? (
        <p className="text-sm text-muted-foreground">
          Aftercare instructions can only be recorded against a completed job.
        </p>
      ) : null}
      {review.eligible && !review.canWrite ? (
        <p className="text-sm text-muted-foreground">
          Only the business owner can write, publish, or unpublish job aftercare
          instructions.
        </p>
      ) : null}

      {review.aftercare ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <StatusBadge status={review.aftercare.status} />
          <span className="text-xs text-muted-foreground">
            {review.aftercare.statusLabel}
            {review.aftercare.publishedAt
              ? ` · Published ${formatDateTime(review.aftercare.publishedAt)}`
              : ""}
          </span>
        </div>
      ) : null}

      {review.canWrite && review.eligible ? <AftercareForm review={review} /> : null}
      {review.canWrite && review.eligible && review.aftercare ? (
        <PublishButton jobId={review.jobId} />
      ) : null}
      {review.canWrite &&
      review.eligible &&
      review.aftercare?.status === "PUBLISHED" ? (
        <UnpublishButton jobId={review.jobId} />
      ) : null}

      {review.history.length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Wording history</p>
          <ol className="list-decimal space-y-2 pl-5 text-xs text-muted-foreground">
            {review.history.map((event) => (
              <li key={event.id} className="space-y-1">
                <p>
                  {event.eventLabel} as{" "}
                  {recordedAftercareStatusLabel(event.toStatus)}
                  {event.fromStatus
                    ? ` from ${recordedAftercareStatusLabel(event.fromStatus)}`
                    : ""}
                  {` · ${formatDateTime(event.createdAt)}`}
                  {event.actorName ? ` · ${event.actorName}` : ""}
                </p>
                {event.instructionsSnapshot ? (
                  <p className="whitespace-pre-wrap text-foreground">
                    {event.instructionsSnapshot}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No aftercare instructions are recorded for this job.
        </p>
      )}
    </div>
  );
}

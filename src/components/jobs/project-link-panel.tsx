"use client";

import { useActionState } from "react";
import {
  revokeJobProjectLinkAction,
  rotateJobProjectLinkAction,
  type JobProjectLinkActionState,
} from "@/app/actions/project-link";
import { CopyProjectLinkButton } from "@/components/jobs/copy-project-link-button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { formatDateTime } from "@/lib/format";
import type { OwnerJobProjectLinkReview } from "@/lib/project-link-data";
import { recordedProjectLinkStatusLabel } from "@/lib/project-link";

const initialState: JobProjectLinkActionState = {};

function ActionAlerts({ state }: { state: JobProjectLinkActionState }) {
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
      {state.projectPath ? (
        <p className="break-all rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs">
          {state.projectPath}
        </p>
      ) : null}
    </>
  );
}

function RotateForm({
  jobId,
  label,
  confirmAfterRevoke,
}: {
  jobId: string;
  label: string;
  confirmAfterRevoke: boolean;
}) {
  const [state, action, pending] = useActionState(
    rotateJobProjectLinkAction,
    initialState,
  );
  return (
    <form
      action={action}
      className="space-y-2"
      onSubmit={(event) => {
        if (
          confirmAfterRevoke &&
          !window.confirm(
            "Issue a new customer project link? Previous revoked URLs stay rejected. No message will be sent.",
          )
        ) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="jobId" value={jobId} />
      <ActionAlerts state={state} />
      <p className="text-xs text-muted-foreground">
        Rotating stops the current customer URL immediately and issues a new
        one for this same job. It does not send a message.
      </p>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Rotating…" : label}
      </Button>
    </form>
  );
}

function RevokeForm({ jobId }: { jobId: string }) {
  const [state, action, pending] = useActionState(
    revokeJobProjectLinkAction,
    initialState,
  );
  return (
    <form
      action={action}
      className="space-y-2"
      onSubmit={(event) => {
        if (
          !window.confirm(
            "Revoke this customer project link? Every current URL for this job will stop working immediately. No message will be sent.",
          )
        ) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="jobId" value={jobId} />
      <ActionAlerts state={state} />
      <p className="text-xs text-muted-foreground">
        Revoking stops every current customer URL for this job immediately.
        Historical records stay. It does not send a message.
      </p>
      <Button type="submit" size="sm" variant="destructive" disabled={pending}>
        {pending ? "Revoking…" : "Revoke project link"}
      </Button>
    </form>
  );
}

export function ProjectLinkPanel({ review }: { review: OwnerJobProjectLinkReview }) {
  const liveToken = review.link.projectToken;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{review.workflowMessage}</p>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge status={review.link.status} />
        <span className="text-xs text-muted-foreground">
          {recordedProjectLinkStatusLabel(review.link.status)}
          {review.link.rotatedAt
            ? ` · Last rotated ${formatDateTime(review.link.rotatedAt)}`
            : ""}
          {review.link.revokedAt
            ? ` · Revoked ${formatDateTime(review.link.revokedAt)}`
            : ""}
        </span>
      </div>

      {review.link.active && liveToken ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <a
            href={review.link.projectPath ?? `/p/${liveToken}`}
            className="underline underline-offset-4"
          >
            {review.link.projectPath ?? `/p/${liveToken}`}
          </a>
          <CopyProjectLinkButton projectToken={liveToken} />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          This customer project link is revoked. Rotate it to issue a new URL
          for the same job. The previous URL stays rejected.
        </p>
      )}

      {review.canWrite ? (
        <div className="space-y-4">
          <RotateForm
            jobId={review.jobId}
            label={review.link.active ? "Rotate project link" : "Issue new project link"}
            confirmAfterRevoke={!review.link.active}
          />
          {review.link.active ? <RevokeForm jobId={review.jobId} /> : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Only the business owner can rotate or revoke this customer project
          link.
        </p>
      )}

      {review.history.length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Link history</p>
          <ol className="list-decimal space-y-2 pl-5 text-xs text-muted-foreground">
            {review.history.map((event) => (
              <li key={event.id}>
                {event.eventLabel}
                {event.fromStatus
                  ? ` from ${recordedProjectLinkStatusLabel(event.fromStatus)}`
                  : ""}
                {` to ${recordedProjectLinkStatusLabel(event.toStatus)}`}
                {` · ${formatDateTime(event.createdAt)}`}
                {event.actorName ? ` · ${event.actorName}` : ""}
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No rotate or revoke actions are recorded for this job yet.
        </p>
      )}
    </div>
  );
}

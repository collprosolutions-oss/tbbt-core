"use client";

import { useActionState } from "react";
import Link from "next/link";
import {
  cancelHandymanMaintenanceFollowUpAction,
  createHandymanMaintenanceFollowUpAction,
  type HandymanMaintenanceFollowUpActionState,
} from "@/app/actions/handyman-maintenance-follow-up";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/status-badge";
import {
  HANDYMAN_MAINTENANCE_COMPLETED_JOB_MESSAGE,
  HANDYMAN_MAINTENANCE_HANDYMAN_ONLY_MESSAGE,
  HANDYMAN_MAINTENANCE_REVIEW_ACTION,
  maintenanceFollowUpComposeHref,
} from "@/lib/handyman-maintenance-follow-up";
import type { HandymanMaintenanceFollowUpReview } from "@/lib/handyman-maintenance-follow-up-data";

const initialState: HandymanMaintenanceFollowUpActionState = {};

function ActionAlerts({ state }: { state: HandymanMaintenanceFollowUpActionState }) {
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

function dueStateLabel(state: string) {
  if (state === "due_today") return "Due today";
  if (state === "overdue") return "Overdue";
  if (state === "upcoming") return "Upcoming";
  return "No due date";
}

function CreateForm({ review }: { review: HandymanMaintenanceFollowUpReview }) {
  const [state, action, pending] = useActionState(
    createHandymanMaintenanceFollowUpAction,
    initialState,
  );
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="jobId" value={review.jobId} />
      <ActionAlerts state={state} />
      <div className="space-y-1">
        <Label htmlFor="handyman-maintenance-task">Maintenance task</Label>
        <textarea
          id="handyman-maintenance-task"
          name="task"
          required
          rows={3}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="handyman-maintenance-due-on">Due date</Label>
        <Input id="handyman-maintenance-due-on" name="dueOn" type="date" required />
      </div>
      <p className="text-xs text-muted-foreground">
        Saves an owner task only. It appears in the owner queue when due.
        No customer message is sent and no job is booked.
      </p>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Set maintenance follow-up"}
      </Button>
    </form>
  );
}

function CancelButton({ followUpId }: { followUpId: string }) {
  const [state, action, pending] = useActionState(
    cancelHandymanMaintenanceFollowUpAction,
    initialState,
  );
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="followUpId" value={followUpId} />
      <ActionAlerts state={state} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Cancelling…" : "Cancel follow-up"}
      </Button>
    </form>
  );
}

export function HandymanMaintenanceFollowUpPanel({
  review,
}: {
  review: HandymanMaintenanceFollowUpReview;
}) {
  const ineligibleMessage =
    review.reason === "not_completed"
      ? HANDYMAN_MAINTENANCE_COMPLETED_JOB_MESSAGE
      : review.reason === "not_handyman"
        ? HANDYMAN_MAINTENANCE_HANDYMAN_ONLY_MESSAGE
        : null;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{review.workflowMessage}</p>
      {ineligibleMessage && !review.openFollowUp ? (
        <p className="text-sm text-muted-foreground">{ineligibleMessage}</p>
      ) : null}

      {review.openFollowUp ? (
        <div className="space-y-3 rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">Open follow-up</p>
            <StatusBadge status={review.openFollowUp.status} />
            <span className="text-xs text-muted-foreground">
              {dueStateLabel(review.openFollowUp.dueState)}
              {review.openFollowUp.dueOnLabel ? ` · ${review.openFollowUp.dueOnLabel}` : ""}
            </span>
          </div>
          <p className="whitespace-pre-wrap text-sm">{review.openFollowUp.task}</p>
          <p className="text-xs text-muted-foreground">
            Sending a customer reminder requires an explicit owner review in
            Communications. This is not a callback or aftercare publish.
          </p>
          <div className="flex flex-wrap gap-2">
            {review.canWrite && review.openFollowUp.customerId ? (
              <Button asChild size="sm">
                <Link
                  href={maintenanceFollowUpComposeHref({
                    customerId: review.openFollowUp.customerId,
                    followUpId: review.openFollowUp.id,
                  })}
                >
                  {HANDYMAN_MAINTENANCE_REVIEW_ACTION} reminder
                </Link>
              </Button>
            ) : null}
          </div>
          {review.canWrite ? <CancelButton followUpId={review.openFollowUp.id} /> : null}
        </div>
      ) : review.canWrite && review.eligible ? (
        <CreateForm review={review} />
      ) : null}

      {review.history.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">Earlier follow-ups</p>
          <ul className="space-y-2">
            {review.history.map((row) => (
              <li key={row.id} className="rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={row.status} />
                  <span className="text-xs text-muted-foreground">
                    {row.dueOnLabel ?? "No due date"}
                  </span>
                </div>
                <p className="mt-1 whitespace-pre-wrap">{row.task}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

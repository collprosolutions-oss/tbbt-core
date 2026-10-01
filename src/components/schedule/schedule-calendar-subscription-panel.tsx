"use client";

import { useActionState } from "react";
import {
  createScheduleCalendarSubscriptionAction,
  rotateScheduleCalendarSubscriptionAction,
  revokeScheduleCalendarSubscriptionAction,
  type ScheduleCalendarSubscriptionActionState,
} from "@/app/actions/schedule-calendar-subscription";
import { Button } from "@/components/ui/button";
import type { ScheduleCalendarSubscriptionStatus } from "@/lib/schedule-calendar-subscription";

const initialState: ScheduleCalendarSubscriptionActionState = {};

function ActionAlerts({ state }: { state: ScheduleCalendarSubscriptionActionState }) {
  return (
    <>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-sm">{state.message}</p> : null}
      {state.feedUrl ? (
        <p className="break-all rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs">
          {state.feedUrl}
        </p>
      ) : null}
    </>
  );
}

export function ScheduleCalendarSubscriptionPanel({
  status,
  title,
  description,
}: {
  status: ScheduleCalendarSubscriptionStatus;
  title: string;
  description: string;
}) {
  const [createState, createAction, createPending] = useActionState(
    createScheduleCalendarSubscriptionAction,
    initialState,
  );
  const [rotateState, rotateAction, rotatePending] = useActionState(
    rotateScheduleCalendarSubscriptionAction,
    initialState,
  );
  const [revokeState, revokeAction, revokePending] = useActionState(
    revokeScheduleCalendarSubscriptionAction,
    initialState,
  );

  if (!status.available) {
    return (
      <div className="space-y-1 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">{title}</p>
        <p>Calendar subscription is not available on this environment yet.</p>
      </div>
    );
  }

  const pending = createPending || rotatePending || revokePending;
  const latest = createState.feedUrl
    ? createState
    : rotateState.feedUrl
      ? rotateState
      : createState.error
        ? createState
        : rotateState.error || rotateState.message
          ? rotateState
          : revokeState;

  return (
    <div className="space-y-2 text-sm">
      <p className="font-medium">{title}</p>
      <p className="text-muted-foreground">{description}</p>
      <ActionAlerts state={latest} />
      {status.active ? (
        <div className="flex flex-wrap gap-2">
          <form action={rotateAction}>
            <input type="hidden" name="scope" value={status.scope} />
            <Button type="submit" size="sm" variant="outline" disabled={pending}>
              {rotatePending ? "Rotating…" : "Rotate subscription URL"}
            </Button>
          </form>
          <form action={revokeAction}>
            <input type="hidden" name="scope" value={status.scope} />
            <Button type="submit" size="sm" variant="destructive" disabled={pending}>
              {revokePending ? "Revoking…" : "Revoke subscription"}
            </Button>
          </form>
        </div>
      ) : (
        <form action={createAction}>
          <input type="hidden" name="scope" value={status.scope} />
          <Button type="submit" size="sm" disabled={pending}>
            {createPending ? "Creating…" : "Create calendar subscription"}
          </Button>
        </form>
      )}
    </div>
  );
}

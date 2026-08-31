"use client";

import { useActionState } from "react";
import {
  advanceReviewRequestAction,
  cancelReviewRequestAction,
  type ReviewsActionState,
} from "@/app/actions/reviews";
import { Button } from "@/components/ui/button";

const initial: ReviewsActionState = {};

export function RequestStatusButton({
  requestId,
  status,
}: {
  requestId: string;
  status: string;
}) {
  const [state, formAction, pending] = useActionState(advanceReviewRequestAction, initial);
  const [cancelState, cancelAction, cancelPending] = useActionState(cancelReviewRequestAction, initial);
  const canAdvance = status === "DRAFT" || status === "READY";
  const canCancel = status === "DRAFT" || status === "READY" || status === "SENT";
  const label = status === "DRAFT" ? "Mark ready" : "Record as sent";

  if (!canAdvance && !canCancel) return null;

  return (
    <div className="flex flex-wrap items-start gap-2">
      {canAdvance ? (
        <form action={formAction}>
          <input type="hidden" name="requestId" value={requestId} />
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Updating…" : label}
          </Button>
        </form>
      ) : null}
      {canCancel ? (
        <form action={cancelAction}>
          <input type="hidden" name="requestId" value={requestId} />
          <Button type="submit" size="sm" variant="outline" disabled={cancelPending}>
            {cancelPending ? "Cancelling…" : "Cancel request"}
          </Button>
        </form>
      ) : null}
      {state.error ? <p className="w-full text-xs text-destructive">{state.error}</p> : null}
      {state.message ? <p className="w-full text-xs text-muted-foreground">{state.message}</p> : null}
      {cancelState.error ? <p className="w-full text-xs text-destructive">{cancelState.error}</p> : null}
      {cancelState.message ? <p className="w-full text-xs text-muted-foreground">{cancelState.message}</p> : null}
    </div>
  );
}

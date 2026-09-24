"use client";

import { useActionState } from "react";
import {
  advanceReviewRequestAction,
  cancelReviewRequestAction,
  markReviewRequestSentManuallyAction,
  sendReviewRequestAction,
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
  const [sendState, sendAction, sendPending] = useActionState(sendReviewRequestAction, initial);
  const [manualState, manualAction, manualPending] = useActionState(
    markReviewRequestSentManuallyAction,
    initial,
  );
  const [cancelState, cancelAction, cancelPending] = useActionState(cancelReviewRequestAction, initial);
  const canAdvance = status === "DRAFT";
  const canSend = status === "READY" || status === "FAILED";
  const canCancel = status === "DRAFT" || status === "READY" || status === "FAILED" || status === "SENT";

  if (!canAdvance && !canSend && !canCancel) return null;

  return (
    <div className="flex flex-wrap items-start gap-2">
      {canAdvance ? (
        <form action={formAction}>
          <input type="hidden" name="requestId" value={requestId} />
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Updating…" : "Mark ready"}
          </Button>
        </form>
      ) : null}
      {canSend ? (
        <>
          <form action={sendAction}>
            <input type="hidden" name="requestId" value={requestId} />
            <Button type="submit" size="sm" disabled={sendPending}>
              {sendPending ? "Sending…" : "Send via connected adapters"}
            </Button>
          </form>
          <form action={manualAction}>
            <input type="hidden" name="requestId" value={requestId} />
            <Button type="submit" size="sm" variant="outline" disabled={manualPending}>
              {manualPending ? "Saving…" : "Mark sent manually"}
            </Button>
          </form>
        </>
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
      {sendState.error ? <p className="w-full text-xs text-destructive">{sendState.error}</p> : null}
      {sendState.message ? <p className="w-full text-xs text-muted-foreground">{sendState.message}</p> : null}
      {manualState.error ? <p className="w-full text-xs text-destructive">{manualState.error}</p> : null}
      {manualState.message ? <p className="w-full text-xs text-muted-foreground">{manualState.message}</p> : null}
      {cancelState.error ? <p className="w-full text-xs text-destructive">{cancelState.error}</p> : null}
      {cancelState.message ? <p className="w-full text-xs text-muted-foreground">{cancelState.message}</p> : null}
    </div>
  );
}

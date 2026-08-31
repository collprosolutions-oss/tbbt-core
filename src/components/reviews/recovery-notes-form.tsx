"use client";

import { useActionState } from "react";
import { updateReviewRecoveryAction, type ReviewsActionState } from "@/app/actions/reviews";
import { Button } from "@/components/ui/button";

const initial: ReviewsActionState = {};

export function RecoveryNotesForm({
  reviewId,
  recoveryNotes,
}: {
  reviewId: string;
  recoveryNotes: string;
}) {
  const [state, formAction, pending] = useActionState(updateReviewRecoveryAction, initial);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="reviewId" value={reviewId} />
      <textarea
        name="recoveryNotes"
        rows={3}
        defaultValue={recoveryNotes}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        placeholder="Internal recovery action only. Do not publish a reply from here."
      />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Saving…" : "Save recovery notes"}
      </Button>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}

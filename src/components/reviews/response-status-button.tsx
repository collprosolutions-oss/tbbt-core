"use client";

import { useActionState } from "react";
import { advanceReviewResponseAction, type ReviewsActionState } from "@/app/actions/reviews";
import { Button } from "@/components/ui/button";

const initial: ReviewsActionState = {};

export function ResponseStatusButton({
  responseId,
  status,
}: {
  responseId: string;
  status: string;
}) {
  const [state, formAction, pending] = useActionState(advanceReviewResponseAction, initial);
  if (status === "APPROVED") return null;
  const label = status === "DRAFT" ? "Mark ready for review" : "Approve response";

  return (
    <form action={formAction} className="space-y-1">
      <input type="hidden" name="responseId" value={responseId} />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Updating…" : label}
      </Button>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}

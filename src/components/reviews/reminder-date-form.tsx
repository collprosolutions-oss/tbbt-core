"use client";

import { useActionState } from "react";
import { updateReviewRequestAction, type ReviewsActionState } from "@/app/actions/reviews";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const initial: ReviewsActionState = {};

export function ReminderDateForm({
  requestId,
  reminderAt,
}: {
  requestId: string;
  reminderAt: string;
}) {
  const [state, formAction, pending] = useActionState(updateReviewRequestAction, initial);

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="requestId" value={requestId} />
      <Input type="date" name="reminderAt" defaultValue={reminderAt} className="w-40" />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Saving…" : "Save reminder"}
      </Button>
      {state.error ? <p className="w-full text-xs text-destructive">{state.error}</p> : null}
      {state.message ? <p className="w-full text-xs text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}

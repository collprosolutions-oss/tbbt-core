"use client";

import { useActionState } from "react";
import { upsertReviewResponseAction, type ReviewsActionState } from "@/app/actions/reviews";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

const initial: ReviewsActionState = {};

export function ResponseForm({
  reviewId,
  body,
}: {
  reviewId: string;
  body: string;
}) {
  const [state, formAction, pending] = useActionState(upsertReviewResponseAction, initial);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="reviewId" value={reviewId} />
      <Label htmlFor={`response-${reviewId}`}>Response draft</Label>
      <textarea
        id={`response-${reviewId}`}
        name="body"
        rows={4}
        defaultValue={body}
        className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
      />
      <p className="text-xs text-muted-foreground">
        Do not invent facts about the customer&apos;s job. This draft is not published.
      </p>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Save response draft"}
      </Button>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}

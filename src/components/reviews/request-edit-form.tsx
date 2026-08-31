"use client";

import { useActionState } from "react";
import { updateReviewRequestAction, type ReviewsActionState } from "@/app/actions/reviews";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { REVIEW_PLATFORM_LABELS, REVIEW_PLATFORMS } from "@/lib/reviews";

const initial: ReviewsActionState = {};

export function RequestEditForm({
  requestId,
  intendedPlatform,
  requestText,
  notes,
}: {
  requestId: string;
  intendedPlatform: string;
  requestText: string;
  notes: string;
}) {
  const [state, formAction, pending] = useActionState(updateReviewRequestAction, initial);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="requestId" value={requestId} />
      <div className="space-y-1.5">
        <Label htmlFor={`edit-platform-${requestId}`}>Intended platform</Label>
        <select
          id={`edit-platform-${requestId}`}
          name="intendedPlatform"
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          defaultValue={intendedPlatform}
        >
          {REVIEW_PLATFORMS.map((platform) => (
            <option key={platform} value={platform}>
              {REVIEW_PLATFORM_LABELS[platform]}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`edit-text-${requestId}`}>Request text</Label>
        <textarea
          id={`edit-text-${requestId}`}
          name="requestText"
          rows={5}
          defaultValue={requestText}
          className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`edit-notes-${requestId}`}>Internal notes</Label>
        <textarea
          id={`edit-notes-${requestId}`}
          name="notes"
          rows={2}
          defaultValue={notes}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
      </div>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Saving…" : "Save request"}
      </Button>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}

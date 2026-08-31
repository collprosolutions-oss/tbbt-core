"use client";

import { useActionState } from "react";
import { recordReceivedReviewAction, type ReviewsActionState } from "@/app/actions/reviews";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { REVIEW_RECEIVED_PLATFORM_LABELS, REVIEW_RECEIVED_PLATFORMS } from "@/lib/reviews";

const initial: ReviewsActionState = {};

export function RecordReviewForm({
  customerId,
  jobId,
  reviewRequestId,
}: {
  customerId: string;
  jobId?: string | null;
  reviewRequestId?: string | null;
}) {
  const [state, formAction, pending] = useActionState(recordReceivedReviewAction, initial);
  const suffix = reviewRequestId ?? jobId ?? customerId;

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="customerId" value={customerId} />
      {jobId ? <input type="hidden" name="jobId" value={jobId} /> : null}
      {reviewRequestId ? <input type="hidden" name="reviewRequestId" value={reviewRequestId} /> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`platform-rec-${suffix}`}>Platform</Label>
          <select
            id={`platform-rec-${suffix}`}
            name="platform"
            required
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            defaultValue="GOOGLE"
          >
            {REVIEW_RECEIVED_PLATFORMS.map((platform) => (
              <option key={platform} value={platform}>
                {REVIEW_RECEIVED_PLATFORM_LABELS[platform]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`rating-${suffix}`}>Rating (optional)</Label>
          <Input id={`rating-${suffix}`} name="rating" type="number" min={1} max={5} step={1} placeholder="1–5 if the review has one" />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`text-rec-${suffix}`}>Review text</Label>
        <textarea
          id={`text-rec-${suffix}`}
          name="reviewText"
          rows={4}
          className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          placeholder="Record the review as it was written. Do not invent a review."
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`date-rec-${suffix}`}>External review date</Label>
          <Input id={`date-rec-${suffix}`} name="externalReviewDate" type="date" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`url-rec-${suffix}`}>External URL (optional)</Label>
          <Input id={`url-rec-${suffix}`} name="externalUrl" type="url" placeholder="https://" />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`notes-rec-${suffix}`}>Internal notes (optional)</Label>
        <Input id={`notes-rec-${suffix}`} name="notes" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`recovery-rec-${suffix}`}>Recovery notes if attention is needed</Label>
        <textarea
          id={`recovery-rec-${suffix}`}
          name="recoveryNotes"
          rows={2}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Recording…" : "Record received review"}
      </Button>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-sm text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}

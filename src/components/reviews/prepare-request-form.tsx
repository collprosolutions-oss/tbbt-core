"use client";

import { useActionState } from "react";
import { createReviewRequestAction, type ReviewsActionState } from "@/app/actions/reviews";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { REVIEW_PLATFORM_LABELS, REVIEW_PLATFORMS } from "@/lib/reviews";

const initial: ReviewsActionState = {};

export function PrepareRequestForm({
  customerId,
  jobId,
  requestText,
}: {
  customerId: string;
  jobId?: string;
  requestText: string;
}) {
  const [state, formAction, pending] = useActionState(createReviewRequestAction, initial);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="customerId" value={customerId} />
      {jobId ? <input type="hidden" name="jobId" value={jobId} /> : null}
      <div className="space-y-1.5">
        <Label htmlFor={`platform-${jobId ?? customerId}`}>Intended platform</Label>
        <select
          id={`platform-${jobId ?? customerId}`}
          name="intendedPlatform"
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          defaultValue="UNASSIGNED"
        >
          {REVIEW_PLATFORMS.map((platform) => (
            <option key={platform} value={platform}>
              {REVIEW_PLATFORM_LABELS[platform]}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`text-${jobId ?? customerId}`}>Request text</Label>
        <textarea
          id={`text-${jobId ?? customerId}`}
          name="requestText"
          rows={6}
          defaultValue={requestText}
          className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
        <p className="text-xs text-muted-foreground">
          Ask for an honest review. Do not ask specifically for a positive or 5-star review.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`notes-${jobId ?? customerId}`}>Internal notes (optional)</Label>
        <Input id={`notes-${jobId ?? customerId}`} name="notes" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`reminder-${jobId ?? customerId}`}>Follow-up reminder (optional)</Label>
        <Input id={`reminder-${jobId ?? customerId}`} name="reminderAt" type="date" className="w-40" />
        <p className="text-xs text-muted-foreground">Owner reminder only. TBBT will not send SMS or email.</p>
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Saving draft…" : "Prepare review request"}
      </Button>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-sm text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}

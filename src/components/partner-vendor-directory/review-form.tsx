"use client";

import { useActionState } from "react";
import {
  reviewPartnerVendorOpportunityAction,
  type DirectoryActionState,
} from "@/app/actions/partner-vendor-directory";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  DIRECTORY_REVIEW_LABELS,
  DIRECTORY_REVIEW_STATUSES,
} from "@/lib/partner-vendor-directory";
import type { DirectoryOpportunityView } from "@/lib/partner-vendor-directory";

const initial: DirectoryActionState = {};

export function PartnerVendorReviewForm({ opportunity }: { opportunity: DirectoryOpportunityView }) {
  const [state, formAction, pending] = useActionState(reviewPartnerVendorOpportunityAction, initial);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="opportunityId" value={opportunity.id} />
      <label className="block text-xs text-muted-foreground">
        Review status
        <select
          name="reviewStatus"
          defaultValue={opportunity.reviewStatus}
          className="mt-1 block w-full rounded-md border border-input bg-background px-2 py-2 text-sm text-foreground"
        >
          {DIRECTORY_REVIEW_STATUSES.map((status) => (
            <option key={status} value={status}>
              {DIRECTORY_REVIEW_LABELS[status]}
            </option>
          ))}
        </select>
      </label>
      <div className="space-y-1">
        <Label htmlFor="directory-review-notes">Review notes</Label>
        <textarea
          id="directory-review-notes"
          name="reviewNotes"
          defaultValue={opportunity.reviewNotes ?? ""}
          rows={3}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
        />
      </div>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Recording…" : "Save manual review"}
      </Button>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}

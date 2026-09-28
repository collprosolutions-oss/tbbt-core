"use client";

import { useActionState } from "react";
import Link from "next/link";
import {
  scheduleCleaningCorrectiveCleanAction,
  type CleaningCorrectiveCleanActionState,
} from "@/app/actions/cleaning-corrective-clean";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CleaningCorrectiveCleanReview } from "@/lib/cleaning-corrective-clean-data";
import { DEFAULT_CORRECTIVE_CLEAN_TIME } from "@/lib/cleaning-corrective-clean";

const initial: CleaningCorrectiveCleanActionState = {};

export function CleaningCorrectiveCleanForm({
  review,
  canCreate,
  timeZone,
}: {
  review: CleaningCorrectiveCleanReview;
  canCreate: boolean;
  timeZone: string;
}) {
  const [state, action, pending] = useActionState(
    scheduleCleaningCorrectiveCleanAction,
    initial,
  );

  return (
    <div className="space-y-4">
      <div className="space-y-1 text-sm">
        <p>Visit outcome: {review.visitOutcomeLabel}</p>
        <p>Customer: {review.customer?.name ?? "None on this job"}</p>
        <p>Property: {review.property?.addressSummary ?? "None on this job"}</p>
        <p>Selected service scope:</p>
        {review.scopeLines.length === 0 ? (
          <p className="text-muted-foreground">
            {review.hasSelectedScope
              ? "The approved estimate is linked. It has no line items to list."
              : "No selected service scope is linked to this job."}
          </p>
        ) : (
          <ul className="list-disc space-y-1 pl-5">
            {review.scopeLines.map((line, index) => (
              <li key={`${line.title}-${index}`}>
                {line.title} × {line.quantity}
              </li>
            ))}
          </ul>
        )}
      </div>

      {review.existingCorrectiveClean ? (
        <p className="text-sm">
          A corrective clean already exists.{" "}
          <Link
            href={`/jobs/${review.existingCorrectiveClean.id}`}
            className="underline underline-offset-4"
          >
            Open corrective clean
          </Link>
        </p>
      ) : canCreate ? (
        <form action={action} className="space-y-3">
          <input type="hidden" name="jobId" value={review.jobId} />
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="cleaning-corrective-clean-date">Corrective clean date</Label>
              <Input
                id="cleaning-corrective-clean-date"
                name="date"
                type="date"
                required
                className="w-44"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cleaning-corrective-clean-time">Start time ({timeZone})</Label>
              <Input
                id="cleaning-corrective-clean-time"
                name="time"
                type="time"
                defaultValue={DEFAULT_CORRECTIVE_CLEAN_TIME}
                className="w-36"
              />
            </div>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="confirmCreate"
              value="1"
              required
              className="mt-1"
            />
            <span>
              I confirm this one corrective Cleaning job. It will not create a
              next booking, invoice, charge, or customer message.
            </span>
          </label>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Scheduling…" : "Schedule corrective clean"}
          </Button>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">
          Only the business owner can schedule the corrective clean after
          reviewing the original job, customer, property, and selected service
          scope.
        </p>
      )}

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-sm text-muted-foreground">{state.message}</p> : null}
    </div>
  );
}

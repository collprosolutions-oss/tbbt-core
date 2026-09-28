"use client";

import { useActionState } from "react";
import Link from "next/link";
import {
  createCleaningNextBookingAction,
  type CleaningNextBookingActionState,
} from "@/app/actions/cleaning-next-booking";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CleaningNextBookingReview } from "@/lib/cleaning-next-booking-data";
import { DEFAULT_NEXT_BOOKING_TIME } from "@/lib/cleaning-next-booking";

const initial: CleaningNextBookingActionState = {};

export function CleaningNextBookingForm({
  review,
  canCreate,
  timeZone,
}: {
  review: CleaningNextBookingReview;
  canCreate: boolean;
  timeZone: string;
}) {
  const [state, action, pending] = useActionState(createCleaningNextBookingAction, initial);

  return (
    <div className="space-y-4">
      <div className="space-y-1 text-sm">
        <p>Customer: {review.customer?.name ?? "None on this job"}</p>
        <p>
          Property: {review.property?.addressSummary ?? "None on this job"}
        </p>
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

      {review.existingNextBooking ? (
        <p className="text-sm">
          A next booking already exists.{" "}
          <Link
            href={`/jobs/${review.existingNextBooking.id}`}
            className="underline underline-offset-4"
          >
            Open next booking
          </Link>
        </p>
      ) : canCreate ? (
        <form action={action} className="space-y-3">
          <input type="hidden" name="jobId" value={review.jobId} />
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="cleaning-next-booking-date">Next booking date</Label>
              <Input
                id="cleaning-next-booking-date"
                name="date"
                type="date"
                required
                className="w-44"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cleaning-next-booking-time">Start time ({timeZone})</Label>
              <Input
                id="cleaning-next-booking-time"
                name="time"
                type="time"
                defaultValue={DEFAULT_NEXT_BOOKING_TIME}
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
              I confirm this one next booking. It will not create a recurring series, invoice, or customer message.
            </span>
          </label>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Creating…" : "Create next booking"}
          </Button>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">
          Only the business owner can create the next booking after reviewing
          the customer, property, and selected service scope.
        </p>
      )}

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-sm text-muted-foreground">{state.message}</p> : null}
    </div>
  );
}

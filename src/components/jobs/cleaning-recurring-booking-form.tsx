"use client";

import { useActionState } from "react";
import Link from "next/link";
import {
  fillCleaningRecurringBookingsAction,
  resumeCleaningRecurringBookingsAction,
  setupCleaningRecurringBookingsAction,
  stopCleaningRecurringBookingsAction,
  type CleaningRecurringBookingActionState,
} from "@/app/actions/cleaning-recurring-booking";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DEFAULT_RECURRING_BOOKING_TIME } from "@/lib/cleaning-recurring-booking";
import type { CleaningRecurringBookingReview } from "@/lib/cleaning-recurring-booking-data";
import { cadenceLabel } from "@/lib/recurrence";

const initial: CleaningRecurringBookingActionState = {};

function ActionMessage({ state }: { state: CleaningRecurringBookingActionState }) {
  return (
    <>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-sm text-muted-foreground">{state.message}</p> : null}
    </>
  );
}

export function CleaningRecurringBookingForm({
  review,
  timeZone,
}: {
  review: CleaningRecurringBookingReview;
  timeZone: string;
}) {
  const [setupState, setupAction, setupPending] = useActionState(
    setupCleaningRecurringBookingsAction,
    initial,
  );
  const [fillState, fillAction, fillPending] = useActionState(
    fillCleaningRecurringBookingsAction,
    initial,
  );
  const [stopState, stopAction, stopPending] = useActionState(
    stopCleaningRecurringBookingsAction,
    initial,
  );
  const [resumeState, resumeAction, resumePending] = useActionState(
    resumeCleaningRecurringBookingsAction,
    initial,
  );

  const scheduleLabel = review.cadence ? cadenceLabel(review.cadence) : "Not set";
  const statusLabel =
    review.recurrenceStatus === "ACTIVE"
      ? "Active"
      : review.recurrenceStatus === "CANCELLED"
        ? "Stopped"
        : "Not started";

  return (
    <div className="space-y-4">
      <div className="space-y-1 text-sm">
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
        <p>Schedule: {scheduleLabel}</p>
        <p>Series: {statusLabel}</p>
      </div>

      {review.isOccurrence && review.sourceJobId ? (
        <p className="text-sm">
          This job is one recurring occurrence.{" "}
          <Link
            href={`/jobs/${review.sourceJobId}`}
            className="underline underline-offset-4"
          >
            Open the recurring schedule
          </Link>
        </p>
      ) : null}

      {review.occurrences.length > 0 ? (
        <div className="space-y-2 text-sm">
          <p>Upcoming and scheduled occurrences:</p>
          <ul className="list-disc space-y-1 pl-5">
            {review.occurrences.map((row) => (
              <li key={row.id}>
                <Link href={`/jobs/${row.id}`} className="underline underline-offset-4">
                  {row.civilDate ?? "Unscheduled"}
                </Link>
                {` · ${row.status.toLowerCase()}`}
                {row.recurrenceStatus === "CANCELLED" ? " · stopped" : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {review.canSetup ? (
        <form action={setupAction} className="space-y-3">
          <input type="hidden" name="jobId" value={review.jobId} />
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="cleaning-recurring-cadence">Cadence</Label>
              <select
                id="cleaning-recurring-cadence"
                name="cadence"
                defaultValue={review.cadence || "WEEKLY"}
                className="h-9 rounded-md border bg-background px-2 text-sm"
              >
                <option value="WEEKLY">Weekly</option>
                <option value="BIWEEKLY">Every two weeks</option>
                <option value="MONTHLY">Monthly</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="cleaning-recurring-date">First booking date</Label>
              <Input
                id="cleaning-recurring-date"
                name="date"
                type="date"
                required
                className="w-44"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cleaning-recurring-time">Start time ({timeZone})</Label>
              <Input
                id="cleaning-recurring-time"
                name="time"
                type="time"
                defaultValue={DEFAULT_RECURRING_BOOKING_TIME}
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
              I confirm this recurring Cleaning schedule. It creates future
              bookings on this cadence. It will not create a one-time next
              booking, corrective clean, invoice, or customer message.
            </span>
          </label>
          <Button type="submit" size="sm" disabled={setupPending}>
            {setupPending ? "Scheduling…" : "Start recurring bookings"}
          </Button>
        </form>
      ) : null}

      {review.canFillUpcoming ? (
        <form action={fillAction} className="space-y-2">
          <input type="hidden" name="jobId" value={review.jobId} />
          <Button type="submit" size="sm" variant="outline" disabled={fillPending}>
            {fillPending ? "Updating…" : "Fill upcoming bookings"}
          </Button>
        </form>
      ) : null}

      {review.canStop ? (
        <form action={stopAction} className="space-y-3">
          <input type="hidden" name="jobId" value={review.jobId} />
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="confirmStop"
              value="1"
              required
              className="mt-1"
            />
            <span>
              Stop this recurring schedule. Future unstarted bookings are
              canceled. Started and completed work is left alone. Existing jobs
              are not deleted, invoiced, or messaged.
            </span>
          </label>
          <Button type="submit" size="sm" variant="outline" disabled={stopPending}>
            {stopPending ? "Stopping…" : "Stop recurring bookings"}
          </Button>
        </form>
      ) : null}

      {review.canResume ? (
        <form action={resumeAction} className="space-y-3">
          <input type="hidden" name="jobId" value={review.jobId} />
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="confirmResume"
              value="1"
              required
              className="mt-1"
            />
            <span>
              Resume this recurring Cleaning schedule and fill upcoming bookings
              in the business timezone.
            </span>
          </label>
          <Button type="submit" size="sm" disabled={resumePending}>
            {resumePending ? "Resuming…" : "Resume recurring bookings"}
          </Button>
        </form>
      ) : null}

      {!review.canSetup &&
      !review.canStop &&
      !review.canResume &&
      !review.canFillUpcoming &&
      !review.isOccurrence ? (
        <p className="text-sm text-muted-foreground">
          Only the business owner can set up or stop recurring Cleaning bookings
          after reviewing the customer, property, and selected service scope.
        </p>
      ) : null}

      <ActionMessage state={setupState} />
      <ActionMessage state={fillState} />
      <ActionMessage state={stopState} />
      <ActionMessage state={resumeState} />
    </div>
  );
}

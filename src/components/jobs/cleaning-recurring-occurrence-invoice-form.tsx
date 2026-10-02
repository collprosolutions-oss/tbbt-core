"use client";

import { useActionState } from "react";
import Link from "next/link";
import {
  createDraftInvoiceFromCompletedRecurringOccurrence,
  type InvoiceActionState,
} from "@/app/actions/invoice";
import { Button } from "@/components/ui/button";
import type { RecurringOccurrenceInvoiceReview } from "@/lib/recurring-occurrence-invoice";

const initial: InvoiceActionState = {};

export function CleaningRecurringOccurrenceInvoiceForm({
  review,
}: {
  review: RecurringOccurrenceInvoiceReview;
}) {
  const [state, action, pending] = useActionState(
    createDraftInvoiceFromCompletedRecurringOccurrence,
    initial,
  );

  return (
    <div className="space-y-3">
      <div className="space-y-1 text-sm">
        <p>Recurring booking: {review.civilDate ?? review.occurrenceKey}</p>
        <p>
          Original job:{" "}
          <Link
            href={`/jobs/${review.sourceJobId}`}
            className="underline underline-offset-4"
          >
            Open the recurring schedule
          </Link>
        </p>
        <p>Customer: {review.customerName ?? "None on this booking"}</p>
        <p>Property: {review.propertyLabel ?? "None on this booking"}</p>
        {review.versionNumber != null ? (
          <p>Approved estimate version {review.versionNumber}</p>
        ) : null}
        <p>Approved work to invoice:</p>
        {review.lines.length === 0 ? (
          <p className="text-muted-foreground">No approved work is linked.</p>
        ) : (
          <ul className="list-disc space-y-1 pl-5">
            {review.lines.map((line, index) => (
              <li key={`${line.description}-${index}`}>
                {line.description} × {line.quantity} · {line.unitPrice} · {line.total}
              </li>
            ))}
          </ul>
        )}
        <p>Draft total: {review.totalLabel}</p>
      </div>

      {review.canCreate && review.invoices.length === 0 ? (
        <form action={action} className="space-y-3">
          <input type="hidden" name="jobId" value={review.jobId} />
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="confirmCreate"
              value="1"
              required
              className="mt-1"
            />
            <span>
              Create a draft invoice for this completed recurring booking only.
              It will not send, charge, or bill the original job or another
              booking.
            </span>
          </label>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Creating draft…" : "Create draft invoice"}
          </Button>
        </form>
      ) : null}

      {review.canCreate && review.existingInvoiceId && review.invoices.every((row) => row.status === "DRAFT") ? (
        <form action={action} className="space-y-2">
          <input type="hidden" name="jobId" value={review.jobId} />
          <input type="hidden" name="confirmCreate" value="1" />
          <p className="text-sm text-muted-foreground">
            Retrying this action reopens the same draft. It does not create
            another invoice or send it.
          </p>
          <Button type="submit" size="sm" variant="outline" disabled={pending}>
            {pending ? "Opening draft…" : "Reuse the same draft"}
          </Button>
        </form>
      ) : null}

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.message ? (
        <p className="text-sm text-muted-foreground">
          {state.message}
          {state.invoiceId ? (
            <>
              {" "}
              <Link
                href={`/invoices/${state.invoiceId}`}
                className="underline underline-offset-4"
              >
                Open draft
              </Link>
            </>
          ) : null}
        </p>
      ) : null}

      {!review.canCreate && review.status === "COMPLETED" ? (
        <p className="text-sm text-muted-foreground">
          Only the business owner can create a draft invoice after reviewing
          this completed recurring booking.
        </p>
      ) : null}
    </div>
  );
}

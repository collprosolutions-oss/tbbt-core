"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import {
  requestAdditionalWorkFromField,
  type FieldJobActionState,
} from "@/app/actions/field-job";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

const initialState: FieldJobActionState = {};

/**
 * "Customer Asked for More Work" -- creates an AdditionalWorkRequest
 * (source: EMPLOYEE), the exact same review-item model the Customer
 * Project Portal's own request form uses (see
 * requestAdditionalWorkFromField in src/app/actions/field-job.ts). Never
 * changes approved scope, project total, or the invoice, never creates or
 * approves a Change Order, and never quotes a price -- owner/admin reviews
 * it from the Work Order and decides.
 */
export function RequestAdditionalWorkFieldForm({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(
    requestAdditionalWorkFromField,
    initialState,
  );
  const wasPending = useRef(false);

  useEffect(() => {
    if (wasPending.current && !pending && !state.error) {
      setOpen(false);
    }
    wasPending.current = pending;
  }, [pending, state]);

  if (!open) {
    return (
      <div className="space-y-2">
        <Button
          type="button"
          variant="outline"
          className="h-14 w-full text-base"
          onClick={() => setOpen(true)}
        >
          Customer Asked for More Work
        </Button>
        {state.message ? (
          <p className="text-sm text-muted-foreground">{state.message}</p>
        ) : null}
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-3 rounded-lg border p-3">
      <input type="hidden" name="jobId" value={jobId} />
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="additional-work-field-description">
          What did the customer ask for?
        </Label>
        <textarea
          id="additional-work-field-description"
          name="description"
          required
          rows={4}
          className="w-full rounded-lg border border-input bg-transparent p-2.5 text-base"
          placeholder="Describe the extra work the customer asked about."
        />
        <p className="text-xs text-muted-foreground">
          This only sends a request to the office -- it does not change the
          approved price or scope, and does not promise the customer
          anything.
        </p>
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={pending} className="h-12 flex-1 text-base">
          {pending ? "Sending…" : "Send to office"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          className="h-12 text-base"
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

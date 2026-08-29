"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import {
  reportJobProblem,
  type FieldJobActionState,
} from "@/app/actions/field-job";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

const initialState: FieldJobActionState = {};

const EXAMPLES = [
  "Access issue (can't get in / no one home)",
  "Unexpected condition found",
  "Damaged or missing material",
  "Work cannot proceed",
  "Safety concern",
  "Customer unavailable",
];

/**
 * "Report Problem" -- a factual operational issue tied to this job, visible
 * to OWNER/ADMIN on the Work Order (see reportJobProblem in
 * src/app/actions/field-job.ts). Never changes Job status, approved scope,
 * price, or the invoice.
 */
export function ReportProblemForm({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(
    reportJobProblem,
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
          Report Problem
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
        <Label htmlFor="problem-description">What&apos;s going on?</Label>
        <textarea
          id="problem-description"
          name="description"
          required
          rows={4}
          className="w-full rounded-lg border border-input bg-transparent p-2.5 text-base"
          placeholder={EXAMPLES[0]}
        />
        <p className="text-xs text-muted-foreground">
          Examples: {EXAMPLES.slice(1).join(" · ")}.
        </p>
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={pending} className="h-12 flex-1 text-base">
          {pending ? "Sending…" : "Send report"}
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

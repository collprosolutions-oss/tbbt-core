"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import {
  requestAdditionalWork,
  type RequestAdditionalWorkState,
} from "@/app/actions/public-additional-work-request";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

const initialState: RequestAdditionalWorkState = {};

/**
 * "+ Request Additional Work" on the Customer Project Portal. This is NOT
 * approval and does NOT create a Change Order by itself -- it only sends
 * the business a simple request for them to review (see
 * src/app/actions/public-additional-work-request.ts). Approved scope,
 * price, Job total, and the invoice are never changed by this alone.
 */
export function RequestAdditionalWorkForm({
  projectToken,
}: {
  projectToken: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(
    requestAdditionalWork,
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
        <Button type="button" variant="outline" onClick={() => setOpen(true)}>
          + Request Additional Work
        </Button>
        {state.message ? (
          <p className="text-sm text-muted-foreground">{state.message}</p>
        ) : null}
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-3 rounded-lg border p-3">
      <input type="hidden" name="projectToken" value={projectToken} />
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="additional-work-description">
          What additional work would you like?
        </Label>
        <textarea
          id="additional-work-description"
          name="description"
          required
          rows={4}
          className="w-full rounded-lg border border-input bg-transparent p-2.5 text-sm"
          placeholder="Describe the additional work you'd like us to look at."
        />
        <p className="text-xs text-muted-foreground">
          This sends a request only -- it does not change your approved
          project or price. We&apos;ll follow up with pricing if it turns
          into additional work.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Sending…" : "Send request"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

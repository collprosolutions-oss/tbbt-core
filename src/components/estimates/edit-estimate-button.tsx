"use client";

import { useActionState } from "react";
import {
  returnEstimateToDraft,
  type EstimateActionState,
} from "@/app/actions/estimate";
import { Button } from "@/components/ui/button";

const initialState: EstimateActionState = {};

export function EditEstimateButton({ estimateId }: { estimateId: string }) {
  const [state, formAction, pending] = useActionState(
    returnEstimateToDraft,
    initialState,
  );

  return (
    <form
      action={(formData) => {
        if (
          !window.confirm(
            "Edit this estimate? It will return to draft. You must send it again before the customer can approve it.",
          )
        ) {
          return;
        }
        formAction(formData);
      }}
    >
      <input type="hidden" name="estimateId" value={estimateId} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Returning to draft…" : "Edit Estimate"}
      </Button>
      {state.error ? (
        <p className="mt-2 text-sm text-destructive">{state.error}</p>
      ) : null}
    </form>
  );
}

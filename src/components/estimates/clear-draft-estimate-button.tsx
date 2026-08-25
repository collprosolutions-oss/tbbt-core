"use client";

import { useActionState } from "react";
import {
  clearDraftEstimate,
  type EstimateActionState,
} from "@/app/actions/estimate";
import { Button } from "@/components/ui/button";

const initialState: EstimateActionState = {};

export function ClearDraftEstimateButton({
  estimateId,
}: {
  estimateId: string;
}) {
  const [state, formAction, pending] = useActionState(
    clearDraftEstimate,
    initialState,
  );

  return (
    <form
      action={(formData) => {
        if (
          !window.confirm(
            "Clear this draft estimate? All line items will be removed. The estimate, customer, and request stay.",
          )
        ) {
          return;
        }
        formAction(formData);
      }}
    >
      <input type="hidden" name="estimateId" value={estimateId} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Clearing…" : "Clear estimate"}
      </Button>
      {state.error ? (
        <p className="mt-2 text-sm text-destructive">{state.error}</p>
      ) : null}
    </form>
  );
}

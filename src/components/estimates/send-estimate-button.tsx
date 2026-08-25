"use client";

import { useActionState } from "react";
import {
  sendEstimate,
  type EstimateActionState,
} from "@/app/actions/estimate";
import { Button } from "@/components/ui/button";

const initialState: EstimateActionState = {};

export function SendEstimateButton({
  estimateId,
  disabled,
}: {
  estimateId: string;
  disabled?: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    sendEstimate,
    initialState,
  );

  return (
    <form action={formAction}>
      <input type="hidden" name="estimateId" value={estimateId} />
      <Button type="submit" size="sm" disabled={pending || disabled}>
        {pending ? "Sending…" : "Send Estimate"}
      </Button>
      {disabled ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Add at least one line item before sending.
        </p>
      ) : null}
      {state.error ? (
        <p className="mt-2 text-sm text-destructive">{state.error}</p>
      ) : null}
    </form>
  );
}

"use client";

import { useActionState } from "react";
import {
  removeEstimateLineItem,
  type EstimateActionState,
} from "@/app/actions/estimate";
import { Button } from "@/components/ui/button";

const initialState: EstimateActionState = {};

export function RemoveLineItemButton({
  estimateId,
  lineItemId,
}: {
  estimateId: string;
  lineItemId: string;
}) {
  const [state, action, pending] = useActionState(
    removeEstimateLineItem,
    initialState,
  );

  return (
    <form action={action} className="shrink-0">
      <input type="hidden" name="estimateId" value={estimateId} />
      <input type="hidden" name="lineItemId" value={lineItemId} />
      <Button type="submit" size="sm" variant="ghost" disabled={pending}>
        {pending ? "Removing…" : "Remove"}
      </Button>
      {state.error ? (
        <p className="mt-1 text-xs text-destructive">{state.error}</p>
      ) : null}
    </form>
  );
}

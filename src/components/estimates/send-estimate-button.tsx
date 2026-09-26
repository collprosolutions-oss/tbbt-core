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
  blockedReason,
}: {
  estimateId: string;
  blockedReason?: string | null;
}) {
  const [state, formAction, pending] = useActionState(
    sendEstimate,
    initialState,
  );
  const disabled = Boolean(blockedReason);

  return (
    <form action={formAction}>
      <input type="hidden" name="estimateId" value={estimateId} />
      <Button type="submit" size="sm" disabled={pending || disabled}>
        {pending ? "Sending…" : "Send Estimate"}
      </Button>
      {blockedReason ? (
        <p className="mt-2 text-sm font-medium text-amber-800 dark:text-amber-300">
          {blockedReason}
        </p>
      ) : null}
      {state.error ? (
        <p className="mt-2 text-sm text-destructive">{state.error}</p>
      ) : null}
    </form>
  );
}

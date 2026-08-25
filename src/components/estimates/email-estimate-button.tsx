"use client";

import { useActionState } from "react";
import {
  emailSentEstimate,
  type EstimateActionState,
} from "@/app/actions/estimate";
import { Button } from "@/components/ui/button";

const initialState: EstimateActionState = {};

export function EmailEstimateButton({ estimateId }: { estimateId: string }) {
  const [state, formAction, pending] = useActionState(
    emailSentEstimate,
    initialState,
  );

  return (
    <form action={formAction}>
      <input type="hidden" name="estimateId" value={estimateId} />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Emailing…" : "Email Estimate"}
      </Button>
      {state.message ? (
        <p className="mt-2 text-sm text-foreground">{state.message}</p>
      ) : null}
      {state.error ? (
        <p className="mt-2 text-sm text-destructive">{state.error}</p>
      ) : null}
    </form>
  );
}

"use client";

import { useActionState, useEffect, useState } from "react";
import {
  emailSentEstimate,
  type EstimateActionState,
} from "@/app/actions/estimate";
import { Button } from "@/components/ui/button";

const initialState: EstimateActionState = {};

function newSendAttemptId() {
  return crypto.randomUUID();
}

export function EmailEstimateButton({ estimateId }: { estimateId: string }) {
  const [state, formAction, pending] = useActionState(
    emailSentEstimate,
    initialState,
  );
  const [sendAttemptId, setSendAttemptId] = useState(newSendAttemptId);

  useEffect(() => {
    if (state.message) {
      setSendAttemptId(newSendAttemptId());
    }
  }, [state.message]);

  return (
    <form action={formAction}>
      <input type="hidden" name="estimateId" value={estimateId} />
      <input type="hidden" name="sendAttemptId" value={sendAttemptId} />
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

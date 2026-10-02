"use client";

import { useActionState } from "react";
import {
  recordReceptionistDispositionAction,
  type CommunicationsActionState,
} from "@/app/actions/communications";
import { Button } from "@/components/ui/button";

const initialState: CommunicationsActionState = {};

export function ReceptionistDispositionForm({
  phoneInteractionId,
  businessId,
  customerId,
}: {
  phoneInteractionId: string;
  businessId: string;
  customerId?: string | null;
}) {
  const [state, action, pending] = useActionState(
    recordReceptionistDispositionAction,
    initialState,
  );

  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="phoneInteractionId" value={phoneInteractionId} />
      <input type="hidden" name="businessId" value={businessId} />
      {customerId ? <input type="hidden" name="customerId" value={customerId} /> : null}
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Recording…" : "Record handled"}
      </Button>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}

"use client";

import { useActionState } from "react";
import {
  retryFailedSmsDeliveryAction,
  type CommunicationsActionState,
} from "@/app/actions/communications";
import { Button } from "@/components/ui/button";

export function RetryFailedSmsButton({
  communicationId,
  businessId,
  disabled,
}: {
  communicationId: string;
  businessId: string;
  disabled?: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    retryFailedSmsDeliveryAction,
    {} as CommunicationsActionState,
  );

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="communicationId" value={communicationId} />
      <input type="hidden" name="businessId" value={businessId} />
      <Button type="submit" size="sm" variant="outline" disabled={pending || disabled}>
        {pending ? "Retrying…" : "Retry SMS"}
      </Button>
      {state.message ? <p className="text-sm text-foreground">{state.message}</p> : null}
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
    </form>
  );
}

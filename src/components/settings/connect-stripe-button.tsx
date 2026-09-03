"use client";

import { useActionState } from "react";
import {
  startStripeConnect,
  type PaymentSettingsActionState,
} from "@/app/actions/payments";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

const initialState: PaymentSettingsActionState = {};

export function ConnectStripeButton({
  label,
  disabled,
}: {
  label: string;
  disabled?: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    startStripeConnect,
    initialState,
  );

  return (
    <form action={formAction} className="space-y-3">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" size="sm" disabled={disabled || pending}>
        {pending ? "Opening Stripe…" : label}
      </Button>
    </form>
  );
}

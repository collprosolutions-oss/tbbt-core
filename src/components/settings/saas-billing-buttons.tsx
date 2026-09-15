"use client";

import { useActionState } from "react";
import {
  startSaasBillingPortalAction,
  startSaasSubscriptionCheckoutAction,
  type SaasBillingActionState,
} from "@/app/actions/saas-billing";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

const initialState: SaasBillingActionState = {};

export function SaasSubscribeButton({
  disabled,
}: {
  disabled?: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    startSaasSubscriptionCheckoutAction,
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
        {pending ? "Opening Stripe…" : "Subscribe to TBBT"}
      </Button>
    </form>
  );
}

export function SaasBillingPortalButton({
  disabled,
}: {
  disabled?: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    startSaasBillingPortalAction,
    initialState,
  );

  return (
    <form action={formAction} className="space-y-3">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" size="sm" variant="outline" disabled={disabled || pending}>
        {pending ? "Opening Stripe…" : "Manage billing"}
      </Button>
    </form>
  );
}

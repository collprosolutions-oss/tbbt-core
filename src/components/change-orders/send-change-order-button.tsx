"use client";

import { useActionState } from "react";
import {
  sendChangeOrder,
  type ChangeOrderActionState,
} from "@/app/actions/change-order";
import { Button } from "@/components/ui/button";

const initialState: ChangeOrderActionState = {};

export function SendChangeOrderButton({
  changeOrderId,
  disabled,
}: {
  changeOrderId: string;
  disabled?: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    sendChangeOrder,
    initialState,
  );

  return (
    <form action={formAction}>
      <input type="hidden" name="changeOrderId" value={changeOrderId} />
      <Button type="submit" size="sm" disabled={pending || disabled}>
        {pending ? "Sending…" : "Send to Customer"}
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

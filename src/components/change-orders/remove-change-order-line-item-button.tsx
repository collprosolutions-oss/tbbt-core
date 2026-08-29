"use client";

import { useActionState } from "react";
import {
  removeChangeOrderLineItem,
  type ChangeOrderActionState,
} from "@/app/actions/change-order";
import { Button } from "@/components/ui/button";

const initialState: ChangeOrderActionState = {};

export function RemoveChangeOrderLineItemButton({
  changeOrderId,
  lineItemId,
}: {
  changeOrderId: string;
  lineItemId: string;
}) {
  const [state, action, pending] = useActionState(
    removeChangeOrderLineItem,
    initialState,
  );

  return (
    <form action={action} className="shrink-0">
      <input type="hidden" name="changeOrderId" value={changeOrderId} />
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

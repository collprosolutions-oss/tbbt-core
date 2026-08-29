"use client";

import { useActionState } from "react";
import {
  cancelChangeOrder,
  type ChangeOrderActionState,
} from "@/app/actions/change-order";
import { Button } from "@/components/ui/button";

const initialState: ChangeOrderActionState = {};

export function CancelChangeOrderButton({
  changeOrderId,
}: {
  changeOrderId: string;
}) {
  const [state, formAction, pending] = useActionState(
    cancelChangeOrder,
    initialState,
  );

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (
          !window.confirm(
            "Cancel this change order? This cannot be undone. If the customer already saw it, they will see it as cancelled.",
          )
        ) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="changeOrderId" value={changeOrderId} />
      <Button
        type="submit"
        size="sm"
        variant="destructive"
        disabled={pending}
      >
        {pending ? "Cancelling…" : "Cancel Change Order"}
      </Button>
      {state.error ? (
        <p className="mt-2 text-sm text-destructive">{state.error}</p>
      ) : null}
    </form>
  );
}

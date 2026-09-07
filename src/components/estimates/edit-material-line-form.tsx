"use client";

import { useActionState, useState } from "react";
import {
  updateEstimateMaterialCustomerLine,
  type EstimateActionState,
} from "@/app/actions/estimate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initialState: EstimateActionState = {};

export function EditMaterialLineForm({
  estimateId,
  lineItemId,
  title,
  quantity,
}: {
  estimateId: string;
  lineItemId: string;
  title: string;
  quantity: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(
    updateEstimateMaterialCustomerLine,
    initialState,
  );

  if (!open) {
    return (
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Edit
      </Button>
    );
  }

  return (
    <form action={action} className="space-y-2 text-left">
      <input type="hidden" name="estimateId" value={estimateId} />
      <input type="hidden" name="lineItemId" value={lineItemId} />
      <div className="space-y-1">
        <Label htmlFor={`material-title-${lineItemId}`}>Description</Label>
        <Input
          id={`material-title-${lineItemId}`}
          name="title"
          defaultValue={title}
          required
          className="min-w-40"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`material-qty-${lineItemId}`}>Qty</Label>
        <Input
          id={`material-qty-${lineItemId}`}
          name="quantity"
          inputMode="decimal"
          defaultValue={quantity}
          required
          className="w-24"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      {state.message ? (
        <p className="text-xs text-muted-foreground">{state.message}</p>
      ) : null}
    </form>
  );
}

"use client";

import { useActionState } from "react";
import {
  priceEstimateLineItem,
  type EstimateActionState,
} from "@/app/actions/estimate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initialState: EstimateActionState = {};

export function PriceRequiredLineForm({
  estimateId,
  lineItemId,
  quantity,
}: {
  estimateId: string;
  lineItemId: string;
  quantity: string;
}) {
  const [state, action, pending] = useActionState(priceEstimateLineItem, initialState);

  return (
    <form action={action} className="mt-2 space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
      <input type="hidden" name="estimateId" value={estimateId} />
      <input type="hidden" name="lineItemId" value={lineItemId} />
      <p className="text-sm font-medium text-foreground">Price required</p>
      <p className="text-xs text-muted-foreground">
        Enter the unit price for this job. This does not add the work to the
        service catalog.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor={`qty-${lineItemId}`}>Quantity</Label>
          <Input
            id={`qty-${lineItemId}`}
            name="quantity"
            inputMode="decimal"
            defaultValue={quantity}
            required
            className="h-8 w-24"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`price-${lineItemId}`}>Unit price</Label>
          <Input
            id={`price-${lineItemId}`}
            name="unitPrice"
            inputMode="decimal"
            placeholder="0.00"
            required
            className="h-8 w-28"
          />
        </div>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save price"}
        </Button>
      </div>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-sm text-emerald-600">{state.message}</p> : null}
    </form>
  );
}

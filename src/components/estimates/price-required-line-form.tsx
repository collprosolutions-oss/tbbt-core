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
    <form
      action={action}
      className="mt-3 space-y-3 rounded-lg border-2 border-amber-500 bg-amber-100 p-4 text-amber-950 dark:bg-amber-950/40 dark:text-amber-50"
    >
      <input type="hidden" name="estimateId" value={estimateId} />
      <input type="hidden" name="lineItemId" value={lineItemId} />
      <p className="text-base font-semibold">Price required</p>
      <p className="text-sm">
        Enter the unit price on this original request line. Do not add a second
        custom item and do not create a catalog item.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor={`qty-${lineItemId}`} className="text-amber-950 dark:text-amber-50">
            Quantity
          </Label>
          <Input
            id={`qty-${lineItemId}`}
            name="quantity"
            inputMode="decimal"
            defaultValue={quantity}
            required
            className="h-10 w-28 bg-background"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`price-${lineItemId}`} className="text-amber-950 dark:text-amber-50">
            Unit price
          </Label>
          <Input
            id={`price-${lineItemId}`}
            name="unitPrice"
            inputMode="decimal"
            placeholder="0.00"
            required
            className="h-10 w-36 bg-background"
          />
        </div>
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? "Saving…" : "Save Price"}
        </Button>
      </div>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">{state.message}</p> : null}
    </form>
  );
}

"use client";

import { useActionState } from "react";
import { overrideEstimateLinePrice, type EstimateActionState } from "@/app/actions/estimate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initialState: EstimateActionState = {};

export function OverrideLinePriceForm({
  estimateId,
  lineItemId,
  currentPrice,
  label = "Override line price",
}: {
  estimateId: string;
  lineItemId: string;
  currentPrice: string;
  label?: string;
}) {
  const [state, action, pending] = useActionState(overrideEstimateLinePrice, initialState);

  return (
    <form action={action} className="mt-2 space-y-2">
      <input type="hidden" name="estimateId" value={estimateId} />
      <input type="hidden" name="lineItemId" value={lineItemId} />
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor={`override-price-${lineItemId}`}>{label}</Label>
          <Input
            id={`override-price-${lineItemId}`}
            name="unitPrice"
            inputMode="decimal"
            defaultValue={currentPrice}
            required
            className="w-36"
          />
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {pending ? "Saving…" : "Save override"}
        </Button>
      </div>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.message ? (
        <p className="text-sm text-muted-foreground">{state.message}</p>
      ) : null}
    </form>
  );
}

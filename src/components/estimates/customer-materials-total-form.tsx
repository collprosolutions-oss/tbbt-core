"use client";

import { useActionState } from "react";
import {
  setEstimateCustomerMaterialsTotal,
  type EstimateActionState,
} from "@/app/actions/estimate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoney } from "@/lib/format";

const initialState: EstimateActionState = {};

export function CustomerMaterialsTotalForm({
  estimateId,
  calculatedLabel,
  currentAmount,
  manual,
  differs,
}: {
  estimateId: string;
  calculatedLabel: string;
  currentAmount: string;
  manual: boolean;
  differs: boolean;
}) {
  const [state, action, pending] = useActionState(
    setEstimateCustomerMaterialsTotal,
    initialState,
  );

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-border p-3">
      <p className="text-sm font-medium">Final customer materials total</p>
      <p className="text-xs text-muted-foreground">
        The customer sees this one materials price, not individual material
        line prices. Recalculation does not overwrite a saved amount unless
        you use the calculated total.
      </p>
      <p className="text-sm">Calculated Materials Total: {calculatedLabel}</p>
      {manual ? (
        <p className="text-sm">
          Saved Final Customer Materials Total: {formatMoney(currentAmount)}
        </p>
      ) : null}
      {differs ? (
        <p className="text-sm text-amber-800 dark:text-amber-300">
          Final Customer Materials Total differs from the calculated total.
          Changing quantities, markup, or unit cost will not overwrite it.
        </p>
      ) : null}
      <form action={action} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="estimateId" value={estimateId} />
        <div className="space-y-1">
          <Label htmlFor="customer-materials-total-amount">
            Final Customer Materials Total
          </Label>
          <Input
            id="customer-materials-total-amount"
            name="amount"
            inputMode="decimal"
            defaultValue={currentAmount}
            className="w-36"
          />
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={pending} name="mode" value="save">
          {pending ? "Saving…" : "Save materials total"}
        </Button>
        <Button
          type="submit"
          size="sm"
          variant="ghost"
          disabled={pending}
          name="mode"
          value="calculated"
        >
          Use calculated total
        </Button>
      </form>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.message ? (
        <p className="text-sm text-muted-foreground">{state.message}</p>
      ) : null}
    </div>
  );
}

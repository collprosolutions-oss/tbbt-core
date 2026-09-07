"use client";

import { useActionState } from "react";
import {
  setEstimateMaterialDeposit,
  type EstimateActionState,
} from "@/app/actions/estimate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoney } from "@/lib/format";

const initialState: EstimateActionState = {};

export function MaterialDepositForm({
  estimateId,
  suggestedLabel,
  currentAmount,
  remainingLabel,
  manual,
  suggestedChanged,
}: {
  estimateId: string;
  suggestedLabel: string;
  currentAmount: string;
  remainingLabel: string;
  manual: boolean;
  suggestedChanged: boolean;
}) {
  const [state, action, pending] = useActionState(
    setEstimateMaterialDeposit,
    initialState,
  );

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-border p-3">
      <p className="text-sm font-medium">Material deposit</p>
      <p className="text-xs text-muted-foreground">
        Suggested deposit is the customer material total. It is part of the
        estimate total, not an extra fee. Labor is not included.
      </p>
      <p className="text-sm">Suggested material deposit: {suggestedLabel}</p>
      {manual ? (
        <p className="text-sm">Current deposit: {formatMoney(currentAmount)}</p>
      ) : null}
      {suggestedChanged ? (
        <p className="text-sm text-amber-800 dark:text-amber-300">
          Suggested material deposit has changed to {suggestedLabel}. The
          current deposit stays until you apply the new amount.
        </p>
      ) : null}
      <p className="text-sm">Remaining balance: {remainingLabel}</p>
      <form action={action} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="estimateId" value={estimateId} />
        <div className="space-y-1">
          <Label htmlFor="material-deposit-amount">Deposit amount</Label>
          <Input
            id="material-deposit-amount"
            name="amount"
            inputMode="decimal"
            defaultValue={currentAmount}
            className="w-36"
          />
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={pending} name="mode" value="save">
          {pending ? "Saving…" : "Save deposit"}
        </Button>
        <Button
          type="submit"
          size="sm"
          variant="ghost"
          disabled={pending}
          name="mode"
          value="suggested"
        >
          Use suggested
        </Button>
        <Button
          type="submit"
          size="sm"
          variant="ghost"
          disabled={pending}
          name="mode"
          value="none"
        >
          No deposit
        </Button>
      </form>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.message ? (
        <p className="text-sm text-muted-foreground">{state.message}</p>
      ) : null}
    </div>
  );
}

"use client";

import { useActionState } from "react";
import { recordEstimateDeposit, type DepositActionState } from "@/app/actions/deposit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PAYMENT_METHODS } from "@/lib/invoice-payment";

const initialState: DepositActionState = {};

export function RecordDepositForm({
  estimateId,
  remainingLabel,
}: {
  estimateId: string;
  remainingLabel: string;
}) {
  const [state, formAction, pending] = useActionState(
    recordEstimateDeposit,
    initialState,
  );

  return (
    <form action={formAction} className="space-y-3 rounded-lg border p-3">
      <input type="hidden" name="estimateId" value={estimateId} />
      <p className="text-sm font-medium">Record Deposit</p>
      <p className="text-xs text-muted-foreground">
        Use this for cash, check, Zelle, or another payment received outside
        Stripe. Remaining deposit due: {remainingLabel}.
      </p>
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.message ? (
        <p className="text-sm text-muted-foreground">{state.message}</p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="deposit-amount">Amount</Label>
          <Input id="deposit-amount" name="amount" inputMode="decimal" required />
        </div>
        <div className="space-y-1">
          <Label htmlFor="deposit-method">Payment method</Label>
          <select
            id="deposit-method"
            name="paymentMethod"
            required
            defaultValue=""
            className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
          >
            <option value="" disabled>
              Choose a method
            </option>
            {PAYMENT_METHODS.map((method) => (
              <option key={method.value} value={method.value}>
                {method.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="deposit-date">Received date</Label>
          <Input id="deposit-date" name="receivedAt" type="date" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="deposit-note">Note / reference (optional)</Label>
          <Input id="deposit-note" name="note" placeholder="Check #, Zelle name" />
        </div>
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Recording…" : "Record Deposit"}
      </Button>
    </form>
  );
}

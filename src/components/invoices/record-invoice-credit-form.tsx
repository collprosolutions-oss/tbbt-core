"use client";

import { useActionState, useId, useState } from "react";
import {
  recordInvoiceCredit,
  type InvoiceActionState,
} from "@/app/actions/invoice";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoney } from "@/lib/format";

const initialState: InvoiceActionState = {};

export function RecordInvoiceCreditForm({
  invoiceId,
  remainingDue,
}: {
  invoiceId: string;
  remainingDue: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(
    recordInvoiceCredit,
    initialState,
  );
  const generatedKey = useId().replace(/:/g, "");
  const [idempotencyKey] = useState(
    () =>
      globalThis.crypto?.randomUUID?.() ??
      `credit-${invoiceId}-${generatedKey}`,
  );
  const remainingAmount = Number(remainingDue);
  const noRemaining =
    Number.isFinite(remainingAmount) && remainingAmount <= 0;

  if (!open) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={noRemaining}
        onClick={() => setOpen(true)}
      >
        Record credit
      </Button>
    );
  }

  return (
    <form
      action={formAction}
      className="w-full space-y-3 rounded-lg border p-3"
    >
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <p className="text-sm text-muted-foreground">
        Record an internal credit against this issued invoice. Original
        lines and recorded payments stay as they are. This does not refund a
        card or message the customer.
      </p>
      <div className="space-y-2">
        <Label htmlFor="creditAmount">Credit amount</Label>
        <Input
          id="creditAmount"
          name="amount"
          inputMode="decimal"
          required
          defaultValue={remainingDue}
          className="w-36"
        />
        <p className="text-xs text-muted-foreground">
          Remaining due {formatMoney(remainingDue)}. Enter a smaller amount
          for a partial credit.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="creditReason">Reason</Label>
        <Input
          id="creditReason"
          name="reason"
          required
          placeholder="Price correction, goodwill, scope change…"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Recording…" : "Record credit"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
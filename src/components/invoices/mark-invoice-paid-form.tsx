"use client";

import { useActionState, useState } from "react";
import { markInvoicePaid, type InvoiceActionState } from "@/app/actions/invoice";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PAYMENT_METHODS } from "@/lib/invoice-payment";

const initialState: InvoiceActionState = {};

export function MarkInvoicePaidForm({ invoiceId }: { invoiceId: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(
    markInvoicePaid,
    initialState,
  );

  if (!open) {
    return (
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        Mark Paid
      </Button>
    );
  }

  return (
    <form
      action={formAction}
      className="w-full space-y-3 rounded-lg border p-3"
    >
      <input type="hidden" name="invoiceId" value={invoiceId} />
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="paymentMethod">Payment method</Label>
        <select
          id="paymentMethod"
          name="paymentMethod"
          required
          defaultValue=""
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
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
      <div className="space-y-2">
        <Label htmlFor="paymentReference">Reference / note (optional)</Label>
        <Input
          id="paymentReference"
          name="paymentReference"
          placeholder="Check #, transfer ID, etc."
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Recording…" : "Record Payment"}
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

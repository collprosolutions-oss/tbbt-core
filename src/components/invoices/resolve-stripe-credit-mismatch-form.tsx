"use client";

import { useActionState } from "react";
import {
  resolveInvoiceStripeCreditMismatch,
  type InvoiceActionState,
} from "@/app/actions/invoice";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

const initialState: InvoiceActionState = {};

export function ResolveStripeCreditMismatchForm({
  paymentId,
  invoiceId,
}: {
  paymentId: string;
  invoiceId: string;
}) {
  const [state, formAction, pending] = useActionState(
    resolveInvoiceStripeCreditMismatch,
    initialState,
  );

  return (
    <form action={formAction} className="mt-3">
      <input type="hidden" name="paymentId" value={paymentId} />
      <input type="hidden" name="invoiceId" value={invoiceId} />
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Resolving…" : "Mark review resolved"}
      </Button>
    </form>
  );
}
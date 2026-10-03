"use client";

import { useActionState, useEffect, useId, useRef } from "react";
import { markInvoiceSent, type InvoiceActionState } from "@/app/actions/invoice";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

const initialState: InvoiceActionState = {};

async function sendInvoice(
  _prev: InvoiceActionState,
  formData: FormData,
): Promise<InvoiceActionState> {
  return markInvoiceSent(String(formData.get("invoiceId") ?? ""));
}

export function MarkInvoiceSentButton({ invoiceId }: { invoiceId: string }) {
  const [state, formAction, pending] = useActionState(sendInvoice, initialState);
  const errorRef = useRef<HTMLDivElement>(null);
  const errorId = useId();

  useEffect(() => {
    if (state.error || state.warning) errorRef.current?.focus();
  }, [state.error, state.warning]);

  return (
    <form action={formAction}>
      <input type="hidden" name="invoiceId" value={invoiceId} />
      {state.error ? (
        <Alert
          ref={errorRef}
          id={errorId}
          tabIndex={-1}
          variant="destructive"
          className="mb-2"
        >
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.warning && !state.error ? (
        <Alert
          ref={errorRef}
          id={errorId}
          tabIndex={-1}
          className="mb-2"
        >
          <AlertDescription>{state.warning}</AlertDescription>
        </Alert>
      ) : null}
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={pending}
        aria-busy={pending || undefined}
        aria-describedby={state.error ? errorId : undefined}
      >
        {pending ? "Sending…" : "Send Invoice"}
      </Button>
    </form>
  );
}

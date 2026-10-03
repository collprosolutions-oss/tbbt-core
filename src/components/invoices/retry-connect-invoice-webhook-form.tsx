"use client";

import { useActionState } from "react";
import {
  retryInvoiceConnectWebhookEvent,
  type InvoiceActionState,
} from "@/app/actions/invoice";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CONNECT_INVOICE_WEBHOOK_RETRY_LABEL } from "@/lib/connect-invoice-webhook";

const initialState: InvoiceActionState = {};

export function RetryConnectInvoiceWebhookForm({
  eventId,
  invoiceId,
}: {
  eventId: string;
  invoiceId?: string | null;
}) {
  const [state, formAction, pending] = useActionState(
    retryInvoiceConnectWebhookEvent,
    initialState,
  );

  return (
    <form action={formAction} className="mt-3">
      <input type="hidden" name="eventId" value={eventId} />
      {invoiceId ? <input type="hidden" name="invoiceId" value={invoiceId} /> : null}
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Retrying…" : CONNECT_INVOICE_WEBHOOK_RETRY_LABEL}
      </Button>
    </form>
  );
}

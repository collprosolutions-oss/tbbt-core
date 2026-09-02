"use client";

import { useTransition } from "react";
import { markInvoiceSent } from "@/app/actions/invoice";
import { Button } from "@/components/ui/button";

export function MarkInvoiceSentButton({ invoiceId }: { invoiceId: string }) {
  const [isPending, startTransition] = useTransition();

  return (
    <form
      action={() => {
        if (isPending) return;
        startTransition(async () => {
          await markInvoiceSent(invoiceId);
        });
      }}
    >
      <Button type="submit" size="sm" variant="outline" disabled={isPending}>
        {isPending ? "Sending…" : "Send Invoice"}
      </Button>
    </form>
  );
}

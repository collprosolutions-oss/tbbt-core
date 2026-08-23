"use client";

import { markInvoicePaid } from "@/app/actions/invoice";
import { Button } from "@/components/ui/button";

export function MarkInvoicePaidButton({ invoiceId }: { invoiceId: string }) {
  return (
    <form
      action={async () => {
        await markInvoicePaid(invoiceId);
      }}
    >
      <Button type="submit" size="sm">
        Mark paid
      </Button>
    </form>
  );
}

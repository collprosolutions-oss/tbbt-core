"use client";

import { createInvoiceFromJob } from "@/app/actions/invoice";
import { Button } from "@/components/ui/button";

export function CreateInvoiceButton({ jobId }: { jobId: string }) {
  return (
    <form
      action={async () => {
        await createInvoiceFromJob(jobId);
      }}
    >
      <Button type="submit" size="sm">
        Create invoice
      </Button>
    </form>
  );
}

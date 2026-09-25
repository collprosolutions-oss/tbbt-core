"use client";

import { useTransition } from "react";
import { createInvoiceFromJob } from "@/app/actions/invoice";
import { Button } from "@/components/ui/button";

export function CreateInvoiceButton({
  jobId,
  label = "Create invoice",
}: {
  jobId: string;
  label?: string;
}) {
  const [isPending, startTransition] = useTransition();

  return (
    <form
      action={() => {
        if (isPending) return;
        startTransition(async () => {
          await createInvoiceFromJob(jobId);
        });
      }}
    >
      <Button type="submit" size="sm" disabled={isPending}>
        {isPending ? "Creating…" : label}
      </Button>
    </form>
  );
}

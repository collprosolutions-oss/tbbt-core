"use client";

import Link from "next/link";
import { useActionState } from "react";
import { markJobComplete, type JobActionState } from "@/app/actions/job";
import { Button } from "@/components/ui/button";
import { completeJobDraftInvoiceHref } from "@/lib/complete-job-copy";

const initialState: JobActionState = {};

export function MarkJobCompleteButton({ jobId }: { jobId: string }) {
  const [state, formAction, pending] = useActionState(
    markJobComplete,
    initialState,
  );
  const invoiceHref =
    state.invoiceHref ??
    (state.invoiceId ? completeJobDraftInvoiceHref(state.invoiceId) : null);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="jobId" value={jobId} />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Completing…" : "Complete Job"}
      </Button>
      {state.error ? (
        <p className="text-sm text-destructive">{state.error}</p>
      ) : null}
      {state.warning ? (
        <p className="text-sm text-amber-600">{state.warning}</p>
      ) : null}
      {state.message ? (
        <p className="text-sm text-muted-foreground">{state.message}</p>
      ) : null}
      {state.message && invoiceHref ? (
        <Button asChild size="sm" variant="outline">
          <Link href={invoiceHref}>Open invoice</Link>
        </Button>
      ) : null}
    </form>
  );
}

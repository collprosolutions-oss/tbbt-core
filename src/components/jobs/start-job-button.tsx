"use client";

import { useActionState } from "react";
import { startJob, type JobActionState } from "@/app/actions/job";
import { Button } from "@/components/ui/button";

const initialState: JobActionState = {};

export function StartJobButton({
  jobId,
  unpaidDepositWarning,
}: {
  jobId: string;
  unpaidDepositWarning?: string | null;
}) {
  const [state, formAction, pending] = useActionState(startJob, initialState);

  return (
    <form
      action={formAction}
      onSubmit={
        unpaidDepositWarning
          ? (event) => {
              if (
                !window.confirm(
                  `${unpaidDepositWarning}\n\nStart the job anyway?`,
                )
              ) {
                event.preventDefault();
              }
            }
          : undefined
      }
    >
      <input type="hidden" name="jobId" value={jobId} />
      {unpaidDepositWarning ? (
        <p className="mb-2 text-sm font-medium text-amber-800 dark:text-amber-300">
          {unpaidDepositWarning}
        </p>
      ) : null}
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Starting…" : "Start Job"}
      </Button>
      {state.error ? (
        <p className="mt-2 text-sm text-destructive">{state.error}</p>
      ) : null}
    </form>
  );
}

"use client";

import { useActionState } from "react";
import {
  createJobFromEstimate,
  type JobActionState,
} from "@/app/actions/job";
import { Button } from "@/components/ui/button";

const initialState: JobActionState = {};

export function CreateJobButton({
  estimateId,
  unpaidDepositWarning,
}: {
  estimateId: string;
  unpaidDepositWarning?: string | null;
}) {
  const [state, formAction, pending] = useActionState(
    createJobFromEstimate,
    initialState,
  );

  return (
    <form
      action={formAction}
      className="space-y-2"
      onSubmit={
        unpaidDepositWarning
          ? (event) => {
              if (
                !window.confirm(
                  `${unpaidDepositWarning}\n\nCreate the job anyway?`,
                )
              ) {
                event.preventDefault();
              }
            }
          : undefined
      }
    >
      <input type="hidden" name="estimateId" value={estimateId} />
      {unpaidDepositWarning ? (
        <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
          {unpaidDepositWarning}
        </p>
      ) : null}
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Creating…" : "Create job"}
      </Button>
      {state.error ? (
        <p className="mt-2 text-sm text-destructive">{state.error}</p>
      ) : null}
    </form>
  );
}

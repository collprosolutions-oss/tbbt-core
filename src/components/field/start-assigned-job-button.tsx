"use client";

import { useActionState } from "react";
import {
  startAssignedJob,
  type FieldJobActionState,
} from "@/app/actions/field-job";
import { Button } from "@/components/ui/button";
import { useSaasOperating } from "@/components/saas/saas-operating-context";

const initialState: FieldJobActionState = {};

export function StartAssignedJobButton({
  jobId,
  scheduled = true,
  appointmentConfirmed = true,
}: {
  jobId: string;
  scheduled?: boolean;
  appointmentConfirmed?: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    startAssignedJob,
    initialState,
  );
  const operating = useSaasOperating();

  if (!operating.canOperate) {
    return <p className="text-sm text-muted-foreground">{operating.blockedMessage}</p>;
  }

  if (!scheduled) {
    return (
      <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
        Waiting for the office to schedule this job.
      </p>
    );
  }

  if (!appointmentConfirmed) {
    return (
      <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
        Customer has not confirmed this appointment.
      </p>
    );
  }

  return (
    <form action={formAction} className="w-full">
      <input type="hidden" name="jobId" value={jobId} />
      <Button
        type="submit"
        disabled={pending}
        className="h-14 w-full text-base"
      >
        {pending ? "Starting…" : "Start Job"}
      </Button>
      {state.error ? (
        <p className="mt-2 text-sm text-destructive">{state.error}</p>
      ) : null}
    </form>
  );
}

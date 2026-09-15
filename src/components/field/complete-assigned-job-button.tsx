"use client";

import { useActionState } from "react";
import {
  completeAssignedJob,
  type FieldJobActionState,
} from "@/app/actions/field-job";
import { Button } from "@/components/ui/button";
import { useSaasOperating } from "@/components/saas/saas-operating-context";

const initialState: FieldJobActionState = {};

export function CompleteAssignedJobButton({ jobId }: { jobId: string }) {
  const [state, formAction, pending] = useActionState(
    completeAssignedJob,
    initialState,
  );
  const operating = useSaasOperating();

  if (!operating.canOperate) {
    return <p className="text-sm text-muted-foreground">{operating.blockedMessage}</p>;
  }

  return (
    <form action={formAction} className="w-full">
      <input type="hidden" name="jobId" value={jobId} />
      <Button
        type="submit"
        disabled={pending}
        className="h-14 w-full text-base"
      >
        {pending ? "Completing…" : "Complete Job"}
      </Button>
      {state.error ? (
        <p className="mt-2 text-sm text-destructive">{state.error}</p>
      ) : null}
    </form>
  );
}

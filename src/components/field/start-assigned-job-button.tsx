"use client";

import { useActionState } from "react";
import {
  startAssignedJob,
  type FieldJobActionState,
} from "@/app/actions/field-job";
import { Button } from "@/components/ui/button";

const initialState: FieldJobActionState = {};

export function StartAssignedJobButton({ jobId }: { jobId: string }) {
  const [state, formAction, pending] = useActionState(
    startAssignedJob,
    initialState,
  );

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

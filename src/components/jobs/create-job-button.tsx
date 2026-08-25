"use client";

import { useActionState } from "react";
import {
  createJobFromEstimate,
  type JobActionState,
} from "@/app/actions/job";
import { Button } from "@/components/ui/button";

const initialState: JobActionState = {};

export function CreateJobButton({ estimateId }: { estimateId: string }) {
  const [state, formAction, pending] = useActionState(
    createJobFromEstimate,
    initialState,
  );

  return (
    <form action={formAction}>
      <input type="hidden" name="estimateId" value={estimateId} />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Creating…" : "Create job"}
      </Button>
      {state.error ? (
        <p className="mt-2 text-sm text-destructive">{state.error}</p>
      ) : null}
    </form>
  );
}

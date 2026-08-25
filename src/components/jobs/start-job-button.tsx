"use client";

import { useActionState } from "react";
import { startJob, type JobActionState } from "@/app/actions/job";
import { Button } from "@/components/ui/button";

const initialState: JobActionState = {};

export function StartJobButton({ jobId }: { jobId: string }) {
  const [state, formAction, pending] = useActionState(startJob, initialState);

  return (
    <form action={formAction}>
      <input type="hidden" name="jobId" value={jobId} />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Starting…" : "Start Job"}
      </Button>
      {state.error ? (
        <p className="mt-2 text-sm text-destructive">{state.error}</p>
      ) : null}
    </form>
  );
}

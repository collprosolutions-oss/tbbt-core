"use client";

import { useActionState } from "react";
import { updatePipelineFollowUpAction, type PipelineActionState } from "@/app/actions/pipeline";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const initial: PipelineActionState = {};

export function PipelineFollowUpForm({
  opportunityKey,
  followUpOn,
}: {
  opportunityKey: string;
  followUpOn: string;
}) {
  const [state, formAction, pending] = useActionState(updatePipelineFollowUpAction, initial);

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="opportunityKey" value={opportunityKey} />
      <Input type="date" name="followUpOn" defaultValue={followUpOn} className="w-40" />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Saving…" : "Save follow-up"}
      </Button>
      {state.error ? <p className="w-full text-xs text-destructive">{state.error}</p> : null}
      {state.message ? <p className="w-full text-xs text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}

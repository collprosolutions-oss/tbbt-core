"use client";

import { useActionState } from "react";
import { updatePipelineNotesAction, type PipelineActionState } from "@/app/actions/pipeline";
import { Button } from "@/components/ui/button";

const initial: PipelineActionState = {};

export function PipelineNotesForm({
  opportunityKey,
  notes,
}: {
  opportunityKey: string;
  notes: string;
}) {
  const [state, formAction, pending] = useActionState(updatePipelineNotesAction, initial);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="opportunityKey" value={opportunityKey} />
      <textarea
        name="notes"
        defaultValue={notes}
        rows={4}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
        placeholder="Internal pipeline notes — not shown to the customer"
      />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Saving…" : "Save notes"}
      </Button>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}

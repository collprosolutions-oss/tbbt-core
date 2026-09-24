"use client";

import { useActionState, useState } from "react";
import { updatePipelineNotesAction, type PipelineActionState } from "@/app/actions/pipeline";
import { Button } from "@/components/ui/button";
import { WritingAssistBar } from "@/components/ai/writing-assist-bar";

const initial: PipelineActionState = {};

export function PipelineNotesForm({
  opportunityKey,
  notes,
}: {
  opportunityKey: string;
  notes: string;
}) {
  const [state, formAction, pending] = useActionState(updatePipelineNotesAction, initial);
  const [text, setText] = useState(notes);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="opportunityKey" value={opportunityKey} />
      <textarea
        name="notes"
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={4}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
        placeholder="Internal pipeline notes — not shown to the customer"
      />
      <WritingAssistBar
        original={text}
        context="Internal pipeline notes. Do not invent customer facts or financial results."
        onSuggestion={setText}
      />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Saving…" : "Save notes"}
      </Button>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}

"use client";

import { useActionState, useEffect } from "react";
import { applyWritingAction, type AiActionState } from "@/app/actions/ai";
import { WRITING_ACTIONS, WRITING_ACTION_LABELS } from "@/lib/ai/types";
import { Button } from "@/components/ui/button";

const initial: AiActionState = {};

export function WritingAssistBar({
  original,
  context,
  onSuggestion,
}: {
  original: string;
  context?: string;
  onSuggestion?: (text: string) => void;
}) {
  const [state, action, pending] = useActionState(applyWritingAction, initial);

  useEffect(() => {
    if (state.text && onSuggestion) onSuggestion(state.text);
  }, [state.text, onSuggestion]);

  return (
    <div className="space-y-2">
      <form action={action} className="flex flex-wrap gap-1">
        <input type="hidden" name="original" value={original} />
        {context ? <input type="hidden" name="context" value={context} /> : null}
        {WRITING_ACTIONS.map((item) => (
          <Button
            key={item}
            type="submit"
            name="writingAction"
            value={item}
            size="xs"
            variant="outline"
            disabled={pending}
          >
            {WRITING_ACTION_LABELS[item]}
          </Button>
        ))}
      </form>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
      {state.text && state.text !== original ? (
        <p className="rounded-md border bg-muted/40 p-2 text-xs whitespace-pre-wrap">{state.text}</p>
      ) : null}
    </div>
  );
}

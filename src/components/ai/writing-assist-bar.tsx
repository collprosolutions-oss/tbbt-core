"use client";

import { useActionState, useEffect, useState } from "react";
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
  const [suggestion, setSuggestion] = useState<string | null>(null);

  useEffect(() => {
    if (state.keptOriginal) {
      setSuggestion(null);
      return;
    }
    if (state.text && state.text !== original) {
      setSuggestion(state.text);
    }
  }, [state.keptOriginal, state.text, original]);

  return (
    <div className="space-y-2">
      <form action={action} className="flex flex-wrap gap-1">
        <input type="hidden" name="original" value={original} />
        {context ? <input type="hidden" name="context" value={context} /> : null}
        {WRITING_ACTIONS.filter((item) => item !== "KEEP_MINE").map((item) => (
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
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={pending || !suggestion}
          onClick={() => setSuggestion(null)}
        >
          Keep Mine
        </Button>
      </form>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
      {suggestion ? (
        <div className="space-y-2 rounded-md border bg-muted/40 p-2">
          <p className="text-xs font-medium">Suggestion — not applied yet</p>
          <p className="text-xs whitespace-pre-wrap">{suggestion}</p>
          <div className="flex flex-wrap gap-1">
            <Button
              type="button"
              size="xs"
              onClick={() => {
                onSuggestion?.(suggestion);
                setSuggestion(null);
              }}
            >
              Apply suggestion
            </Button>
            <Button type="button" size="xs" variant="outline" onClick={() => setSuggestion(null)}>
              Keep Mine
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

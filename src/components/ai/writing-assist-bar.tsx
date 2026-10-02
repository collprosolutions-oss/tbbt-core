"use client";

import { startTransition, useActionState, useEffect, useState } from "react";
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
  // Empty on the first server and client paint. This bar sits inside
  // other Settings forms, so it must not render its own <form>.
  const [attemptId, setAttemptId] = useState("");

  useEffect(() => {
    setAttemptId((current) => current || crypto.randomUUID());
  }, []);

  useEffect(() => {
    if (state.keptOriginal) {
      setSuggestion(null);
      return;
    }
    if (state.text && state.text !== original) {
      setSuggestion(state.text);
    }
    if (state.text || state.error || state.keptOriginal) {
      setAttemptId(crypto.randomUUID());
    }
  }, [state.keptOriginal, state.text, state.error, original]);

  function runWritingAction(writingAction: string) {
    if (!attemptId || pending) return;
    const formData = new FormData();
    formData.set("original", original);
    formData.set("attemptId", attemptId);
    if (context) formData.set("context", context);
    formData.set("writingAction", writingAction);
    startTransition(() => {
      action(formData);
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {WRITING_ACTIONS.filter((item) => item !== "KEEP_MINE").map((item) => (
          <Button
            key={item}
            type="button"
            size="xs"
            variant="outline"
            disabled={pending || !attemptId}
            onClick={() => runWritingAction(item)}
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
      </div>
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

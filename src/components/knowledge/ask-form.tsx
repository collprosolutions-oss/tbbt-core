"use client";

import { useActionState, useEffect, useState } from "react";
import { askKnowledgeAction, type AiActionState } from "@/app/actions/ai";
import { Button } from "@/components/ui/button";

const initial: AiActionState = {};

function newAttemptId() {
  return crypto.randomUUID();
}

export function KnowledgeAskForm() {
  const [state, action, pending] = useActionState(askKnowledgeAction, initial);
  const [attemptId, setAttemptId] = useState(newAttemptId);

  useEffect(() => {
    if (state.text || state.error || state.message) {
      setAttemptId(newAttemptId());
    }
  }, [state.text, state.error, state.message]);

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="attemptId" value={attemptId} />
      <textarea
        name="question"
        required
        className="w-full rounded-md border px-3 py-2 text-sm"
        placeholder="What does this business already know about pricing or procedures?"
      />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Searching…" : "Ask Knowledge"}
      </Button>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
      {state.text ? <p className="whitespace-pre-wrap rounded-md border p-2 text-sm">{state.text}</p> : null}
    </form>
  );
}

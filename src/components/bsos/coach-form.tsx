"use client";

import { useActionState, useEffect, useState } from "react";
import { askBsosCoachAction, type AiActionState } from "@/app/actions/ai";
import { shouldRotateAiAttemptId } from "@/lib/ai/types";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

const initial: AiActionState = {};

function newAttemptId() {
  return crypto.randomUUID();
}

export function BsosCoachForm({
  conversationId,
  aiLabel,
  jobId,
  recommendationKey,
}: {
  conversationId?: string;
  aiLabel: string;
  jobId?: string;
  recommendationKey?: string;
}) {
  const [state, action, pending] = useActionState(askBsosCoachAction, initial);
  const [attemptId, setAttemptId] = useState(newAttemptId);

  useEffect(() => {
    if (shouldRotateAiAttemptId(state)) {
      setAttemptId(newAttemptId());
    }
  }, [state.text, state.error, state.inProgress]);

  return (
    <form action={action} className="space-y-2">
      {conversationId ? <input type="hidden" name="conversationId" value={conversationId} /> : null}
      {jobId ? <input type="hidden" name="jobId" value={jobId} /> : null}
      {recommendationKey ? <input type="hidden" name="recommendationKey" value={recommendationKey} /> : null}
      <input type="hidden" name="attemptId" value={attemptId} />
      <p className="text-xs text-muted-foreground">AI status: {aiLabel}. Answers cite recorded TBBT facts only.</p>
      <textarea
        name="question"
        required
        className="w-full rounded-md border px-3 py-2 text-sm"
        placeholder="Why was this month less profitable?"
      />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Thinking…" : "Ask coach"}
      </Button>
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
      {state.text ? (
        <div className="rounded-md border p-3 text-sm">
          <p className="mb-1 text-xs uppercase text-muted-foreground">
            {state.stance === "FACT" ? "Fact" : state.stance === "RECOMMENDATION" ? "Recommendation" : "Fact + recommendation"}
          </p>
          <p className="whitespace-pre-wrap">{state.text}</p>
        </div>
      ) : null}
    </form>
  );
}

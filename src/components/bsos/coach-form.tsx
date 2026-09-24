"use client";

import { useActionState } from "react";
import { askBsosCoachAction, type AiActionState } from "@/app/actions/ai";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

const initial: AiActionState = {};

export function BsosCoachForm({
  conversationId,
  aiLabel,
}: {
  conversationId?: string;
  aiLabel: string;
}) {
  const [state, action, pending] = useActionState(askBsosCoachAction, initial);

  return (
    <form action={action} className="space-y-2">
      {conversationId ? <input type="hidden" name="conversationId" value={conversationId} /> : null}
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

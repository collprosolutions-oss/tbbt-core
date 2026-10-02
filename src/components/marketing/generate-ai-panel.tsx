"use client";

import { useActionState, useEffect, useState } from "react";
import { generateMarketingAiAction, type MarketingAiActionState } from "@/app/actions/marketing";
import { shouldRotateAiAttemptId } from "@/lib/ai/types";
import { Button } from "@/components/ui/button";
import {
  MARKETING_AI_DRAFT_REVIEW_ONLY_MESSAGE,
  MARKETING_AI_UNAVAILABLE_LABEL,
  OWNER_MARKETING_AI_DRAFT_MESSAGE,
} from "@/lib/marketing";

const initial: MarketingAiActionState = {};

function newAttemptId() {
  return crypto.randomUUID();
}

export function GenerateMarketingAiPanel({
  configured,
  viewerRole,
}: {
  configured: boolean;
  viewerRole: string;
}) {
  const [state, action, pending] = useActionState(generateMarketingAiAction, initial);
  const [attemptId, setAttemptId] = useState(newAttemptId);

  useEffect(() => {
    if (shouldRotateAiAttemptId(state)) {
      setAttemptId(newAttemptId());
    }
  }, [state.text, state.error, state.inProgress]);

  if (!configured) {
    return (
      <div className="space-y-1">
        <p className="text-sm font-medium">AI content draft</p>
        <p className="text-sm">{MARKETING_AI_UNAVAILABLE_LABEL}</p>
        <p className="text-xs text-muted-foreground">
          The AI provider is not configured. Create Content still uses recorded-fact templates.
          TBBT will not publish, post, or send a customer message.
        </p>
      </div>
    );
  }

  if (viewerRole !== "OWNER") {
    return (
      <div className="space-y-1">
        <p className="text-sm font-medium">AI content draft</p>
        <p className="text-xs text-muted-foreground">{OWNER_MARKETING_AI_DRAFT_MESSAGE}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <form action={action} className="flex flex-wrap gap-1">
        <input type="hidden" name="attemptId" value={attemptId} />
        <Button type="submit" name="marketingAiTask" value="MARKETING_DRAFT" size="xs" variant="outline" disabled={pending}>
          {pending ? "Requesting draft…" : "Request content draft"}
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">{MARKETING_AI_DRAFT_REVIEW_ONLY_MESSAGE}</p>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      {state.unavailable ? <p className="text-sm">{MARKETING_AI_UNAVAILABLE_LABEL}</p> : null}
      {state.message && !state.unavailable ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
      {state.text ? (
        <div className="rounded-md border bg-muted/40 p-2">
          <p className="text-xs font-medium">Validated model output — DRAFT</p>
          <p className="whitespace-pre-wrap text-sm">{state.text}</p>
        </div>
      ) : null}
    </div>
  );
}

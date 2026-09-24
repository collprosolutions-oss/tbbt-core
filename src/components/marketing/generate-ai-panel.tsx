"use client";

import { useActionState, useEffect, useState } from "react";
import { generateMarketingAiAction, type MarketingAiActionState } from "@/app/actions/marketing";
import { Button } from "@/components/ui/button";

const initial: MarketingAiActionState = {};

function newAttemptId() {
  return crypto.randomUUID();
}

export function GenerateMarketingAiPanel() {
  const [state, action, pending] = useActionState(generateMarketingAiAction, initial);
  const [attemptId, setAttemptId] = useState(newAttemptId);

  useEffect(() => {
    if (state.message || state.error || state.text) {
      setAttemptId(newAttemptId());
    }
  }, [state.message, state.error, state.text]);

  return (
    <div className="space-y-2">
      <form action={action} className="flex flex-wrap gap-1">
        <input type="hidden" name="attemptId" value={attemptId} />
        <Button type="submit" name="marketingAiTask" value="MARKETING_DRAFT" size="xs" variant="outline" disabled={pending}>
          Generate AI variations
        </Button>
        <Button type="submit" name="marketingAiTask" value="WEEKLY_PLAN" size="xs" variant="outline" disabled={pending}>
          Generate weekly plan
        </Button>
        <Button type="submit" name="marketingAiTask" value="CAMPAIGN_IDEAS" size="xs" variant="outline" disabled={pending}>
          Generate campaign ideas
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">
        Page load stays template-only. AI runs only after an explicit Generate action. Generated copy remains DRAFT and is never published.
      </p>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
      {state.text ? (
        <div className="rounded-md border bg-muted/40 p-2">
          <p className="text-xs font-medium">
            {state.mode === "AI" ? "Validated model output — DRAFT" : "Template draft — AI not connected"}
          </p>
          <p className="whitespace-pre-wrap text-sm">{state.text}</p>
        </div>
      ) : null}
    </div>
  );
}

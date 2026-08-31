"use client";

import { useActionState } from "react";
import { markKnowledgeReviewedAction, type KnowledgeActionState } from "@/app/actions/knowledge";
import { Button } from "@/components/ui/button";

const initial: KnowledgeActionState = {};

export function KnowledgeReviewButton({ entryId }: { entryId: string }) {
  const [state, formAction, pending] = useActionState(markKnowledgeReviewedAction, initial);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="entryId" value={entryId} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Recording…" : "Mark reviewed"}
      </Button>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}

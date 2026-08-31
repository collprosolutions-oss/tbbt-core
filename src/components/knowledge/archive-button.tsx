"use client";

import { useActionState } from "react";
import { setKnowledgeArchivedAction, type KnowledgeActionState } from "@/app/actions/knowledge";
import { Button } from "@/components/ui/button";

const initial: KnowledgeActionState = {};

export function KnowledgeArchiveButton({
  entryId,
  archived,
}: {
  entryId: string;
  archived: boolean;
}) {
  const [state, formAction, pending] = useActionState(setKnowledgeArchivedAction, initial);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="entryId" value={entryId} />
      <input type="hidden" name="archived" value={archived ? "0" : "1"} />
      <Button type="submit" size="sm" variant="ghost" disabled={pending}>
        {pending ? "Updating…" : archived ? "Reactivate" : "Archive"}
      </Button>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}

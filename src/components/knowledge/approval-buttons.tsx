"use client";

import { useActionState } from "react";
import { setKnowledgeApprovalAction, type KnowledgeActionState } from "@/app/actions/knowledge";
import { Button } from "@/components/ui/button";

const initial: KnowledgeActionState = {};

export function KnowledgeApprovalButtons({
  entryId,
  approvalState,
}: {
  entryId: string;
  approvalState: string;
}) {
  const [state, action, pending] = useActionState(setKnowledgeApprovalAction, initial);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <form action={action}>
          <input type="hidden" name="entryId" value={entryId} />
          <input type="hidden" name="approvalState" value="APPROVED" />
          <Button type="submit" size="sm" disabled={pending || approvalState === "APPROVED"}>
            Approve knowledge
          </Button>
        </form>
        <form action={action}>
          <input type="hidden" name="entryId" value={entryId} />
          <input type="hidden" name="approvalState" value="REJECTED" />
          <Button type="submit" size="sm" variant="outline" disabled={pending || approvalState === "REJECTED"}>
            Reject
          </Button>
        </form>
      </div>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
    </div>
  );
}

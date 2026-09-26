"use client";

import { useActionState, useEffect, useState } from "react";
import {
  confirmCoachActionAction,
  proposeCoachActionAction,
  type AiActionState,
} from "@/app/actions/ai";
import { shouldRotateAiAttemptId } from "@/lib/ai/types";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

const initial: AiActionState = {};

function newAttemptId() {
  return crypto.randomUUID();
}

export function ControlledActionConfirmForm({
  actionKey,
  targetEntityId,
  conversationId,
  nextStatus,
  label,
}: {
  actionKey: string;
  targetEntityId: string;
  conversationId?: string;
  nextStatus?: string;
  label: string;
}) {
  const [proposeState, proposeAction, proposing] = useActionState(proposeCoachActionAction, initial);
  const [confirmState, confirmAction, confirming] = useActionState(confirmCoachActionAction, initial);
  const [executionAttemptId, setExecutionAttemptId] = useState(newAttemptId);

  useEffect(() => {
    if (shouldRotateAiAttemptId(confirmState)) {
      setExecutionAttemptId(newAttemptId());
    }
  }, [confirmState.text, confirmState.error, confirmState.inProgress]);

  const proposalJson = proposeState.proposalJson;
  const prepared = Boolean(proposalJson) && !proposeState.error;
  const recorded = Boolean(confirmState.message) && !confirmState.error;

  return (
    <div className="space-y-2 rounded-md border border-dashed p-2">
      <p className="text-xs text-muted-foreground">
        Preparing a proposal does not record anything. Only the owner Confirm step can add an internal action-plan item.
      </p>
      <form action={proposeAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="actionKey" value={actionKey} />
        <input type="hidden" name="targetEntityId" value={targetEntityId} />
        {nextStatus ? <input type="hidden" name="nextStatus" value={nextStatus} /> : null}
        <Button type="submit" size="sm" variant="outline" disabled={proposing}>
          {proposing ? "Preparing…" : "Prepare action"}
        </Button>
      </form>
      {proposeState.error ? (
        <Alert variant="destructive">
          <AlertDescription>{proposeState.error}</AlertDescription>
        </Alert>
      ) : null}
      {prepared ? (
        <div className="space-y-1 rounded-md border bg-muted/30 p-2 text-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Proposed</p>
          <p>
            <span className="font-medium">What will happen:</span> Create an internal action-plan item for{" "}
            {proposeState.proposedTitle ?? label}.
          </p>
          {proposeState.proposedWhy ? (
            <p>
              <span className="font-medium">Why:</span> {proposeState.proposedWhy}
            </p>
          ) : null}
          <p className="text-muted-foreground">
            This will NOT contact the customer, charge money, change the schedule, or perform the work.
          </p>
        </div>
      ) : null}
      {prepared ? (
        <form action={confirmAction} className="flex flex-wrap items-center gap-2">
          {conversationId ? <input type="hidden" name="conversationId" value={conversationId} /> : null}
          <input type="hidden" name="proposalJson" value={proposalJson} />
          <input type="hidden" name="attemptId" value={executionAttemptId} />
          <input type="hidden" name="confirm" value="confirm" />
          <Button type="submit" size="sm" disabled={confirming}>
            {confirming ? "Confirming…" : "Confirm and add to action plan"}
          </Button>
        </form>
      ) : null}
      {confirmState.error ? (
        <Alert variant="destructive">
          <AlertDescription>{confirmState.error}</AlertDescription>
        </Alert>
      ) : null}
      {recorded ? (
        <p className="text-xs font-medium text-muted-foreground">Confirmed / recorded: {confirmState.message}</p>
      ) : null}
    </div>
  );
}

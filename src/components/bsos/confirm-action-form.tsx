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

  return (
    <div className="space-y-2 rounded-md border border-dashed p-2">
      <p className="text-xs text-muted-foreground">
        Coach recommendations do nothing until the owner prepares and then confirms. Opening this page is not confirmation.
      </p>
      <form action={proposeAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="actionKey" value={actionKey} />
        <input type="hidden" name="targetEntityId" value={targetEntityId} />
        {nextStatus ? <input type="hidden" name="nextStatus" value={nextStatus} /> : null}
        <Button type="submit" size="sm" variant="outline" disabled={proposing}>
          {proposing ? "Preparing…" : `Prepare: ${label}`}
        </Button>
      </form>
      {proposeState.error ? (
        <Alert variant="destructive">
          <AlertDescription>{proposeState.error}</AlertDescription>
        </Alert>
      ) : null}
      {proposeState.message ? <p className="text-xs text-muted-foreground">{proposeState.message}</p> : null}
      {proposeState.summary ? <p className="text-sm">{proposeState.summary}</p> : null}
      {prepared ? (
        <form action={confirmAction} className="flex flex-wrap items-center gap-2">
          {conversationId ? <input type="hidden" name="conversationId" value={conversationId} /> : null}
          <input type="hidden" name="proposalJson" value={proposalJson} />
          <input type="hidden" name="attemptId" value={executionAttemptId} />
          <input type="hidden" name="confirm" value="confirm" />
          <Button type="submit" size="sm" disabled={confirming}>
            {confirming ? "Confirming…" : "Owner confirm"}
          </Button>
        </form>
      ) : null}
      {confirmState.error ? (
        <Alert variant="destructive">
          <AlertDescription>{confirmState.error}</AlertDescription>
        </Alert>
      ) : null}
      {confirmState.message ? <p className="text-xs text-muted-foreground">{confirmState.message}</p> : null}
    </div>
  );
}

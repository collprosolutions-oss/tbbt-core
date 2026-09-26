"use client";

import { useActionState, useEffect, useState } from "react";
import {
  confirmCoachActionAction,
  proposeCoachActionAction,
  type AiActionState,
} from "@/app/actions/ai";
import { shouldRotateAiAttemptId } from "@/lib/ai/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

const initial: AiActionState = {};

function newAttemptId() {
  return crypto.randomUUID();
}

export function ActionCenterConfirmForm({
  actionKey,
  targetEntityId,
  displayLabel,
}: {
  actionKey: string;
  targetEntityId: string;
  displayLabel: string;
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
    <div className="space-y-2 rounded-md border border-dashed p-3">
      <p className="text-xs text-muted-foreground">
        Preparing a proposal does not record anything. Only an explicit owner
        Confirm step can run the existing Controlled AI Action.
      </p>
      <form action={proposeAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="actionKey" value={actionKey} />
        <input type="hidden" name="targetEntityId" value={targetEntityId} />
        <Button type="submit" size="sm" variant="outline" disabled={proposing}>
          {proposing ? "Preparing…" : `Prepare ${displayLabel}`}
        </Button>
      </form>
      {proposeState.error ? (
        <Alert variant="destructive">
          <AlertDescription>{proposeState.error}</AlertDescription>
        </Alert>
      ) : null}
      {prepared ? (
        <div className="space-y-1 rounded-md border bg-muted/30 p-2 text-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Proposed — owner confirmation required
          </p>
          <p>
            <span className="font-medium">Action:</span> {displayLabel}
          </p>
          {proposeState.summary ? (
            <p>
              <span className="font-medium">Recorded proposal:</span> {proposeState.summary}
            </p>
          ) : null}
          {proposeState.proposedWhy ? (
            <p>
              <span className="font-medium">Why:</span> {proposeState.proposedWhy}
            </p>
          ) : null}
        </div>
      ) : null}
      {prepared ? (
        <form action={confirmAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="proposalJson" value={proposalJson} />
          <input type="hidden" name="attemptId" value={executionAttemptId} />
          <input type="hidden" name="confirm" value="confirm" />
          <Button type="submit" size="sm" disabled={confirming}>
            {confirming ? "Confirming…" : `Confirm ${displayLabel}`}
          </Button>
        </form>
      ) : null}
      {confirmState.error ? (
        <Alert variant="destructive">
          <AlertDescription>{confirmState.error}</AlertDescription>
        </Alert>
      ) : null}
      {recorded ? (
        <p className="text-xs font-medium text-muted-foreground">
          Recorded result: {confirmState.message}
        </p>
      ) : null}
    </div>
  );
}

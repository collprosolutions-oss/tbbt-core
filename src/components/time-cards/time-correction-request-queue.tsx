"use client";

import { useActionState } from "react";
import { decideTimeCorrectionRequestAction, type TimeCardActionState } from "@/app/actions/time-cards";
import type { TimeCardCorrectionRequest } from "@/components/time-cards/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/status-badge";

const initialState: TimeCardActionState = {};

export function TimeCorrectionRequestQueue({
  requests,
  canDecide,
}: {
  requests: TimeCardCorrectionRequest[];
  canDecide: boolean;
}) {
  const pending = requests.filter((request) => request.status === "PENDING");
  if (pending.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Worker time corrections</CardTitle>
        <CardDescription>
          {canDecide
            ? "Accept or decline the proposed times. The original record stays until you decide."
            : "Waiting for the owner to accept or decline. Admins cannot decide these requests."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {pending.map((request) => (
          <div key={request.id} className="space-y-2 rounded-lg border px-3 py-3 text-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium">{request.workerName}</p>
                <p className="text-xs text-muted-foreground">
                  Recorded {request.originalClockLabel} ({request.originalHoursLabel})
                </p>
                <p className="text-xs">
                  Proposed {request.proposedClockLabel} ({request.proposedHoursLabel})
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{request.reason}</p>
              </div>
              <StatusBadge status={request.status} />
            </div>
            {canDecide ? (
              <DecideForms
                requestId={request.id}
                acceptDisabled={request.weekApproved}
                acceptDisabledReason={
                  request.weekApproved
                    ? "That week is approved. Reopen it before accepting a time correction."
                    : null
                }
              />
            ) : (
              <p className="text-xs text-muted-foreground">Owner decision required.</p>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function DecideForms({
  requestId,
  acceptDisabled = false,
  acceptDisabledReason = null,
}: {
  requestId: string;
  acceptDisabled?: boolean;
  acceptDisabledReason?: string | null;
}) {
  const [acceptState, acceptAction, acceptPending] = useActionState(
    decideTimeCorrectionRequestAction,
    initialState,
  );
  const [declineState, declineAction, declinePending] = useActionState(
    decideTimeCorrectionRequestAction,
    initialState,
  );
  const error = acceptState.error ?? declineState.error;
  const message = acceptState.message ?? declineState.message;
  const pending = acceptPending || declinePending;

  return (
    <div className="space-y-2">
      <form action={acceptAction} className="space-y-2">
        <input type="hidden" name="requestId" value={requestId} />
        <input type="hidden" name="decision" value="ACCEPTED" />
        <Button type="submit" size="sm" disabled={pending || acceptDisabled} className="w-full">
          {acceptPending ? "Accepting…" : "Accept correction"}
        </Button>
        {acceptDisabled && acceptDisabledReason ? (
          <p className="text-xs text-muted-foreground">{acceptDisabledReason}</p>
        ) : null}
      </form>
      <form action={declineAction} className="space-y-2">
        <input type="hidden" name="requestId" value={requestId} />
        <input type="hidden" name="decision" value="DECLINED" />
        <Input name="reason" placeholder="Decline reason (optional)" />
        <Button type="submit" size="sm" variant="outline" disabled={pending} className="w-full">
          {declinePending ? "Declining…" : "Decline correction"}
        </Button>
      </form>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {message ? <p className="text-xs text-emerald-400">{message}</p> : null}
    </div>
  );
}

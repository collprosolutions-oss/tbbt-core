"use client";

import { useActionState } from "react";
import { requestTimeCorrectionAction, type TimeCardActionState } from "@/app/actions/time-cards";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { TIME_CORRECTION_STATUS_LABELS, type TimeCorrectionRequestStatus } from "@/lib/time-cards";

const initialState: TimeCardActionState = {};

export type FieldTimeCorrectionEntry = {
  id: string;
  activityLabel: string;
  jobLabel: string | null;
  clockLabel: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  canRequest: boolean;
  blockedReason: string | null;
  requestStatus: TimeCorrectionRequestStatus | null;
  requestReason: string | null;
  proposedClockLabel: string | null;
};

export function FieldTimeCorrectionRequests({
  entries,
}: {
  entries: FieldTimeCorrectionEntry[];
}) {
  if (entries.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Request a time correction</CardTitle>
        <CardDescription>
          Propose new start and end times for your own recorded time. The original
          clock stays until an owner accepts or declines.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {entries.map((entry) => (
          <div key={entry.id} className="rounded-lg border px-3 py-3 text-sm">
            <p className="font-medium">
              {entry.activityLabel}
              {entry.jobLabel ? ` · ${entry.jobLabel}` : ""}
            </p>
            <p className="text-muted-foreground">Recorded {entry.clockLabel}</p>
            {entry.requestStatus ? (
              <p className="mt-2 text-xs">
                {TIME_CORRECTION_STATUS_LABELS[entry.requestStatus]}
                {entry.proposedClockLabel ? ` · proposed ${entry.proposedClockLabel}` : ""}
                {entry.requestReason ? ` — ${entry.requestReason}` : ""}
              </p>
            ) : null}
            {entry.canRequest ? <RequestForm entry={entry} /> : null}
            {!entry.canRequest && entry.blockedReason ? (
              <p className="mt-2 text-xs text-muted-foreground">{entry.blockedReason}</p>
            ) : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function RequestForm({ entry }: { entry: FieldTimeCorrectionEntry }) {
  const [state, action, pending] = useActionState(requestTimeCorrectionAction, initialState);
  return (
    <form action={action} className="mt-3 space-y-2">
      <input type="hidden" name="timeEntryId" value={entry.id} />
      <div className="grid grid-cols-2 gap-2">
        <Input type="date" name="proposedStartDate" defaultValue={entry.startDate} required />
        <Input type="time" name="proposedStartTime" defaultValue={entry.startTime} step={60} required />
        <Input type="date" name="proposedEndDate" defaultValue={entry.endDate} required />
        <Input type="time" name="proposedEndTime" defaultValue={entry.endTime} step={60} required />
      </div>
      <Input name="reason" placeholder="Reason for the correction" required />
      <Button type="submit" size="sm" disabled={pending} className="w-full">
        {pending ? "Sending request…" : "Request correction"}
      </Button>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-xs text-emerald-400">{state.message}</p> : null}
    </form>
  );
}

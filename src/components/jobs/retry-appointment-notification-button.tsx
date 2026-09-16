"use client";

import { useActionState, useEffect, useState } from "react";
import {
  retryAppointmentNotification,
  type JobActionState,
} from "@/app/actions/job";
import { Button } from "@/components/ui/button";

const initialState: JobActionState = {};

function newSendAttemptId() {
  return crypto.randomUUID();
}

export function RetryAppointmentNotificationButton({ jobId }: { jobId: string }) {
  const [state, formAction, pending] = useActionState(
    retryAppointmentNotification,
    initialState,
  );
  const [sendAttemptId, setSendAttemptId] = useState(newSendAttemptId);

  useEffect(() => {
    if (state.message) {
      setSendAttemptId(newSendAttemptId());
    }
  }, [state.message]);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="sendAttemptId" value={sendAttemptId} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Sending…" : "Retry notification"}
      </Button>
      {state.message ? (
        <p className="text-sm text-foreground">{state.message}</p>
      ) : null}
      {state.notificationWarning || state.error ? (
        <p className="text-sm text-destructive">
          {state.notificationWarning || state.error}
        </p>
      ) : null}
    </form>
  );
}

"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  changeOwnerDayRouteAppointmentAction,
  type OwnerDayRouteAppointmentActionState,
} from "@/app/actions/owner-day-route";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DAY_ROUTE_APPOINTMENT_FORM_NOTE,
  DAY_ROUTE_APPOINTMENT_SUBMIT_LABEL,
} from "@/lib/owner-day-route-appointment";
import { serializeOwnerDayRouteScheduleSnapshot } from "@/lib/owner-day-route/snapshot";
import type { OwnerDayRouteScheduleSnapshot } from "@/lib/owner-day-route/types";

const initialState: OwnerDayRouteAppointmentActionState = {};

export function OwnerDayRouteAppointmentForm({
  jobId,
  timeZone,
  date,
  time,
  snapshot,
}: {
  jobId: string;
  timeZone: string;
  date: string;
  time: string;
  snapshot: OwnerDayRouteScheduleSnapshot;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(
    changeOwnerDayRouteAppointmentAction,
    initialState,
  );

  useEffect(() => {
    if (state.ok) {
      router.refresh();
    }
  }, [state.ok, state.message, router]);

  const dateId = `day-route-date-${jobId}`;
  const timeId = `day-route-time-${jobId}`;

  return (
    <form action={formAction} className="mt-3 space-y-3">
      <input type="hidden" name="jobId" value={jobId} />
      <input
        type="hidden"
        name="scheduleSnapshot"
        value={serializeOwnerDayRouteScheduleSnapshot(snapshot)}
      />
      <p className="text-xs text-muted-foreground">{DAY_ROUTE_APPOINTMENT_FORM_NOTE}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={dateId}>New date</Label>
          <Input id={dateId} name="date" type="date" defaultValue={date} required />
        </div>
        <div className="space-y-1">
          <Label htmlFor={timeId}>New start ({timeZone})</Label>
          <Input id={timeId} name="time" type="time" defaultValue={time} required />
        </div>
      </div>
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.message ? (
        <p className="text-sm text-muted-foreground">{state.message}</p>
      ) : null}
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : DAY_ROUTE_APPOINTMENT_SUBMIT_LABEL}
      </Button>
    </form>
  );
}

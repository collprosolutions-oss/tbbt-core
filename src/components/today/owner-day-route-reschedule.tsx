"use client";

import { useActionState } from "react";
import {
  changeOwnerDayRouteAppointmentAction,
  type OwnerDayRouteChangeState,
} from "@/app/actions/owner-day-route";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { durationPresetForMinutes } from "@/lib/job-schedule";
import {
  OWNER_DAY_ROUTE_CHANGE_NO_CUSTOMER_MESSAGE,
  OWNER_DAY_ROUTE_CHANGE_OWNER_ONLY_MESSAGE,
  type OwnerDayRouteStop,
} from "@/lib/owner-day-route";

const initial: OwnerDayRouteChangeState = {};

export function OwnerDayRouteRescheduleForm({
  stop,
  dateIso,
  viewerRole,
}: {
  stop: OwnerDayRouteStop;
  dateIso: string;
  viewerRole: string;
}) {
  const [state, action, pending] = useActionState(changeOwnerDayRouteAppointmentAction, initial);
  const canChange = viewerRole === "OWNER";
  const durationPreset = durationPresetForMinutes(stop.scheduledDurationMinutes) || "60";
  const customHours =
    durationPreset === "custom" && stop.scheduledDurationMinutes
      ? String(stop.scheduledDurationMinutes / 60)
      : "";

  if (!canChange) {
    return (
      <p className="mt-3 text-xs text-muted-foreground">{OWNER_DAY_ROUTE_CHANGE_OWNER_ONLY_MESSAGE}</p>
    );
  }

  return (
    <form action={action} className="mt-3 space-y-2 rounded-lg border border-border/70 p-3">
      <input type="hidden" name="jobId" value={stop.jobId} />
      <input type="hidden" name="dateIso" value={dateIso} />
      <input type="hidden" name="expectedScheduledAt" value={stop.scheduledAtIso} />
      <input type="hidden" name="durationPreset" value={durationPreset} />
      {customHours ? <input type="hidden" name="customHours" value={customHours} /> : null}
      {state.conflictAck ? <input type="hidden" name="confirmOverlapAck" value={state.conflictAck} /> : null}
      <p className="text-sm font-medium">Change appointment window</p>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor={`day-route-date-${stop.jobId}`}>Date</Label>
          <Input id={`day-route-date-${stop.jobId}`} name="date" type="date" defaultValue={dateIso} required />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`day-route-time-${stop.jobId}`}>Start</Label>
          <Input
            id={`day-route-time-${stop.jobId}`}
            name="time"
            type="time"
            defaultValue={stop.startTimeValue}
            required
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`day-route-pickup-${stop.jobId}`}>Material pickup minutes</Label>
        <Input
          id={`day-route-pickup-${stop.jobId}`}
          name="pickupDurationMinutes"
          type="number"
          min={0}
          max={1440}
          defaultValue={stop.pickupDurationMinutes ?? 0}
        />
      </div>
      <p className="text-xs text-muted-foreground">{OWNER_DAY_ROUTE_CHANGE_NO_CUSTOMER_MESSAGE}</p>
      {state.warning ? <p className="text-xs text-amber-800 dark:text-amber-300">{state.warning}</p> : null}
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Saving…" : state.warning ? "Save anyway" : "Save new window"}
      </Button>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}

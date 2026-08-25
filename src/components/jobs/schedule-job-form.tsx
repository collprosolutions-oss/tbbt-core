"use client";

import { useActionState, useState } from "react";
import {
  scheduleJob,
  type JobActionState,
} from "@/app/actions/job";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DURATION_PRESETS } from "@/lib/job-schedule";

const initialState: JobActionState = {};

export function ScheduleJobForm({
  jobId,
  date,
  time,
  durationPreset,
  customHours,
  isScheduled,
}: {
  jobId: string;
  date: string;
  time: string;
  durationPreset: string;
  customHours: string;
  isScheduled: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    scheduleJob,
    initialState,
  );
  const [preset, setPreset] = useState(durationPreset);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="jobId" value={jobId} />
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.warning ? (
        <Alert>
          <AlertTitle>Schedule overlap</AlertTitle>
          <AlertDescription>{state.warning}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="date">Date</Label>
          <Input id="date" name="date" type="date" defaultValue={date} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="time">Start time</Label>
          <Input id="time" name="time" type="time" defaultValue={time} required />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="durationPreset">Expected duration</Label>
        <select
          id="durationPreset"
          name="durationPreset"
          value={preset}
          onChange={(event) => setPreset(event.target.value)}
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
        >
          <option value="">No duration</option>
          {DURATION_PRESETS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
          <option value="custom">Custom</option>
        </select>
      </div>
      {preset === "custom" ? (
        <div className="space-y-2">
          <Label htmlFor="customHours">Custom hours</Label>
          <Input
            id="customHours"
            name="customHours"
            inputMode="decimal"
            defaultValue={customHours}
            placeholder="1.25"
          />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending
            ? "Saving…"
            : isScheduled
              ? "Reschedule"
              : "Schedule Job"}
        </Button>
        {state.warning ? (
          <Button
            type="submit"
            name="confirmOverlap"
            value="1"
            variant="outline"
            disabled={pending}
          >
            Schedule anyway
          </Button>
        ) : null}
      </div>
    </form>
  );
}

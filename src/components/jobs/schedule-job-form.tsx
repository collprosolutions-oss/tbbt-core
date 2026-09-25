"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import {
  scheduleJob,
  type JobActionState,
} from "@/app/actions/job";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  findNextAvailableStart,
  formatNextAvailableDateTime,
  occupiedJobsFromSnapshot,
  type AvailabilitySnapshot,
} from "@/lib/availability";
import { DURATION_PRESETS, parseDurationMinutes } from "@/lib/job-schedule";
import { formatISODate } from "@/lib/schedule";
import { WORKFORCE_SKILLS } from "@/lib/workforce";

const initialState: JobActionState = {};

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function toTimeInput(value: Date) {
  return `${pad2(value.getHours())}:${pad2(value.getMinutes())}`;
}

export function ScheduleJobForm({
  jobId,
  date,
  time,
  durationPreset,
  customHours,
  isScheduled,
  unpaidDepositWarning,
  availability,
  pickupDurationMinutes = 0,
  requiredSkills = [],
  appointmentNote,
}: {
  jobId: string;
  date: string;
  time: string;
  durationPreset: string;
  customHours: string;
  isScheduled: boolean;
  unpaidDepositWarning?: string | null;
  availability?: AvailabilitySnapshot | null;
  pickupDurationMinutes?: number;
  requiredSkills?: string[];
  appointmentNote?: string | null;
}) {
  const [state, formAction, pending] = useActionState(
    scheduleJob,
    initialState,
  );
  const [preset, setPreset] = useState(durationPreset);
  const [custom, setCustom] = useState(customHours);
  const [dateValue, setDateValue] = useState(date);
  const [timeValue, setTimeValue] = useState(time);
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
  }, []);

  const parsedDuration = parseDurationMinutes(preset, custom);
  const durationMinutes = parsedDuration.ok ? parsedDuration.minutes : null;

  const nextAvailable = useMemo(() => {
    if (!availability || !now) return null;
    return findNextAvailableStart({
      from: now,
      durationMinutes: durationMinutes ?? 60,
      settings: availability.settings,
      existing: occupiedJobsFromSnapshot(availability, jobId),
    });
  }, [availability, durationMinutes, jobId, now]);

  return (
    <form
      action={formAction}
      className="space-y-4"
      onSubmit={
        unpaidDepositWarning
          ? (event) => {
              if (
                !window.confirm(
                  `${unpaidDepositWarning}\n\nSchedule the job anyway?`,
                )
              ) {
                event.preventDefault();
              }
            }
          : undefined
      }
    >
      <input type="hidden" name="jobId" value={jobId} />
      {unpaidDepositWarning ? (
        <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
          {unpaidDepositWarning}
        </p>
      ) : null}
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.warning ? (
        <Alert>
          <AlertTitle>Schedule conflict</AlertTitle>
          <AlertDescription>{state.warning}</AlertDescription>
        </Alert>
      ) : null}
      {state.notificationWarning ? (
        <Alert>
          <AlertTitle>Customer was not notified</AlertTitle>
          <AlertDescription>{state.notificationWarning}</AlertDescription>
        </Alert>
      ) : null}
      {availability ? (
        <div className="space-y-1 rounded-lg border border-dashed p-3 text-sm">
          <p className="font-medium">Next available</p>
          {nextAvailable ? (
            <p>
              {formatNextAvailableDateTime(nextAvailable)}
            </p>
          ) : now ? (
            <p className="text-muted-foreground">
              No open slot in the next 60 days for this duration.
            </p>
          ) : (
            <p className="text-muted-foreground">Checking availability…</p>
          )}
          {nextAvailable ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setDateValue(formatISODate(nextAvailable));
                setTimeValue(toTimeInput(nextAvailable));
              }}
            >
              Use this time
            </Button>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Uses working hours, blocked dates, existing jobs, duration, and the{" "}
            {availability.settings.schedulingBufferMinutes}-minute travel/pickup
            buffer. Buffer is scheduling time only — not a charge.
          </p>
        </div>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`date-${jobId}`}>Date</Label>
          <Input
            id={`date-${jobId}`}
            name="date"
            type="date"
            value={dateValue}
            onChange={(event) => setDateValue(event.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`time-${jobId}`}>Start time</Label>
          <Input
            id={`time-${jobId}`}
            name="time"
            type="time"
            value={timeValue}
            onChange={(event) => setTimeValue(event.target.value)}
            required
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`durationPreset-${jobId}`}>Expected duration</Label>
        <select
          id={`durationPreset-${jobId}`}
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
          <Label htmlFor={`customHours-${jobId}`}>Custom hours</Label>
          <Input
            id={`customHours-${jobId}`}
            name="customHours"
            inputMode="decimal"
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            placeholder="16"
          />
          <p className="text-xs text-muted-foreground">
            Enter total hours, including multi-day jobs.
          </p>
        </div>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor={`pickup-${jobId}`}>Material pickup minutes</Label>
        <Input
          id={`pickup-${jobId}`}
          name="pickupDurationMinutes"
          inputMode="numeric"
          defaultValue={String(pickupDurationMinutes || 0)}
        />
        <p className="text-xs text-muted-foreground">
          Consumes schedule time before the job. Separate from the travel/pickup buffer. Not a charge.
        </p>
      </div>
      {appointmentNote ? <p className="text-xs text-muted-foreground">{appointmentNote}</p> : null}
      <div className="space-y-2">
        <p className="text-sm font-medium">Required skills</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {WORKFORCE_SKILLS.map((skill) => (
            <label key={skill.key} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="requiredSkill"
                value={skill.key}
                defaultChecked={requiredSkills.includes(skill.key)}
                className="size-4"
              />
              {skill.label}
            </label>
          ))}
        </div>
      </div>
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

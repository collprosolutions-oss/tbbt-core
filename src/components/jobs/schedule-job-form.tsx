"use client";

import Link from "next/link";
import { useActionState, useEffect, useMemo, useRef, useState } from "react";
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
import { formatISODateInTimeZone, formatZonedTimeInput } from "@/lib/business-timezone";
import { DURATION_PRESETS, parseDurationMinutes } from "@/lib/job-schedule";
import { RequestPreferredWindowsList } from "@/components/requests/request-preferred-windows";
import type { OwnerPreferredWindowsView } from "@/lib/request-preferred-windows";
import { WORKFORCE_PROGRESSIONS, WORKFORCE_SKILLS, formatProgression } from "@/lib/workforce";

const initialState: JobActionState = {};

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
  requiredProgression = "",
  appointmentNote,
  preferredWindows,
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
  requiredProgression?: string;
  appointmentNote?: string | null;
  preferredWindows?: OwnerPreferredWindowsView | null;
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
  const statusRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setNow(new Date());
  }, []);

  useEffect(() => {
    if (state.error || state.warning) statusRef.current?.focus();
  }, [state.error, state.warning]);

  const parsedDuration = parseDurationMinutes(preset, custom);
  const durationMinutes = parsedDuration.ok ? parsedDuration.minutes : null;

  const nextAvailable = useMemo(() => {
    if (!availability || !now) return null;
    return findNextAvailableStart({
      from: now,
      durationMinutes: durationMinutes ?? 60,
      settings: availability.settings,
      existing: occupiedJobsFromSnapshot(availability, jobId),
      timeZone: availability.timeZone,
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
        <p
          id={`deposit-warning-${jobId}`}
          className="text-sm font-medium text-amber-800 dark:text-amber-300"
        >
          {unpaidDepositWarning}
        </p>
      ) : null}
      {state.error ? (
        <Alert ref={statusRef} tabIndex={-1} variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.warning ? (
        <Alert ref={state.error ? undefined : statusRef} tabIndex={-1}>
          <AlertTitle>Schedule conflict</AlertTitle>
          <AlertDescription>
            <p>{state.warning}</p>
            {state.conflicts && state.conflicts.length > 0 ? (
              <ul className="mt-3 space-y-3">
                {state.conflicts.map((conflict) => (
                  <li key={conflict.jobId} className="space-y-1">
                    <p className="font-medium text-foreground">
                      {conflict.customerName}
                    </p>
                    <p>Scheduled {conflict.scheduledStartLabel}</p>
                    {conflict.expectedEndLabel ? (
                      <p>Expected end {conflict.expectedEndLabel}</p>
                    ) : null}
                    {conflict.assignedWorkerName ? (
                      <p>{conflict.assignedWorkerName}</p>
                    ) : null}
                    {conflict.addressSummary ? (
                      <p>{conflict.addressSummary}</p>
                    ) : null}
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/jobs/${conflict.jobId}`}>
                        Open conflicting job
                      </Link>
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {state.notificationWarning ? (
        <Alert>
          <AlertTitle>Customer was not notified</AlertTitle>
          <AlertDescription>{state.notificationWarning}</AlertDescription>
        </Alert>
      ) : null}
      {preferredWindows ? (
        <RequestPreferredWindowsList
          preferredWindows={preferredWindows}
          onUse={(window) => {
            setDateValue(window.localDate);
            if (window.startLocal) setTimeValue(window.startLocal);
          }}
        />
      ) : null}
      {availability ? (
        <div className="space-y-1 rounded-lg border border-dashed p-3 text-sm">
          <p className="font-medium">Next available</p>
          {nextAvailable ? (
            <p>
              {formatNextAvailableDateTime(nextAvailable, availability.timeZone)}
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
                setDateValue(formatISODateInTimeZone(nextAvailable, availability.timeZone));
                setTimeValue(formatZonedTimeInput(nextAvailable, availability.timeZone));
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
        <Label htmlFor={`progression-${jobId}`}>Required progression</Label>
        <select
          id={`progression-${jobId}`}
          name="requiredProgression"
          defaultValue={requiredProgression}
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
        >
          <option value="">No progression floor</option>
          {WORKFORCE_PROGRESSIONS.map((value) => (
            <option key={value} value={value}>
              {formatProgression(value)}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          Recommendations honor this floor. The owner can still assign any active MEMBER.
        </p>
      </div>
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
        <Button
          type="submit"
          disabled={pending}
          aria-busy={pending || undefined}
          aria-describedby={unpaidDepositWarning ? `deposit-warning-${jobId}` : undefined}
        >
          {pending
            ? "Saving…"
            : isScheduled
              ? "Reschedule"
              : "Schedule Job"}
        </Button>
        {state.warning && state.conflictAck ? (
          <>
            <input type="hidden" name="confirmOverlapAck" value={state.conflictAck} />
            <Button type="submit" variant="outline" disabled={pending}>
              Schedule anyway
            </Button>
          </>
        ) : null}
      </div>
    </form>
  );
}

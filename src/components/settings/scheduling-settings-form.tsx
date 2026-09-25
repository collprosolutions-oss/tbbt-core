"use client";

import { useActionState, useState } from "react";
import {
  updateSchedulingSettings,
  type SettingsActionState,
} from "@/app/actions/settings";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  WEEKDAY_OPTIONS,
  minutesToTimeInput,
  type AvailabilitySettings,
} from "@/lib/availability";
import { SCHEDULING_FUTURE_RULE_MESSAGE } from "@/lib/settings";
import { DEFAULT_SCHEDULING_POLICY } from "@/lib/workforce";

const initialState: SettingsActionState = {};

export function SchedulingSettingsForm({
  settings,
  canEdit,
}: {
  settings: AvailabilitySettings & {
    firstAppointmentMode?: string;
    laterAppointmentMode?: string;
    defaultArrivalWindowMinutes?: number;
    dayBeforeChangeCutoffHours?: number;
    defaultPickupMinutes?: number;
    travelPlaceholderMinutes?: number;
    helperRecommendationThresholdMinutes?: number;
    overloadThresholdPercent?: number;
  };
  canEdit: boolean;
}) {
  const [state, action, pending] = useActionState(updateSchedulingSettings, initialState);
  const [unavailableDates, setUnavailableDates] = useState(settings.unavailableDates);
  const [newDate, setNewDate] = useState("");

  function addDate() {
    if (!newDate || unavailableDates.includes(newDate)) {
      setNewDate("");
      return;
    }
    setUnavailableDates([...unavailableDates, newDate].sort());
    setNewDate("");
  }

  return (
    <form action={action} className="space-y-4">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.message ? (
        <Alert>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : null}

      <fieldset disabled={!canEdit} className="space-y-4">
        <div className="space-y-2">
          <p className="text-sm font-medium">Working days</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {WEEKDAY_OPTIONS.map((day) => (
              <label key={day.value} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="workingWeekday"
                  value={day.value}
                  defaultChecked={settings.workingWeekdays.includes(day.value)}
                  className="size-4"
                />
                {day.label}
              </label>
            ))}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="workStart">Opens</Label>
            <Input
              id="workStart"
              name="workStart"
              type="time"
              defaultValue={minutesToTimeInput(settings.workStartMinutes)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="workEnd">Closes</Label>
            <Input
              id="workEnd"
              name="workEnd"
              type="time"
              defaultValue={minutesToTimeInput(settings.workEndMinutes)}
              required
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="schedulingBufferMinutes">Travel / material pickup buffer (minutes)</Label>
          <Input
            id="schedulingBufferMinutes"
            name="schedulingBufferMinutes"
            inputMode="numeric"
            defaultValue={String(settings.schedulingBufferMinutes)}
            required
          />
          <p className="text-xs text-muted-foreground">
            Scheduling time only. This is not an extra charge — material pickup already in the estimate stays there.
            Default is 30 minutes.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="firstAppointmentMode">First appointment</Label>
            <select
              id="firstAppointmentMode"
              name="firstAppointmentMode"
              defaultValue={settings.firstAppointmentMode ?? DEFAULT_SCHEDULING_POLICY.firstAppointmentMode}
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
            >
              <option value="EXACT">Exact time</option>
              <option value="WINDOW">Arrival window</option>
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="laterAppointmentMode">Later work</Label>
            <select
              id="laterAppointmentMode"
              name="laterAppointmentMode"
              defaultValue={settings.laterAppointmentMode ?? DEFAULT_SCHEDULING_POLICY.laterAppointmentMode}
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
            >
              <option value="EXACT">Exact time</option>
              <option value="WINDOW">Arrival window</option>
            </select>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="defaultArrivalWindowMinutes">Arrival window (minutes)</Label>
            <Input
              id="defaultArrivalWindowMinutes"
              name="defaultArrivalWindowMinutes"
              inputMode="numeric"
              defaultValue={String(
                settings.defaultArrivalWindowMinutes ?? DEFAULT_SCHEDULING_POLICY.defaultArrivalWindowMinutes,
              )}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="dayBeforeChangeCutoffHours">Day-before change cutoff (hours)</Label>
            <Input
              id="dayBeforeChangeCutoffHours"
              name="dayBeforeChangeCutoffHours"
              inputMode="numeric"
              defaultValue={String(
                settings.dayBeforeChangeCutoffHours ?? DEFAULT_SCHEDULING_POLICY.dayBeforeChangeCutoffHours,
              )}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="defaultPickupMinutes">Default material pickup (minutes)</Label>
            <Input
              id="defaultPickupMinutes"
              name="defaultPickupMinutes"
              inputMode="numeric"
              defaultValue={String(settings.defaultPickupMinutes ?? DEFAULT_SCHEDULING_POLICY.defaultPickupMinutes)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="travelPlaceholderMinutes">Travel placeholder (minutes)</Label>
            <Input
              id="travelPlaceholderMinutes"
              name="travelPlaceholderMinutes"
              inputMode="numeric"
              defaultValue={String(
                settings.travelPlaceholderMinutes ?? DEFAULT_SCHEDULING_POLICY.travelPlaceholderMinutes,
              )}
            />
            <p className="text-xs text-muted-foreground">
              Estimated only. Not GPS routing.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="helperRecommendationThresholdMinutes">Helper recommendation threshold (minutes)</Label>
            <Input
              id="helperRecommendationThresholdMinutes"
              name="helperRecommendationThresholdMinutes"
              inputMode="numeric"
              defaultValue={String(
                settings.helperRecommendationThresholdMinutes ??
                  DEFAULT_SCHEDULING_POLICY.helperRecommendationThresholdMinutes,
              )}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="overloadThresholdPercent">Overloaded-day threshold (%)</Label>
            <Input
              id="overloadThresholdPercent"
              name="overloadThresholdPercent"
              inputMode="numeric"
              defaultValue={String(
                settings.overloadThresholdPercent ?? DEFAULT_SCHEDULING_POLICY.overloadThresholdPercent,
              )}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="new-unavailable-date">Days unavailable</Label>
          <div className="flex flex-wrap items-end gap-2">
            <Input
              id="new-unavailable-date"
              type="date"
              value={newDate}
              onChange={(event) => setNewDate(event.target.value)}
            />
            <Button type="button" variant="outline" onClick={addDate} disabled={!canEdit}>
              Add date
            </Button>
          </div>
          {unavailableDates.length === 0 ? (
            <p className="text-sm text-muted-foreground">No blocked dates.</p>
          ) : (
            <ul className="space-y-2">
              {unavailableDates.map((date) => (
                <li key={date} className="flex items-center justify-between gap-2 rounded-lg border p-2 text-sm">
                  <span className="tabular-nums">{date}</span>
                  <input type="hidden" name="unavailableDate" value={date} />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setUnavailableDates(unavailableDates.filter((item) => item !== date))}
                    disabled={!canEdit}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </fieldset>

      <p className="text-sm text-muted-foreground">{SCHEDULING_FUTURE_RULE_MESSAGE}</p>
      {canEdit ? (
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save scheduling"}
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">Only the owner or admin can change scheduling availability.</p>
      )}
    </form>
  );
}

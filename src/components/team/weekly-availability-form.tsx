"use client";

import { useActionState } from "react";
import { saveMemberAvailabilityException, saveMemberWeeklyAvailability, type WorkforceActionState } from "@/app/actions/workforce";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { WorkforceMember } from "@/lib/workforce";

const initialState: WorkforceActionState = {};

const WEEKDAYS = [
  { weekday: 0, label: "Sunday" },
  { weekday: 1, label: "Monday" },
  { weekday: 2, label: "Tuesday" },
  { weekday: 3, label: "Wednesday" },
  { weekday: 4, label: "Thursday" },
  { weekday: 5, label: "Friday" },
  { weekday: 6, label: "Saturday" },
];

function minutesToTime(value: number) {
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function WeeklyAvailabilityForm({ member }: { member: WorkforceMember }) {
  const [weekState, weekAction, weekPending] = useActionState(saveMemberWeeklyAvailability, initialState);
  const [exceptionState, exceptionAction, exceptionPending] = useActionState(
    saveMemberAvailabilityException,
    initialState,
  );
  const inherits = member.weeklyAvailability.length === 0;

  return (
    <div className="space-y-3">
      <form action={weekAction} className="space-y-3 rounded-lg border p-3">
        <input type="hidden" name="membershipId" value={member.membershipId} />
        {weekState.error ? (
          <Alert variant="destructive">
            <AlertDescription>{weekState.error}</AlertDescription>
          </Alert>
        ) : null}
        {weekState.message ? (
          <Alert>
            <AlertDescription>{weekState.message}</AlertDescription>
          </Alert>
        ) : null}
        <p className="text-sm font-medium">Weekly hours</p>
        <p className="text-xs text-muted-foreground">
          Empty means this member inherits business hours. A date exception
          overrides weekly hours for that day only. Inactive or
          scheduling-inactive members stay unavailable even if hours are saved.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="inheritBusinessHours" value="1" defaultChecked={inherits} className="size-4" />
          Inherit business hours
        </label>
        <div className="space-y-2">
          {WEEKDAYS.map((day) => {
            const slot = member.weeklyAvailability.find((row) => row.weekday === day.weekday);
            return (
              <div key={day.weekday} className="grid items-center gap-2 sm:grid-cols-[7rem_auto_1fr_1fr]">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name={`weekday-${day.weekday}`}
                    value="1"
                    defaultChecked={Boolean(slot)}
                    className="size-4"
                  />
                  {day.label}
                </label>
                <span className="hidden text-xs text-muted-foreground sm:inline"> </span>
                <Input
                  name={`start-${day.weekday}`}
                  type="time"
                  defaultValue={slot ? minutesToTime(slot.startMinutes) : "08:00"}
                />
                <Input
                  name={`end-${day.weekday}`}
                  type="time"
                  defaultValue={slot ? minutesToTime(slot.endMinutes) : "17:00"}
                />
              </div>
            );
          })}
        </div>
        <Button type="submit" size="sm" disabled={weekPending}>
          {weekPending ? "Saving…" : "Save weekly hours"}
        </Button>
      </form>
      <form action={exceptionAction} className="space-y-2 rounded-lg border p-3">
        <input type="hidden" name="membershipId" value={member.membershipId} />
        {exceptionState.error ? (
          <Alert variant="destructive">
            <AlertDescription>{exceptionState.error}</AlertDescription>
          </Alert>
        ) : null}
        {exceptionState.message ? (
          <Alert>
            <AlertDescription>{exceptionState.message}</AlertDescription>
          </Alert>
        ) : null}
        <p className="text-sm font-medium">Date exception</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`exception-date-${member.membershipId}`}>Date</Label>
            <Input id={`exception-date-${member.membershipId}`} name="date" type="date" required />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`exception-kind-${member.membershipId}`}>Kind</Label>
            <select
              id={`exception-kind-${member.membershipId}`}
              name="kind"
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
              defaultValue="UNAVAILABLE"
            >
              <option value="UNAVAILABLE">Unavailable</option>
              <option value="AVAILABLE">Available (overrides weekly)</option>
            </select>
          </div>
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={exceptionPending}>
          {exceptionPending ? "Saving…" : "Save date exception"}
        </Button>
      </form>
    </div>
  );
}

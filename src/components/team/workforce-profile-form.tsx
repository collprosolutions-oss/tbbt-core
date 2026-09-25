"use client";

import { useActionState } from "react";
import { updateWorkforceProfile, type WorkforceActionState } from "@/app/actions/workforce";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  WORKFORCE_PROGRESSIONS,
  WORKFORCE_SKILLS,
  formatProgression,
  type WorkforceMember,
} from "@/lib/workforce";

const initialState: WorkforceActionState = {};

export function WorkforceProfileForm({ member }: { member: WorkforceMember }) {
  const [state, action, pending] = useActionState(updateWorkforceProfile, initialState);
  const selected = new Set(member.skills.map((skill) => skill.skillKey));

  return (
    <form action={action} className="space-y-3 rounded-lg border p-3">
      <input type="hidden" name="membershipId" value={member.membershipId} />
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
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`progression-${member.membershipId}`}>Progression</Label>
          <select
            id={`progression-${member.membershipId}`}
            name="progression"
            defaultValue={member.progression}
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
          >
            {WORKFORCE_PROGRESSIONS.map((value) => (
              <option key={value} value={value}>
                {formatProgression(value)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`schedulingActive-${member.membershipId}`}>Scheduling status</Label>
          <select
            id={`schedulingActive-${member.membershipId}`}
            name="schedulingActive"
            defaultValue={member.schedulingActive ? "1" : "0"}
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
          >
            <option value="1">Active for scheduling</option>
            <option value="0">Inactive for scheduling</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`maxDaily-${member.membershipId}`}>Max daily job minutes</Label>
          <Input
            id={`maxDaily-${member.membershipId}`}
            name="maxDailyJobMinutes"
            inputMode="numeric"
            defaultValue={member.maxDailyJobMinutes ?? ""}
            placeholder="Optional"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`notes-${member.membershipId}`}>Notes</Label>
          <Input
            id={`notes-${member.membershipId}`}
            name="workforceNotes"
            defaultValue=""
            placeholder="Owner notes only"
          />
        </div>
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium">Skills</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {WORKFORCE_SKILLS.map((skill) => (
            <label key={skill.key} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="skillKey"
                value={skill.key}
                defaultChecked={selected.has(skill.key)}
                className="size-4"
              />
              <span>{skill.label}</span>
              <select
                name={`proficiency-${skill.key}`}
                defaultValue={member.skills.find((row) => row.skillKey === skill.key)?.proficiency ?? "CAPABLE"}
                className="h-7 rounded border border-input bg-transparent px-1 text-xs"
              >
                {WORKFORCE_PROGRESSIONS.map((value) => (
                  <option key={value} value={value}>
                    {formatProgression(value)}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Save workforce profile"}
      </Button>
    </form>
  );
}

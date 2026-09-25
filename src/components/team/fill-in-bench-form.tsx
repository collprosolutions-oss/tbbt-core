"use client";

import { useActionState } from "react";
import {
  createWorkforceOutreachTask,
  markFillInBenchUsed,
  saveFillInBenchWorker,
  type WorkforceActionState,
} from "@/app/actions/workforce";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BENCH_CONTACT_PREFERENCES, WORKFORCE_SKILLS, type FillInBenchRecord } from "@/lib/workforce";

const initialState: WorkforceActionState = {};

export function FillInBenchForm({ worker }: { worker?: FillInBenchRecord }) {
  const [state, action, pending] = useActionState(saveFillInBenchWorker, initialState);
  const selected = new Set(worker?.skills ?? []);

  return (
    <form action={action} className="space-y-3 rounded-lg border p-3">
      {worker ? <input type="hidden" name="id" value={worker.id} /> : null}
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
          <Label htmlFor={`bench-name-${worker?.id ?? "new"}`}>Name</Label>
          <Input
            id={`bench-name-${worker?.id ?? "new"}`}
            name="displayName"
            defaultValue={worker?.displayName ?? ""}
            required
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`bench-contact-${worker?.id ?? "new"}`}>Contact preference</Label>
          <select
            id={`bench-contact-${worker?.id ?? "new"}`}
            name="contactPreference"
            defaultValue={worker?.contactPreference ?? "PHONE"}
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
          >
            {BENCH_CONTACT_PREFERENCES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`bench-value-${worker?.id ?? "new"}`}>Internal contact</Label>
          <Input
            id={`bench-value-${worker?.id ?? "new"}`}
            name="contactValue"
            defaultValue={worker?.contactValue ?? ""}
            placeholder="Owner-only. Never published."
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`bench-avail-${worker?.id ?? "new"}`}>Availability notes</Label>
          <Input
            id={`bench-avail-${worker?.id ?? "new"}`}
            name="availabilityNotes"
            defaultValue={worker?.availabilityNotes ?? ""}
          />
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {WORKFORCE_SKILLS.map((skill) => (
          <label key={skill.key} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="benchSkill"
              value={skill.key}
              defaultChecked={selected.has(skill.key)}
              className="size-4"
            />
            {skill.label}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap gap-3 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" name="approved" value="1" defaultChecked={worker?.approved ?? true} />
          Approved
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="active" value="1" defaultChecked={worker?.active ?? true} />
          Active
        </label>
      </div>
      <Input name="notes" defaultValue={worker?.notes ?? ""} placeholder="Internal notes" />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : worker ? "Update bench worker" : "Add to Fill-In Bench"}
      </Button>
    </form>
  );
}

export function FillInBenchUseButton({ benchWorkerId }: { benchWorkerId: string }) {
  const [state, action, pending] = useActionState(markFillInBenchUsed, initialState);
  return (
    <form action={action} className="inline">
      <input type="hidden" name="benchWorkerId" value={benchWorkerId} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Saving…" : "Mark last used"}
      </Button>
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}

export function StaffingOutreachForm({
  jobId,
  missingSkills,
  explanation,
}: {
  jobId?: string;
  missingSkills: string;
  explanation: string;
}) {
  const [state, action, pending] = useActionState(createWorkforceOutreachTask, initialState);
  return (
    <form action={action} className="space-y-2">
      {jobId ? <input type="hidden" name="jobId" value={jobId} /> : null}
      <input type="hidden" name="kind" value="STAFFING_SHORTAGE" />
      <input type="hidden" name="missingSkills" value={missingSkills} />
      <input type="hidden" name="explanation" value={explanation} />
      <input type="hidden" name="approve" value="1" />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Saving…" : "Create staffing outreach task"}
      </Button>
      <p className="text-xs text-muted-foreground">
        Creates one outreach task. Owner approval is recorded only when an owner
        submits. No message is sent.
      </p>
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
    </form>
  );
}

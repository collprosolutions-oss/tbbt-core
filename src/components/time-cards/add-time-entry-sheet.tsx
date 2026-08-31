"use client";

import { useActionState } from "react";
import {
  createManualTimeEntryAction,
  type TimeCardActionState,
} from "@/app/actions/time-cards";
import type { TimeCardJobOption, TimeCardWorker } from "@/components/time-cards/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { TIME_ACTIVITY_LABELS, TIME_ACTIVITY_TYPES } from "@/lib/time-cards";

const initialState: TimeCardActionState = {};

export function AddTimeEntrySheet({
  open,
  onOpenChange,
  workers,
  jobs,
  defaultMembershipId,
  defaultDate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workers: TimeCardWorker[];
  jobs: TimeCardJobOption[];
  defaultMembershipId: string;
  defaultDate: string;
}) {
  const [state, formAction, pending] = useActionState(
    createManualTimeEntryAction,
    initialState,
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Time Entry</SheetTitle>
          <SheetDescription>
            Manual owner/admin entry. Saved as an auditable record, not a silent overwrite.
          </SheetDescription>
        </SheetHeader>
        <form action={formAction} className="mt-4 space-y-3 px-4 pb-6">
          <Field label="Worker">
            <select
              name="membershipId"
              defaultValue={defaultMembershipId}
              required
              className={selectClass}
            >
              {workers.map((worker) => (
                <option key={worker.membershipId} value={worker.membershipId}>
                  {worker.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Activity">
            <select name="activityType" defaultValue="JOB" required className={selectClass}>
              {TIME_ACTIVITY_TYPES.map((type) => (
                <option key={type} value={type}>
                  {TIME_ACTIVITY_LABELS[type]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Job (optional except Job time)">
            <select name="jobId" defaultValue="" className={selectClass}>
              <option value="">No job</option>
              {jobs.map((job) => (
                <option key={job.id} value={job.id}>
                  {job.label}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Start date">
              <Input type="date" name="startDate" defaultValue={defaultDate} required />
            </Field>
            <Field label="Start time">
              <Input type="time" name="startTime" defaultValue="09:00" step={60} required />
            </Field>
            <Field label="End date">
              <Input type="date" name="endDate" defaultValue={defaultDate} required />
            </Field>
            <Field label="End time">
              <Input type="time" name="endTime" defaultValue="17:00" step={60} required />
            </Field>
          </div>
          <Field label="Note / reason">
            <Input name="note" placeholder="Why this entry exists" />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="needsReview" value="1" className="size-4" />
            Flag for review
          </label>
          {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
          {state.message ? <p className="text-sm text-emerald-400">{state.message}</p> : null}
          <Button type="submit" disabled={pending} className="w-full">
            {pending ? "Saving…" : "Save time entry"}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

const selectClass =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30";

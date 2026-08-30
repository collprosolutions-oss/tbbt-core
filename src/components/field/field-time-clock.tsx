"use client";

import { useActionState } from "react";
import { clockInAction, clockOutAction, type TimeCardActionState } from "@/app/actions/time-cards";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TIME_ACTIVITY_LABELS, type TimeActivityType } from "@/lib/time-cards";

const initialState: TimeCardActionState = {};

const NON_JOB_ACTIVITIES: TimeActivityType[] = ["TRAVEL", "MATERIAL_PICKUP", "BREAK", "OTHER"];

export function FieldTimeClock({
  membershipId,
  running,
  assignedJobs,
  defaultJobId,
}: {
  membershipId: string;
  running: {
    activityType: string;
    activityLabel: string;
    jobLabel: string | null;
    startedAtLabel: string;
  } | null;
  assignedJobs: { id: string; label: string }[];
  defaultJobId?: string;
}) {
  const [inState, clockIn, inPending] = useActionState(clockInAction, initialState);
  const [outState, clockOut, outPending] = useActionState(clockOutAction, initialState);
  const error = inState.error ?? outState.error;
  const message = inState.message ?? outState.message;

  return (
    <Card>
      <CardHeader>
        <CardTitle>My Time</CardTitle>
        <CardDescription>
          Clock time separately from Start Job. Job status stays operational; this is labor time.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {running ? (
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
            <p className="font-medium">
              Clocked in · {running.activityLabel}
              {running.jobLabel ? ` · ${running.jobLabel}` : ""}
            </p>
            <p className="text-muted-foreground">Since {running.startedAtLabel}</p>
            <form action={clockOut} className="mt-3">
              <input type="hidden" name="membershipId" value={membershipId} />
              <Button type="submit" disabled={outPending} className="h-12 w-full text-base">
                {outPending ? "Clocking out…" : "Clock Out"}
              </Button>
            </form>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">You are not clocked in.</p>
        )}

        {assignedJobs.length > 0 ? (
          <form action={clockIn} className="space-y-2">
            <input type="hidden" name="membershipId" value={membershipId} />
            <input type="hidden" name="activityType" value="JOB" />
            <label className="block text-sm font-medium">Clock into a job</label>
            <select
              name="jobId"
              defaultValue={defaultJobId ?? assignedJobs[0]?.id}
              className="h-11 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
            >
              {assignedJobs.map((job) => (
                <option key={job.id} value={job.id}>
                  {job.label}
                </option>
              ))}
            </select>
            <Button type="submit" disabled={inPending} variant="outline" className="h-11 w-full">
              {inPending ? "Clocking in…" : "Clock In · Job"}
            </Button>
          </form>
        ) : null}

        <div className="grid grid-cols-2 gap-2">
          {NON_JOB_ACTIVITIES.map((activity) => (
            <form key={activity} action={clockIn}>
              <input type="hidden" name="membershipId" value={membershipId} />
              <input type="hidden" name="activityType" value={activity} />
              {defaultJobId && activity !== "BREAK" ? (
                <input type="hidden" name="jobId" value={defaultJobId} />
              ) : null}
              <Button
                type="submit"
                disabled={inPending}
                variant="outline"
                className="h-11 w-full text-xs"
              >
                {TIME_ACTIVITY_LABELS[activity]}
              </Button>
            </form>
          ))}
        </div>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {message ? <p className="text-sm text-emerald-400">{message}</p> : null}
      </CardContent>
    </Card>
  );
}

"use client";

import { useActionState } from "react";
import { assignJobLocationAction } from "@/app/actions/job-location";
import type { JobLocationActionState } from "@/app/actions/job-location";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { JOB_LOCATION_UNASSIGNED_LABEL } from "@/lib/job-location";

const initialState: JobLocationActionState = {};

export type AssignableJobLocation = {
  id: string;
  name: string;
};

/**
 * OWNER-only Work Order control. The option list is a UX convenience —
 * assignJobBusinessLocation() rechecks location ownership at write time
 * and rejects stale / concurrent job edits.
 */
export function AssignJobLocationForm({
  jobId,
  expectedUpdatedAt,
  assignedLocationId,
  locations,
}: {
  jobId: string;
  expectedUpdatedAt: string;
  assignedLocationId: string | null;
  locations: AssignableJobLocation[];
}) {
  const [state, formAction, pending] = useActionState(assignJobLocationAction, initialState);

  return (
    <form key={expectedUpdatedAt} action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="expectedUpdatedAt" value={expectedUpdatedAt} />
      <select
        name="locationId"
        defaultValue={assignedLocationId ?? ""}
        className="h-8 min-w-48 rounded-lg border border-input bg-transparent px-2.5 text-sm"
        aria-label="Assigned business location"
      >
        <option value="">{JOB_LOCATION_UNASSIGNED_LABEL}</option>
        {locations.map((location) => (
          <option key={location.id} value={location.id}>
            {location.name}
          </option>
        ))}
      </select>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Save location"}
      </Button>
      {state.error ? (
        <Alert variant="destructive" className="w-full">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.message ? (
        <p className="w-full text-xs text-muted-foreground">{state.message}</p>
      ) : null}
    </form>
  );
}

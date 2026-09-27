"use client";

import { useActionState } from "react";
import {
  attachCleaningCrewChecklistAction,
  setCleaningVisitCadenceAction,
  type CleaningVisitActionState,
} from "@/app/actions/cleaning-visit";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { CleaningVisitView } from "@/lib/cleaning-visit-data";

const initial: CleaningVisitActionState = {};

export function CleaningVisitCadenceForm({
  visit,
  canSetCadence,
}: {
  visit: CleaningVisitView;
  canSetCadence: boolean;
}) {
  const [cadenceState, cadenceAction, cadencePending] = useActionState(
    setCleaningVisitCadenceAction,
    initial,
  );
  const [checklistState, checklistAction, checklistPending] = useActionState(
    attachCleaningCrewChecklistAction,
    initial,
  );

  return (
    <div className="space-y-4">
      <div className="space-y-1 text-sm">
        <p>Current cadence: {visit.cadenceLabel}</p>
        <p>Visit outcome: {visit.outcomeLabel}</p>
        <p>
          Checklist: {visit.procedureTitle ?? "Cleaning pack crew checklist"}
        </p>
      </div>

      {canSetCadence ? (
        <form action={cadenceAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="jobId" value={visit.jobId} />
          <div className="space-y-1">
            <Label htmlFor="cleaning-visit-cadence">Visit cadence</Label>
            <select
              id="cleaning-visit-cadence"
              name="cadence"
              defaultValue={
                visit.serviceIntent === "RECURRING" && visit.recurrenceCadence
                  ? visit.recurrenceCadence
                  : "WEEKLY"
              }
              className="h-9 rounded-md border bg-background px-2 text-sm"
            >
              <option value="WEEKLY">Weekly</option>
              <option value="BIWEEKLY">Every two weeks</option>
              <option value="MONTHLY">Monthly</option>
              <option value="ONE_TIME">One-time</option>
            </select>
          </div>
          <Button type="submit" size="sm" disabled={cadencePending}>
            {cadencePending ? "Saving…" : "Save cadence"}
          </Button>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">
          Only the owner can set the visit cadence.
        </p>
      )}
      {cadenceState.error ? (
        <p className="text-sm text-destructive">{cadenceState.error}</p>
      ) : null}
      {cadenceState.message ? (
        <p className="text-sm text-muted-foreground">{cadenceState.message}</p>
      ) : null}

      {canSetCadence && visit.checklists.length > 0 ? (
        <form action={checklistAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="jobId" value={visit.jobId} />
          <div className="space-y-1">
            <Label htmlFor="cleaning-visit-checklist">Crew checklist</Label>
            <select
              id="cleaning-visit-checklist"
              name="procedureId"
              defaultValue={visit.procedureId ?? visit.checklists[0]?.id}
              className="h-9 rounded-md border bg-background px-2 text-sm"
            >
              {visit.checklists.map((procedure) => (
                <option key={procedure.id} value={procedure.id}>
                  {procedure.title}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" size="sm" variant="outline" disabled={checklistPending}>
            {checklistPending ? "Attaching…" : "Use this checklist"}
          </Button>
        </form>
      ) : null}
      {checklistState.error ? (
        <p className="text-sm text-destructive">{checklistState.error}</p>
      ) : null}
      {checklistState.message ? (
        <p className="text-sm text-muted-foreground">{checklistState.message}</p>
      ) : null}

      <ol className="list-decimal space-y-1 pl-5 text-sm">
        {visit.checklist.map((item) => (
          <li key={item.key}>
            {item.title}
            {item.checked ? " — checked" : ""}
          </li>
        ))}
      </ol>
    </div>
  );
}

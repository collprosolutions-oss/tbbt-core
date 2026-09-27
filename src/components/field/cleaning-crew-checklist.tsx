"use client";

import { useActionState } from "react";
import {
  recordAssignedVisitOutcomeAction,
  setAssignedChecklistItemAction,
  type CleaningVisitActionState,
} from "@/app/actions/cleaning-visit";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useSaasOperating } from "@/components/saas/saas-operating-context";

const initial: CleaningVisitActionState = {};

export function CleaningCrewChecklist({
  jobId,
  cadenceLabel,
  outcomeLabel,
  procedureTitle,
  checklist,
  hasCadence,
}: {
  jobId: string;
  cadenceLabel: string;
  outcomeLabel: string;
  procedureTitle: string | null;
  checklist: Array<{ key: string; title: string; checked: boolean }>;
  hasCadence: boolean;
}) {
  const [checkState, checkAction, checkPending] = useActionState(
    setAssignedChecklistItemAction,
    initial,
  );
  const [outcomeState, outcomeAction, outcomePending] = useActionState(
    recordAssignedVisitOutcomeAction,
    initial,
  );
  const operating = useSaasOperating();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Crew checklist</CardTitle>
        <CardDescription>
          {hasCadence
            ? `${cadenceLabel} visit. ${procedureTitle ?? "Cleaning pack crew checklist"}.`
            : "Owner has not set a visit cadence yet. You can still record the checklist for this assigned visit."}{" "}
          Recorded outcome: {outcomeLabel}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="space-y-2">
          {checklist.map((item) => (
            <li key={item.key}>
              <form action={checkAction} className="flex items-start gap-2 text-sm">
                <input type="hidden" name="jobId" value={jobId} />
                <input type="hidden" name="itemKey" value={item.key} />
                <input type="hidden" name="checked" value={item.checked ? "0" : "1"} />
                <Button
                  type="submit"
                  variant={item.checked ? "secondary" : "outline"}
                  size="sm"
                  disabled={checkPending || !operating.canOperate}
                  className="mt-0.5"
                >
                  {item.checked ? "Done" : "Mark done"}
                </Button>
                <span>{item.title}</span>
              </form>
            </li>
          ))}
        </ul>
        {checkState.error ? (
          <p className="text-sm text-destructive">{checkState.error}</p>
        ) : null}

        {operating.canOperate ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <form action={outcomeAction}>
              <input type="hidden" name="jobId" value={jobId} />
              <input type="hidden" name="outcomeStatus" value="VISIT_COMPLETED" />
              <Button type="submit" className="h-12 w-full" disabled={outcomePending}>
                {outcomePending ? "Recording…" : "Record visit completed"}
              </Button>
            </form>
            <form action={outcomeAction}>
              <input type="hidden" name="jobId" value={jobId} />
              <input type="hidden" name="outcomeStatus" value="RE_CLEAN_REQUESTED" />
              <Button
                type="submit"
                variant="outline"
                className="h-12 w-full"
                disabled={outcomePending}
              >
                {outcomePending ? "Recording…" : "Request re-clean"}
              </Button>
            </form>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{operating.blockedMessage}</p>
        )}
        {outcomeState.error ? (
          <p className="text-sm text-destructive">{outcomeState.error}</p>
        ) : null}
        {outcomeState.message ? (
          <p className="text-sm text-muted-foreground">{outcomeState.message}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

"use client";

import { useActionState } from "react";
import { planStudioPublicationDayAction, type MarketingActionState } from "@/app/actions/marketing";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OWNER_STUDIO_CALENDAR_MESSAGE } from "@/lib/marketing";

const initial: MarketingActionState = {};

export function StudioPublicationDayForm({
  contentId,
  plannedDay,
  expectedUpdatedAt,
  timeZone,
  canPlan,
}: {
  contentId: string;
  plannedDay: string;
  expectedUpdatedAt: string;
  timeZone: string;
  canPlan: boolean;
}) {
  const [state, formAction, pending] = useActionState(planStudioPublicationDayAction, initial);

  if (!canPlan) {
    return <p className="text-xs text-muted-foreground">{OWNER_STUDIO_CALENDAR_MESSAGE}</p>;
  }

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="contentId" value={contentId} />
      <input type="hidden" name="expectedUpdatedAt" value={expectedUpdatedAt} />
      <Input type="date" name="plannedFor" defaultValue={plannedDay} required className="w-40" />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Saving…" : "Save planned day"}
      </Button>
      <p className="w-full text-xs text-muted-foreground">Business timezone: {timeZone}</p>
      {state.error ? <p className="w-full text-xs text-destructive">{state.error}</p> : null}
      {state.message ? <p className="w-full text-xs text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}

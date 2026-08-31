"use client";

import { useActionState } from "react";
import { setMarketingPlannedDateAction, type MarketingActionState } from "@/app/actions/marketing";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const initial: MarketingActionState = {};

export function PlannedDateForm({
  contentId,
  plannedFor,
}: {
  contentId: string;
  plannedFor: string;
}) {
  const [state, formAction, pending] = useActionState(setMarketingPlannedDateAction, initial);

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="contentId" value={contentId} />
      <Input type="date" name="plannedFor" defaultValue={plannedFor} required className="w-40" />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Saving…" : "Save date"}
      </Button>
      {state.error ? <p className="w-full text-xs text-destructive">{state.error}</p> : null}
      {state.message ? <p className="w-full text-xs text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}

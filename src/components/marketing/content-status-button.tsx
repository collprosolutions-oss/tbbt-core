"use client";

import { useActionState } from "react";
import { advanceMarketingContentAction, type MarketingActionState } from "@/app/actions/marketing";
import { Button } from "@/components/ui/button";

const initial: MarketingActionState = {};

export function ContentStatusButton({
  contentId,
  status,
}: {
  contentId: string;
  status: string;
}) {
  const [state, formAction, pending] = useActionState(advanceMarketingContentAction, initial);
  if (status === "APPROVED") return null;
  const label = status === "DRAFT" ? "Send for review" : "Approve content";

  return (
    <form action={formAction} className="space-y-1">
      <input type="hidden" name="contentId" value={contentId} />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Updating…" : label}
      </Button>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}

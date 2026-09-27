"use client";

import { useActionState } from "react";
import { advanceMarketingContentAction, type MarketingActionState } from "@/app/actions/marketing";
import { Button } from "@/components/ui/button";
import { OWNER_STUDIO_APPROVAL_MESSAGE } from "@/lib/marketing";

const initial: MarketingActionState = {};

export function ContentStatusButton({
  contentId,
  status,
  canApprove,
  photosEligible,
}: {
  contentId: string;
  status: string;
  canApprove: boolean;
  photosEligible: boolean;
}) {
  const [state, formAction, pending] = useActionState(advanceMarketingContentAction, initial);
  if (status === "APPROVED") return null;

  if (status === "READY_FOR_REVIEW" && !canApprove) {
    return <p className="text-xs text-muted-foreground">{OWNER_STUDIO_APPROVAL_MESSAGE}</p>;
  }
  if (!photosEligible) {
    return (
      <p className="text-xs text-destructive">
        A selected photo no longer has marketing permission. Approval is blocked.
      </p>
    );
  }

  const label = status === "DRAFT" ? "Send for OWNER review" : "Approve creator package";

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

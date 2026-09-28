"use client";

import { useActionState } from "react";
import {
  approveMarketingStudioPackageAction,
  returnMarketingStudioPackageAction,
  type MarketingActionState,
} from "@/app/actions/marketing";
import { Button } from "@/components/ui/button";
import {
  OWNER_STUDIO_APPROVAL_MESSAGE,
  STUDIO_RETURN_FOR_CHANGES_MESSAGE,
} from "@/lib/marketing";

const initial: MarketingActionState = {};

export function StudioApprovalActions({
  contentId,
  canApprove,
  canReturn,
  photosEligible,
}: {
  contentId: string;
  canApprove: boolean;
  canReturn: boolean;
  photosEligible: boolean;
}) {
  const [approveState, approveAction, approvePending] = useActionState(
    approveMarketingStudioPackageAction,
    initial,
  );
  const [returnState, returnAction, returnPending] = useActionState(
    returnMarketingStudioPackageAction,
    initial,
  );
  const pending = approvePending || returnPending;
  const error = approveState.error ?? returnState.error;
  const message = approveState.message ?? returnState.message;

  if (!canApprove && !canReturn) {
    return <p className="text-xs text-muted-foreground">{OWNER_STUDIO_APPROVAL_MESSAGE}</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {canApprove ? (
          <form action={approveAction}>
            <input type="hidden" name="contentId" value={contentId} />
            <Button type="submit" size="sm" disabled={pending || !photosEligible}>
              {approvePending ? "Approving…" : "Approve"}
            </Button>
          </form>
        ) : (
          <p className="text-xs text-muted-foreground">{OWNER_STUDIO_APPROVAL_MESSAGE}</p>
        )}
        {canReturn ? (
          <form action={returnAction}>
            <input type="hidden" name="contentId" value={contentId} />
            <Button type="submit" size="sm" variant="outline" disabled={pending}>
              {returnPending ? "Returning…" : "Return for changes"}
            </Button>
          </form>
        ) : (
          <p className="text-xs text-muted-foreground">{STUDIO_RETURN_FOR_CHANGES_MESSAGE}</p>
        )}
      </div>
      {!photosEligible ? (
        <p className="text-xs text-destructive">
          A selected photo no longer has marketing permission. Approval is blocked.
        </p>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
    </div>
  );
}

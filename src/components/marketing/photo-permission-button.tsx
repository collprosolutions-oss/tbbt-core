"use client";

import { useActionState } from "react";
import {
  grantPhotoMarketingPermissionAction,
  revokePhotoMarketingPermissionAction,
  type MarketingActionState,
} from "@/app/actions/marketing";
import { Button } from "@/components/ui/button";

const initial: MarketingActionState = {};

export function PhotoPermissionButton({
  photoId,
  approved,
}: {
  photoId: string;
  approved: boolean;
}) {
  const action = approved ? revokePhotoMarketingPermissionAction : grantPhotoMarketingPermissionAction;
  const [state, formAction, pending] = useActionState(action, initial);

  return (
    <form action={formAction} className="space-y-1">
      <input type="hidden" name="photoId" value={photoId} />
      <Button type="submit" size="xs" variant={approved ? "outline" : "default"} disabled={pending}>
        {pending ? "Saving…" : approved ? "Revoke marketing permission" : "Approve for marketing"}
      </Button>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}

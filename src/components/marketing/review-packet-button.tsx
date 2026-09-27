"use client";

import { useActionState, useEffect } from "react";
import {
  downloadMarketingReviewPacketAction,
  type MarketingReviewPacketState,
} from "@/app/actions/marketing";
import { Button } from "@/components/ui/button";

const initial: MarketingReviewPacketState = {};

export function ReviewPacketButton({
  contentId,
  canDownload,
  draft,
}: {
  contentId: string;
  canDownload: boolean;
  draft: boolean;
}) {
  const [state, formAction, pending] = useActionState(downloadMarketingReviewPacketAction, initial);

  useEffect(() => {
    if (!state.packetJson || !state.filename) return;
    const blob = new Blob([state.packetJson], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = state.filename;
    link.click();
    URL.revokeObjectURL(href);
  }, [state.packetJson, state.filename]);

  if (!canDownload) return null;

  return (
    <form action={formAction} className="space-y-1">
      <input type="hidden" name="contentId" value={contentId} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Downloading…" : draft ? "Download draft review packet" : "Download review packet"}
      </Button>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}

"use client";

import { useActionState, useEffect, useRef } from "react";
import {
  downloadMarketingReviewPacketAction,
  type MarketingReviewPacketState,
} from "@/app/actions/marketing";
import { Button } from "@/components/ui/button";
import { nextReviewPacketDownload } from "@/lib/marketing";

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
  const lastNonceRef = useRef<string | null>(null);

  useEffect(() => {
    const next = nextReviewPacketDownload(lastNonceRef.current, state);
    if (!next.shouldDownload) return;
    lastNonceRef.current = next.nonce;
    const blob = new Blob([next.packetJson], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = next.filename;
    link.click();
    URL.revokeObjectURL(href);
  }, [state]);

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

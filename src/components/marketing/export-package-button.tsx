"use client";

import { useActionState, useEffect } from "react";
import { exportMarketingCreatorPackageAction, type MarketingExportState } from "@/app/actions/marketing";
import { Button } from "@/components/ui/button";

const initial: MarketingExportState = {};

export function ExportPackageButton({
  contentId,
  canExport,
}: {
  contentId: string;
  canExport: boolean;
}) {
  const [state, formAction, pending] = useActionState(exportMarketingCreatorPackageAction, initial);

  useEffect(() => {
    if (!state.packageJson || !state.filename) return;
    const blob = new Blob([state.packageJson], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = state.filename;
    link.click();
    URL.revokeObjectURL(href);
  }, [state.packageJson, state.filename]);

  if (!canExport) return null;

  return (
    <form action={formAction} className="space-y-1">
      <input type="hidden" name="contentId" value={contentId} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Exporting…" : "Export creator package"}
      </Button>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}

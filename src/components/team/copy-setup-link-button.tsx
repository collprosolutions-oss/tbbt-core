"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Copies the exact one-time setup link addTeamMember() already generated
 * server-side (see src/app/actions/team.ts) -- unlike
 * CopyProjectLinkButton/CopyEstimateLinkButton, this does not rebuild the
 * URL from `window.location.origin`, since the link's origin comes from
 * NEXT_PUBLIC_APP_URL, not necessarily the browser's current origin.
 */
export function CopySetupLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={async () => {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? "Copied" : "Copy setup link"}
    </Button>
  );
}

"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function CopyProjectLinkButton({
  projectToken,
  hrefPath,
  label = "Copy customer link",
}: {
  projectToken: string;
  hrefPath?: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const path = hrefPath ?? `/p/${projectToken}`;

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={async () => {
        const url = `${window.location.origin}${path}`;
        await navigator.clipboard.writeText(url);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

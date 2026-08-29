"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function CopyProjectLinkButton({
  projectToken,
}: {
  projectToken: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={async () => {
        const url = `${window.location.origin}/p/${projectToken}`;
        await navigator.clipboard.writeText(url);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? "Copied" : "Copy customer link"}
    </Button>
  );
}

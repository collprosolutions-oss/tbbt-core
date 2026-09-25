"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function CopyDirectionsLinkButton({
  href,
  label = "Copy directions",
}: {
  href: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={async () => {
        await navigator.clipboard.writeText(href);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

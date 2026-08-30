"use client";

import { SlidersHorizontal } from "lucide-react";
import { useFounderDesign } from "@/components/founder-design/context";
import { Button } from "@/components/ui/button";

/**
 * The clearly-identifiable "Founder Design Mode" control (see spec
 * section 7). Only ever mounted by FounderDesignRoot when the current
 * session's own User.isFounder is true -- there is no other code path
 * that renders this. Fixed at the bottom-right so it never collides with
 * the existing bottom-left Next.js dev indicator.
 */
export function FounderDesignTrigger() {
  const founderDesign = useFounderDesign();
  if (!founderDesign) return null;

  return (
    <Button
      type="button"
      onClick={() => founderDesign.setOpen(true)}
      className="fixed bottom-4 right-4 z-40 gap-2 rounded-full border border-primary/40 bg-primary/90 px-4 py-2 text-primary-foreground shadow-lg hover:bg-primary"
    >
      <SlidersHorizontal className="size-4" />
      Founder Design Mode
      {founderDesign.isDirty ? (
        <span className="ml-1 flex size-2 rounded-full bg-amber-400" aria-label="Unsaved changes" />
      ) : null}
    </Button>
  );
}

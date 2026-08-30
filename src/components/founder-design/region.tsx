"use client";

import type { CSSProperties, ReactNode } from "react";
import { useFounderDesign } from "@/components/founder-design/context";
import { regionTokensToStyle } from "@/lib/founder-design";
import { cn } from "@/lib/utils";

/**
 * Marks one real visual region on a supported page. For non-founders
 * (no context) this is a no-op -- children render exactly as they did
 * before, with no extra wrapper unless `className` is needed for the
 * founder's own highlight (which never mounts).
 *
 * When Founder Design Mode is open and this region is selected, a
 * subtle outline identifies the box. The outline is not persisted and
 * disappears as soon as the drawer closes.
 */
export function FounderRegion({
  id,
  className,
  style,
  children,
}: {
  id: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const founderDesign = useFounderDesign();
  if (!founderDesign) {
    // Preserve layout classes that were moved from the original box
    // onto this wrapper (grid spans, hidden breakpoints, space-y).
    if (!className && !style) return <>{children}</>;
    return (
      <div className={className} style={style}>
        {children}
      </div>
    );
  }

  const highlighted = founderDesign.open && founderDesign.selectedRegionId === id;
  const regionStyle = regionTokensToStyle(founderDesign.draftTokens.regions?.[id]);

  return (
    <div
      data-founder-region={id}
      data-founder-highlight={highlighted ? "true" : undefined}
      className={cn("min-w-0", className)}
      style={{ ...regionStyle, ...style }}
    >
      {children}
    </div>
  );
}

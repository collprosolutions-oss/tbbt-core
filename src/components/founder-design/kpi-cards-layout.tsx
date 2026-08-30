"use client";

import { Children, type ReactNode } from "react";
import { useFounderDesign } from "@/components/founder-design/context";
import { resolveKpiCardFlex } from "@/lib/founder-design";
import { cn } from "@/lib/utils";

/**
 * Wraps a page's KPI cards (passed as `children`, already fully
 * server-rendered <KpiCard/>/<OverviewKpi/> elements -- this component
 * never knows or cares about their internals) so a founder can size the
 * ROW (equal-width today's default, or custom per-card widths) without
 * touching each page's own card markup.
 *
 * For any non-founder (no FounderDesignContext above this in the tree)
 * this renders the EXACT SAME grid markup the page used before this
 * feature existed -- same classes, same gap default -- so it is a
 * complete no-op.
 *
 * Mobile safety: the grid layout (`grid grid-cols-2 ...`) is always what
 * applies below the `lg:` breakpoint; only at `lg:` and up does the
 * container switch to `flex` and per-card custom widths take effect
 * (flex-basis/flex-grow are simply ignored on a grid item, so an
 * untouched mobile view is never affected even if a founder has saved
 * per-card desktop widths).
 */
export function KpiCardsLayout({
  gridClassName,
  flexBreakpointClassName = "lg:flex lg:flex-wrap",
  defaultGapPx,
  children,
}: {
  /** That page's own current grid classes, unchanged -- e.g. "sm:grid-cols-2 lg:grid-cols-5" for a full-width KPI row, or "grid-cols-2" for Customers' always-2-column rail widget. */
  gridClassName: string;
  /** At which breakpoint (if any) the container switches from grid to flex so custom per-card widths can take effect. Below it, custom widths are always inert (grid ignores flex-basis/flex-grow). */
  flexBreakpointClassName?: string;
  defaultGapPx: number;
  children: ReactNode;
}) {
  const founderDesign = useFounderDesign();
  const items = Children.toArray(children);

  const containerStyle = { gap: `var(--tbbt-kpi-gap, ${defaultGapPx}px)` };

  if (!founderDesign) {
    return (
      <div className={cn("grid", gridClassName)} style={containerStyle}>
        {children}
      </div>
    );
  }

  const width = founderDesign.draftTokens.kpiWidth;

  return (
    <div className={cn("grid", gridClassName, flexBreakpointClassName)} style={containerStyle}>
      {items.map((child, index) => {
        const { flexBasis, flexGrow, flexShrink } = resolveKpiCardFlex(width, index);
        const highlighted = founderDesign.hoveredCardIndex === index;
        return (
          <div
            key={index}
            className={cn(
              "min-w-0 lg:transition-shadow",
              highlighted && "lg:rounded-xl lg:ring-2 lg:ring-primary lg:ring-offset-2 lg:ring-offset-background",
            )}
            style={{ flexBasis, flexGrow, flexShrink }}
          >
            {child}
          </div>
        );
      })}
    </div>
  );
}

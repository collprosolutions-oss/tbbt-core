"use client";

import { useFounderDesign } from "@/components/founder-design/context";
import { CURATED_ICONS, iconForegroundClass, type CuratedIconId } from "@/lib/founder-icons";
import { cn } from "@/lib/utils";

/**
 * Title/panel icon that honors a founder override (curated glyph +
 * palette color) when Design Mode tokens exist, and otherwise renders
 * the page's original approved icon/treatment.
 */
export function FounderRegionIcon({
  regionId,
  defaultIcon,
  className,
}: {
  regionId: string;
  defaultIcon: CuratedIconId;
  className?: string;
}) {
  const founderDesign = useFounderDesign();
  const override = founderDesign?.draftTokens.regions?.[regionId];
  const iconId = override?.icon && CURATED_ICONS[override.icon] ? override.icon : defaultIcon;
  const Icon = CURATED_ICONS[iconId];
  const colorClass = iconForegroundClass(override?.iconColor);

  return (
    <span
      className="inline-flex shrink-0"
      style={{
        width: "var(--tbbt-region-icon-size, 1em)",
        height: "var(--tbbt-region-icon-size, 1em)",
      }}
    >
      <Icon className={cn("size-full", className, colorClass)} />
    </span>
  );
}

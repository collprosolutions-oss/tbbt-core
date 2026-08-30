"use client";

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { useFounderDesign } from "@/components/founder-design/context";
import { Card, CardContent } from "@/components/ui/card";
import {
  KPI_DEFAULTS,
  resolveKpiPaddingX,
  resolveKpiPaddingY,
  type FounderPageKey,
} from "@/lib/founder-design";
import { CURATED_ICONS, iconTintClass, type CuratedIconId } from "@/lib/founder-icons";
import { cn } from "@/lib/utils";

export type TunableKpiVariant = "dashboard" | "workspace" | "overview";

/**
 * Shared KPI card used by all 6 supported pages. Zeros shadcn Card
 * chrome (`py`/`gap` from `--card-spacing`) so founder paddingY/X and
 * internalGap control ACTUAL rendered geometry -- the V1 bug was that
 * Card kept 16px block padding the founder token could not touch.
 *
 * Defaults include that former chrome so an untouched page still matches
 * the approved baseline. Compact/Aligned is an INTERNAL presentation
 * option only; cards themselves never move.
 */
export function TunableKpiCard({
  index,
  label,
  value,
  sublabel,
  href,
  defaultIconId,
  accentClassName,
  variant,
  pageKey: pageKeyProp,
}: {
  index: number;
  label: string;
  value: ReactNode;
  sublabel?: string;
  href?: string;
  defaultIconId: CuratedIconId;
  accentClassName?: string;
  variant: TunableKpiVariant;
  pageKey?: FounderPageKey;
}) {
  const founderDesign = useFounderDesign();
  const pageKey = founderDesign?.pageKey ?? pageKeyProp ?? "dashboard";
  const defaults = KPI_DEFAULTS[pageKey];
  const kpi = founderDesign?.draftTokens.kpi;
  const appearance = founderDesign?.draftTokens.kpiAppearance?.[index];
  const aligned = founderDesign?.draftTokens.kpiInternalLayout === "aligned";

  const iconId = appearance?.icon && CURATED_ICONS[appearance.icon] ? appearance.icon : defaultIconId;
  const Icon = CURATED_ICONS[iconId];
  const tint = iconTintClass(appearance?.iconColor);
  const iconWrapClass = tint ?? accentClassName ?? "bg-primary/10 text-primary";

  const paddingY = resolveKpiPaddingY(pageKey, kpi);
  const paddingX = resolveKpiPaddingX(pageKey, kpi);
  const internalGap = kpi?.internalGap ?? defaults.internalGap;
  const lineHeight = kpi?.lineHeight ?? defaults.lineHeight;
  const iconSize = kpi?.iconSize ?? defaults.iconSize;

  const contentStyle: CSSProperties = {
    paddingBlock: `var(--tbbt-kpi-padding-y, var(--tbbt-kpi-padding, ${paddingY}px))`,
    paddingInline: `var(--tbbt-kpi-padding-x, ${paddingX}px)`,
    gap: variant === "dashboard" && !aligned ? undefined : `var(--tbbt-kpi-internal-gap, ${internalGap}px)`,
  };

  const labelStyle: CSSProperties = {
    fontSize: `var(--tbbt-kpi-label-font, ${defaults.labelFontSize}px)`,
    lineHeight: `var(--tbbt-kpi-line-height, ${(lineHeight / 100).toFixed(2)})`,
  };
  const numberStyle: CSSProperties = {
    fontSize: `var(--tbbt-kpi-number-font, ${defaults.numberFontSize}px)`,
    lineHeight: `var(--tbbt-kpi-line-height, ${variant === "workspace" ? "1.00" : "1.15"})`,
  };
  const supportStyle: CSSProperties = {
    fontSize: `var(--tbbt-kpi-supporting-font, ${defaults.supportingFontSize}px)`,
    lineHeight: `var(--tbbt-kpi-line-height, ${(lineHeight / 100).toFixed(2)})`,
  };

  const iconWrapStyle: CSSProperties = {
    width: `var(--tbbt-kpi-icon-size, ${iconSize}px)`,
    height: `var(--tbbt-kpi-icon-size, ${iconSize}px)`,
  };
  const iconClass = "size-[calc(var(--tbbt-kpi-icon-size," + iconSize + "px)*0.5)]";

  const labelEl = (
    <p
      className={cn(
        "min-w-0 font-medium text-muted-foreground",
        variant !== "dashboard" && "font-semibold tracking-wider uppercase",
        aligned && "line-clamp-2",
      )}
      style={{
        ...labelStyle,
        ...(aligned
          ? {
              minHeight: `calc(2em * var(--tbbt-kpi-line-height, ${(lineHeight / 100).toFixed(2)}))`,
            }
          : null),
      }}
    >
      {label}
    </p>
  );
  const numberEl = (
    <p className="font-semibold tabular-nums tracking-tight text-foreground" style={numberStyle}>
      {value}
    </p>
  );
  const supportEl = sublabel ? (
    <p className={cn("text-muted-foreground", variant === "workspace" && "truncate")} style={supportStyle}>
      {sublabel}
    </p>
  ) : null;

  const iconEl = (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center",
        variant === "dashboard" ? "rounded-lg" : "rounded-full",
        iconWrapClass,
      )}
      style={iconWrapStyle}
    >
      <Icon className={iconClass} />
    </span>
  );

  const alignedBody = (
    <>
      {labelEl}
      <div className="flex min-w-0 items-center gap-2">
        {iconEl}
        <div className="min-w-0">{numberEl}</div>
      </div>
      {supportEl}
    </>
  );
  const alignedStyle = { ...contentStyle, gap: `var(--tbbt-kpi-internal-gap, ${internalGap}px)` };

  let inner: ReactNode;
  if (aligned && variant === "overview") {
    inner = (
      <div
        data-default-icon={defaultIconId}
        className="flex flex-col rounded-lg border border-border/60 bg-card/40"
        style={{ ...alignedStyle, minHeight: "var(--tbbt-kpi-min-height, 0px)" }}
      >
        {alignedBody}
      </div>
    );
  } else if (aligned) {
    inner = (
      <CardContent className="flex flex-col" style={alignedStyle}>
        {alignedBody}
      </CardContent>
    );
  } else if (variant === "dashboard") {
    inner = (
      <CardContent className="flex items-start justify-between gap-3" style={contentStyle}>
        <div className="flex min-w-0 flex-col" style={{ gap: `var(--tbbt-kpi-internal-gap, ${internalGap}px)` }}>
          {labelEl}
          {numberEl}
          {supportEl}
        </div>
        {iconEl}
      </CardContent>
    );
  } else if (variant === "workspace") {
    inner = (
      <CardContent className="flex items-center" style={{ ...contentStyle, gap: "1rem" }}>
        {iconEl}
        <div className="flex min-w-0 flex-col" style={{ gap: `var(--tbbt-kpi-internal-gap, ${internalGap}px)` }}>
          {labelEl}
          {numberEl}
          {supportEl}
        </div>
      </CardContent>
    );
  } else {
    inner = (
      <div
        data-default-icon={defaultIconId}
        className="flex flex-col rounded-lg border border-border/60 bg-card/40"
        style={{
          ...contentStyle,
          gap: `var(--tbbt-kpi-internal-gap, ${internalGap}px)`,
          minHeight: "var(--tbbt-kpi-min-height, 0px)",
        }}
      >
        {iconEl}
        {numberEl}
        {labelEl}
        {supportEl}
      </div>
    );
  }

  const card =
    variant === "overview" ? (
      inner
    ) : (
      <Card
        className={cn(
          "h-full overflow-visible py-0 gap-0 shadow-sm transition-colors hover:border-primary/40",
          variant === "dashboard" ? "hover:bg-accent/30" : "border-border/70 hover:bg-accent/20",
        )}
        style={{ minHeight: "var(--tbbt-kpi-min-height, 0px)", ["--card-spacing" as string]: "0px" }}
      >
        {inner}
      </Card>
    );

  if (!href) return card;
  return (
    <Link href={href} className="block" data-default-icon={defaultIconId}>
      {card}
    </Link>
  );
}

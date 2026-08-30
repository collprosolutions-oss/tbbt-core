"use client";

import { useState } from "react";
import { ChevronDown, Minus, Plus, RotateCcw } from "lucide-react";
import { useFounderDesign } from "@/components/founder-design/context";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  FOUNDER_PAGE_LABELS,
  KPI_DEFAULTS,
  KPI_TOKEN_BOUNDS,
  KPI_TOKEN_LABELS,
  KPI_WIDTH_BOUNDS,
  PAGE_HAS_PANEL,
  PANEL_WIDTH_BOUNDS,
  PANEL_WIDTH_DEFAULTS,
  REGION_TOKEN_BOUNDS,
  REGION_TOKEN_DEFAULTS,
  REGION_TOKEN_LABELS,
  SECTION_GAP_BOUNDS,
  SECTION_GAP_DEFAULT,
  TABLE_CELL_PX_BOUNDS,
  TABLE_CELL_PX_DEFAULTS,
  TABLE_DENSITIES,
  TABLE_FONT_SIZE_BOUNDS,
  TABLE_FONT_SIZE_DEFAULT,
  TABLE_HEADER_FONT_SIZE_BOUNDS,
  TABLE_HEADER_FONT_SIZE_DEFAULT,
  resolveKpiPaddingX,
  resolveKpiPaddingY,
  type KpiTokenKey,
  type RegionTokenKey,
  type TableDensity,
} from "@/lib/founder-design";
import {
  CURATED_ICON_IDS,
  CURATED_ICON_LABELS,
  ICON_COLORS,
  ICON_COLOR_LABELS,
} from "@/lib/founder-icons";
import { getFounderRegion, getFounderRegions } from "@/lib/founder-regions";
import { cn } from "@/lib/utils";

function ResetIcon({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title="Reset to default"
      className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <RotateCcw className="size-3" />
    </button>
  );
}

function Stepper({
  label,
  value,
  min,
  max,
  step,
  onChange,
  onReset,
  unit = "px",
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  onReset?: () => void;
  unit?: string;
  format?: (value: number) => string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <p className="min-w-0 flex-1 truncate text-sm text-foreground">{label}</p>
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          disabled={value <= min}
          onClick={() => onChange(Math.max(min, value - step))}
          aria-label={`Decrease ${label}`}
        >
          <Minus className="size-3.5" />
        </Button>
        <span className="w-14 text-center text-sm tabular-nums text-foreground">
          {format ? format(value) : `${value}${unit}`}
        </span>
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          disabled={value >= max}
          onClick={() => onChange(Math.min(max, value + step))}
          aria-label={`Increase ${label}`}
        >
          <Plus className="size-3.5" />
        </Button>
        {onReset ? <ResetIcon onClick={onReset} label={`Reset ${label}`} /> : <div className="size-6" />}
      </div>
    </div>
  );
}

function CardWidthStepper({
  label,
  value,
  onChange,
  onReset,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  onReset: () => void;
}) {
  const { min, max, step } = KPI_WIDTH_BOUNDS;
  const isAuto = value === 0;
  return (
    <div className="flex items-center justify-between gap-2">
      <p className="min-w-0 flex-1 truncate text-sm text-foreground">{label}</p>
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          disabled={isAuto}
          onClick={() => onChange(isAuto ? 0 : Math.max(0, value - step < min ? 0 : value - step))}
          aria-label={`Decrease ${label} width`}
        >
          <Minus className="size-3.5" />
        </Button>
        <span className="w-16 text-center text-sm tabular-nums text-foreground">{isAuto ? "Auto" : `${value}px`}</span>
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          disabled={value >= max}
          onClick={() => onChange(isAuto ? min : Math.min(max, value + step))}
          aria-label={`Increase ${label} width`}
        >
          <Plus className="size-3.5" />
        </Button>
        <ResetIcon onClick={onReset} label={`Reset ${label} width`} />
      </div>
    </div>
  );
}

function CollapsibleSection({
  title,
  defaultOpen = false,
  onReset,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  onReset: () => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-border/60 pb-3 last:border-b-0">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="flex flex-1 items-center gap-1.5 py-2 text-left"
        >
          <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-180")} />
          <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</span>
        </button>
        {open ? (
          <Button type="button" size="sm" variant="ghost" onClick={onReset} className="h-7 gap-1 text-xs">
            <RotateCcw className="size-3" />
            Reset
          </Button>
        ) : null}
      </div>
      {open ? <div className="space-y-3 pt-1 pb-1">{children}</div> : null}
    </div>
  );
}

function NativeSelect({
  label,
  value,
  onChange,
  onReset,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onReset?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <label className="min-w-0 flex-1 truncate text-sm text-foreground">{label}</label>
      <div className="flex items-center gap-1.5">
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-8 max-w-40 rounded-md border border-input bg-background px-2 text-xs"
        >
          {children}
        </select>
        {onReset ? <ResetIcon onClick={onReset} label={`Reset ${label}`} /> : <div className="size-6" />}
      </div>
    </div>
  );
}

export function FounderDesignDrawer() {
  const founderDesign = useFounderDesign();
  const [confirmResetPage, setConfirmResetPage] = useState(false);

  if (!founderDesign) return null;
  const design = founderDesign;

  const { pageKey, draftTokens, kpiCardLabels, isDirty, open, setOpen, saving, selectedRegionId, setSelectedRegionId } =
    design;
  const pageLabel = FOUNDER_PAGE_LABELS[pageKey];
  const regions = getFounderRegions(pageKey);
  const selected = getFounderRegion(pageKey, selectedRegionId) ?? regions[0];
  const kpiDefaults = KPI_DEFAULTS[pageKey];
  const panelDefault = PANEL_WIDTH_DEFAULTS[pageKey] ?? PANEL_WIDTH_BOUNDS.min;
  const tableCellPxDefault = TABLE_CELL_PX_DEFAULTS[pageKey];

  function kpiValue(key: KpiTokenKey) {
    if (key === "paddingY") return resolveKpiPaddingY(pageKey, draftTokens.kpi);
    if (key === "paddingX") return resolveKpiPaddingX(pageKey, draftTokens.kpi);
    return draftTokens.kpi?.[key] ?? kpiDefaults[key];
  }

  function regionValue(key: RegionTokenKey) {
    return draftTokens.regions?.[selected.id]?.[key] ?? REGION_TOKEN_DEFAULTS[key];
  }

  const layout = draftTokens.kpiWidth?.layout ?? "equal";
  const groupWidth = draftTokens.kpiWidth?.groupWidth ?? KPI_WIDTH_BOUNDS.min;
  const density: TableDensity = draftTokens.tableDensity ?? "standard";
  const sectionGap = draftTokens.sectionGap ?? SECTION_GAP_DEFAULT;
  const panelWidth = draftTokens.panelWidth ?? panelDefault;
  const tableCellPx = draftTokens.tableCellPx ?? tableCellPxDefault;
  const tableFontSize = draftTokens.tableFontSize ?? TABLE_FONT_SIZE_DEFAULT;
  const tableHeaderFontSize = draftTokens.tableHeaderFontSize ?? TABLE_HEADER_FONT_SIZE_DEFAULT;
  const internalLayout = draftTokens.kpiInternalLayout ?? "current";

  function cardWidthValue(index: number): number {
    const override = draftTokens.kpiWidth?.cardWidths?.[index];
    if (override === "auto") return 0;
    if (typeof override === "number") return override;
    return 0;
  }

  function setRegion(key: RegionTokenKey, value: number) {
    design.setRegionToken(selected.id, key, value);
  }

  const showKpi = selected.kind === "kpi";
  const showTable = selected.kind === "table";
  const showPanel = selected.kind === "panel";
  const showTabs = selected.kind === "tabs";
  const showPage = selected.kind === "page";
  const showWidth = Boolean(selected.hasWidth) && (PAGE_HAS_PANEL[pageKey] || selected.hasWidth);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-sm">
        <SheetHeader>
          <SheetTitle>Founder Design Mode</SheetTitle>
          <SheetDescription>
            Visual sizing/density for {pageLabel}. Only affects your own founder account.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4">
          <div className="border-b border-border/60 pb-3">
            <label htmlFor="founder-editing-region" className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Editing
            </label>
            <select
              id="founder-editing-region"
              value={selected.id}
              onChange={(event) => setSelectedRegionId(event.target.value)}
              className="mt-1.5 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              {regions.map((region) => (
                <option key={region.id} value={region.id}>
                  {region.label}
                </option>
              ))}
            </select>
          </div>

          {showKpi ? (
            <>
              <CollapsibleSection
                title="Size & Padding"
                defaultOpen
                onReset={() =>
                  founderDesign.resetFields(["kpi.minHeight", "kpi.padding", "kpi.paddingY", "kpi.paddingX"])
                }
              >
                <Stepper
                  label={KPI_TOKEN_LABELS.minHeight}
                  value={kpiValue("minHeight")}
                  min={KPI_TOKEN_BOUNDS.minHeight.min}
                  max={KPI_TOKEN_BOUNDS.minHeight.max}
                  step={KPI_TOKEN_BOUNDS.minHeight.step}
                  onChange={(value) => founderDesign.setKpiToken("minHeight", value)}
                  onReset={() => founderDesign.resetFields(["kpi.minHeight"])}
                />
                <p className="text-xs text-muted-foreground">
                  0px means no minimum — cards use natural height and grow with content.
                </p>
                <Stepper
                  label={KPI_TOKEN_LABELS.paddingY}
                  value={kpiValue("paddingY")}
                  min={KPI_TOKEN_BOUNDS.paddingY.min}
                  max={KPI_TOKEN_BOUNDS.paddingY.max}
                  step={KPI_TOKEN_BOUNDS.paddingY.step}
                  onChange={(value) => founderDesign.setKpiToken("paddingY", value)}
                  onReset={() => founderDesign.resetFields(["kpi.paddingY", "kpi.padding"])}
                />
                <Stepper
                  label={KPI_TOKEN_LABELS.paddingX}
                  value={kpiValue("paddingX")}
                  min={KPI_TOKEN_BOUNDS.paddingX.min}
                  max={KPI_TOKEN_BOUNDS.paddingX.max}
                  step={KPI_TOKEN_BOUNDS.paddingX.step}
                  onChange={(value) => founderDesign.setKpiToken("paddingX", value)}
                  onReset={() => founderDesign.resetFields(["kpi.paddingX"])}
                />
              </CollapsibleSection>

              <CollapsibleSection
                title="Internal Spacing"
                onReset={() => founderDesign.resetFields(["kpi.internalGap", "kpi.gap", "kpi.lineHeight"])}
              >
                <Stepper
                  label={KPI_TOKEN_LABELS.internalGap}
                  value={kpiValue("internalGap")}
                  min={KPI_TOKEN_BOUNDS.internalGap.min}
                  max={KPI_TOKEN_BOUNDS.internalGap.max}
                  step={KPI_TOKEN_BOUNDS.internalGap.step}
                  onChange={(value) => founderDesign.setKpiToken("internalGap", value)}
                  onReset={() => founderDesign.resetFields(["kpi.internalGap"])}
                />
                <Stepper
                  label={KPI_TOKEN_LABELS.gap}
                  value={kpiValue("gap")}
                  min={KPI_TOKEN_BOUNDS.gap.min}
                  max={KPI_TOKEN_BOUNDS.gap.max}
                  step={KPI_TOKEN_BOUNDS.gap.step}
                  onChange={(value) => founderDesign.setKpiToken("gap", value)}
                  onReset={() => founderDesign.resetFields(["kpi.gap"])}
                />
                <Stepper
                  label={KPI_TOKEN_LABELS.lineHeight}
                  value={kpiValue("lineHeight")}
                  min={KPI_TOKEN_BOUNDS.lineHeight.min}
                  max={KPI_TOKEN_BOUNDS.lineHeight.max}
                  step={KPI_TOKEN_BOUNDS.lineHeight.step}
                  onChange={(value) => founderDesign.setKpiToken("lineHeight", value)}
                  onReset={() => founderDesign.resetFields(["kpi.lineHeight"])}
                  format={(value) => (value / 100).toFixed(2)}
                  unit=""
                />
              </CollapsibleSection>

              <CollapsibleSection
                title="Text"
                onReset={() =>
                  founderDesign.resetFields([
                    "kpi.labelFontSize",
                    "kpi.numberFontSize",
                    "kpi.supportingFontSize",
                    ...(selected.hasTitle ? [`regions.${selected.id}.titleSize`] : []),
                  ])
                }
              >
                {selected.hasTitle ? (
                  <Stepper
                    label={REGION_TOKEN_LABELS.titleSize}
                    value={regionValue("titleSize")}
                    min={REGION_TOKEN_BOUNDS.titleSize.min}
                    max={REGION_TOKEN_BOUNDS.titleSize.max}
                    step={REGION_TOKEN_BOUNDS.titleSize.step}
                    onChange={(value) => setRegion("titleSize", value)}
                    onReset={() => founderDesign.resetFields([`regions.${selected.id}.titleSize`])}
                  />
                ) : null}
                {(["labelFontSize", "numberFontSize", "supportingFontSize"] as const).map((key) => (
                  <Stepper
                    key={key}
                    label={KPI_TOKEN_LABELS[key]}
                    value={kpiValue(key)}
                    min={KPI_TOKEN_BOUNDS[key].min}
                    max={KPI_TOKEN_BOUNDS[key].max}
                    step={KPI_TOKEN_BOUNDS[key].step}
                    onChange={(value) => founderDesign.setKpiToken(key, value)}
                    onReset={() => founderDesign.resetFields([`kpi.${key}`])}
                  />
                ))}
              </CollapsibleSection>

              <CollapsibleSection
                title="Icon"
                onReset={() => founderDesign.resetFields(["kpi.iconSize", "kpiAppearance"])}
              >
                <Stepper
                  label={KPI_TOKEN_LABELS.iconSize}
                  value={kpiValue("iconSize")}
                  min={KPI_TOKEN_BOUNDS.iconSize.min}
                  max={KPI_TOKEN_BOUNDS.iconSize.max}
                  step={KPI_TOKEN_BOUNDS.iconSize.step}
                  onChange={(value) => founderDesign.setKpiToken("iconSize", value)}
                  onReset={() => founderDesign.resetFields(["kpi.iconSize"])}
                />
                {kpiCardLabels.map((label, index) => (
                  <div
                    key={`${label}-${index}`}
                    onMouseEnter={() => founderDesign.setHoveredCardIndex(index)}
                    onMouseLeave={() => founderDesign.setHoveredCardIndex(null)}
                    className={cn(
                      "space-y-1.5 rounded-md px-1.5 py-1",
                      founderDesign.hoveredCardIndex === index && "bg-primary/10",
                    )}
                  >
                    <p className="text-xs font-medium text-muted-foreground">{label}</p>
                    <NativeSelect
                      label="Icon"
                      value={draftTokens.kpiAppearance?.[index]?.icon ?? ""}
                      onChange={(value) =>
                        founderDesign.setKpiAppearance(index, { icon: value ? (value as never) : undefined })
                      }
                      onReset={() => founderDesign.resetFields([`kpiAppearance.${index}.icon`])}
                    >
                      <option value="">Current (default)</option>
                      {CURATED_ICON_IDS.map((id) => (
                        <option key={id} value={id}>
                          {CURATED_ICON_LABELS[id]}
                        </option>
                      ))}
                    </NativeSelect>
                    <NativeSelect
                      label="Icon color"
                      value={draftTokens.kpiAppearance?.[index]?.iconColor ?? "default"}
                      onChange={(value) => founderDesign.setKpiAppearance(index, { iconColor: value as never })}
                      onReset={() => founderDesign.resetFields([`kpiAppearance.${index}.iconColor`])}
                    >
                      {ICON_COLORS.map((color) => (
                        <option key={color} value={color}>
                          {ICON_COLOR_LABELS[color]}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                ))}
              </CollapsibleSection>

              <CollapsibleSection title="Layout" onReset={() => founderDesign.resetFields(["kpiWidth", "kpiInternalLayout"])}>
                <p className="text-xs font-medium text-muted-foreground">KPI Internal Layout</p>
                <div className="flex gap-1.5 rounded-lg border border-border/70 p-1">
                  {(["current", "aligned"] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => founderDesign.setKpiInternalLayout(option)}
                      className={cn(
                        "flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                        internalLayout === option
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      )}
                    >
                      {option === "current" ? "Current" : "Compact / Aligned"}
                    </button>
                  ))}
                </div>

                <p className="pt-1 text-xs font-medium text-muted-foreground">Card Width</p>
                <div className="flex gap-1.5 rounded-lg border border-border/70 p-1">
                  {(["equal", "custom"] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => founderDesign.setKpiLayout(option)}
                      className={cn(
                        "flex-1 rounded-md px-2 py-1.5 text-xs font-medium capitalize transition-colors",
                        layout === option
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      )}
                    >
                      {option === "equal" ? "Equal Width" : "Custom Widths"}
                    </button>
                  ))}
                </div>

                {layout === "custom" ? (
                  <>
                    <div className="space-y-1.5 rounded-lg bg-muted/30 p-2.5">
                      <p className="text-xs font-medium text-muted-foreground">
                        Group width (default for any card below without its own override)
                      </p>
                      <Stepper
                        label="Group Width"
                        value={groupWidth}
                        min={KPI_WIDTH_BOUNDS.min}
                        max={KPI_WIDTH_BOUNDS.max}
                        step={KPI_WIDTH_BOUNDS.step}
                        onChange={founderDesign.setKpiGroupWidth}
                        onReset={() => founderDesign.resetFields(["kpiWidth.groupWidth"])}
                      />
                    </div>
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">
                        Individual cards (overrides the group width above; “Auto” stays flexible)
                      </p>
                      {kpiCardLabels.map((label, index) => (
                        <div
                          key={`${label}-${index}`}
                          onMouseEnter={() => founderDesign.setHoveredCardIndex(index)}
                          onMouseLeave={() => founderDesign.setHoveredCardIndex(null)}
                          className={cn(
                            "rounded-md px-1.5 py-0.5 transition-colors",
                            founderDesign.hoveredCardIndex === index && "bg-primary/10",
                          )}
                        >
                          <CardWidthStepper
                            label={label}
                            value={cardWidthValue(index)}
                            onChange={(value) => founderDesign.setKpiCardWidth(index, value === 0 ? "auto" : value)}
                            onReset={() => founderDesign.resetFields([`kpiWidth.cardWidths.${index}`])}
                          />
                        </div>
                      ))}
                    </div>
                  </>
                ) : null}
              </CollapsibleSection>
            </>
          ) : null}

          {showPanel || showTabs ? (
            <>
              <CollapsibleSection
                title="Size & Padding"
                defaultOpen
                onReset={() =>
                  founderDesign.resetFields([
                    `regions.${selected.id}.minHeight`,
                    `regions.${selected.id}.paddingY`,
                    `regions.${selected.id}.paddingX`,
                    `regions.${selected.id}.gap`,
                  ])
                }
              >
                <Stepper
                  label={REGION_TOKEN_LABELS.minHeight}
                  value={regionValue("minHeight")}
                  min={REGION_TOKEN_BOUNDS.minHeight.min}
                  max={REGION_TOKEN_BOUNDS.minHeight.max}
                  step={REGION_TOKEN_BOUNDS.minHeight.step}
                  onChange={(value) => setRegion("minHeight", value)}
                  onReset={() => founderDesign.resetFields([`regions.${selected.id}.minHeight`])}
                />
                <p className="text-xs text-muted-foreground">
                  0px means natural height — the box stays compact and still grows when content needs room.
                </p>
                <Stepper
                  label={REGION_TOKEN_LABELS.paddingY}
                  value={regionValue("paddingY")}
                  min={REGION_TOKEN_BOUNDS.paddingY.min}
                  max={REGION_TOKEN_BOUNDS.paddingY.max}
                  step={REGION_TOKEN_BOUNDS.paddingY.step}
                  onChange={(value) => setRegion("paddingY", value)}
                  onReset={() => founderDesign.resetFields([`regions.${selected.id}.paddingY`])}
                />
                <Stepper
                  label={REGION_TOKEN_LABELS.paddingX}
                  value={regionValue("paddingX")}
                  min={REGION_TOKEN_BOUNDS.paddingX.min}
                  max={REGION_TOKEN_BOUNDS.paddingX.max}
                  step={REGION_TOKEN_BOUNDS.paddingX.step}
                  onChange={(value) => setRegion("paddingX", value)}
                  onReset={() => founderDesign.resetFields([`regions.${selected.id}.paddingX`])}
                />
                <Stepper
                  label={REGION_TOKEN_LABELS.gap}
                  value={regionValue("gap")}
                  min={REGION_TOKEN_BOUNDS.gap.min}
                  max={REGION_TOKEN_BOUNDS.gap.max}
                  step={REGION_TOKEN_BOUNDS.gap.step}
                  onChange={(value) => setRegion("gap", value)}
                  onReset={() => founderDesign.resetFields([`regions.${selected.id}.gap`])}
                />
              </CollapsibleSection>

              {selected.hasTitle || selected.hasBody ? (
                <CollapsibleSection
                  title="Text"
                  onReset={() =>
                    founderDesign.resetFields([
                      `regions.${selected.id}.titleSize`,
                      `regions.${selected.id}.bodySize`,
                      `regions.${selected.id}.lineHeight`,
                      `regions.${selected.id}.buttonTextSize`,
                    ])
                  }
                >
                  {selected.hasTitle ? (
                    <Stepper
                      label={REGION_TOKEN_LABELS.titleSize}
                      value={regionValue("titleSize")}
                      min={REGION_TOKEN_BOUNDS.titleSize.min}
                      max={REGION_TOKEN_BOUNDS.titleSize.max}
                      step={REGION_TOKEN_BOUNDS.titleSize.step}
                      onChange={(value) => setRegion("titleSize", value)}
                      onReset={() => founderDesign.resetFields([`regions.${selected.id}.titleSize`])}
                    />
                  ) : null}
                  {selected.hasBody ? (
                    <Stepper
                      label={REGION_TOKEN_LABELS.bodySize}
                      value={regionValue("bodySize")}
                      min={REGION_TOKEN_BOUNDS.bodySize.min}
                      max={REGION_TOKEN_BOUNDS.bodySize.max}
                      step={REGION_TOKEN_BOUNDS.bodySize.step}
                      onChange={(value) => setRegion("bodySize", value)}
                      onReset={() => founderDesign.resetFields([`regions.${selected.id}.bodySize`])}
                    />
                  ) : null}
                  <Stepper
                    label={REGION_TOKEN_LABELS.lineHeight}
                    value={regionValue("lineHeight")}
                    min={REGION_TOKEN_BOUNDS.lineHeight.min}
                    max={REGION_TOKEN_BOUNDS.lineHeight.max}
                    step={REGION_TOKEN_BOUNDS.lineHeight.step}
                    onChange={(value) => setRegion("lineHeight", value)}
                    onReset={() => founderDesign.resetFields([`regions.${selected.id}.lineHeight`])}
                    format={(value) => (value / 100).toFixed(2)}
                    unit=""
                  />
                  {selected.hasButtons ? (
                    <Stepper
                      label={REGION_TOKEN_LABELS.buttonTextSize}
                      value={regionValue("buttonTextSize")}
                      min={REGION_TOKEN_BOUNDS.buttonTextSize.min}
                      max={REGION_TOKEN_BOUNDS.buttonTextSize.max}
                      step={REGION_TOKEN_BOUNDS.buttonTextSize.step}
                      onChange={(value) => setRegion("buttonTextSize", value)}
                      onReset={() => founderDesign.resetFields([`regions.${selected.id}.buttonTextSize`])}
                    />
                  ) : null}
                </CollapsibleSection>
              ) : null}

              {selected.hasIcon ? (
                <CollapsibleSection
                  title="Icon"
                  onReset={() =>
                    founderDesign.resetFields([
                      `regions.${selected.id}.titleIconSize`,
                      `regions.${selected.id}.icon`,
                      `regions.${selected.id}.iconColor`,
                    ])
                  }
                >
                  <Stepper
                    label={REGION_TOKEN_LABELS.titleIconSize}
                    value={regionValue("titleIconSize")}
                    min={REGION_TOKEN_BOUNDS.titleIconSize.min}
                    max={REGION_TOKEN_BOUNDS.titleIconSize.max}
                    step={REGION_TOKEN_BOUNDS.titleIconSize.step}
                    onChange={(value) => setRegion("titleIconSize", value)}
                    onReset={() => founderDesign.resetFields([`regions.${selected.id}.titleIconSize`])}
                  />
                  <NativeSelect
                    label="Current Icon"
                    value={draftTokens.regions?.[selected.id]?.icon ?? selected.defaultIcon ?? ""}
                    onChange={(value) => founderDesign.setRegionAppearance(selected.id, { icon: value as never })}
                    onReset={() => founderDesign.resetFields([`regions.${selected.id}.icon`])}
                  >
                    {CURATED_ICON_IDS.map((id) => (
                      <option key={id} value={id}>
                        {CURATED_ICON_LABELS[id]}
                      </option>
                    ))}
                  </NativeSelect>
                  <NativeSelect
                    label="Icon color"
                    value={draftTokens.regions?.[selected.id]?.iconColor ?? "default"}
                    onChange={(value) => founderDesign.setRegionAppearance(selected.id, { iconColor: value as never })}
                    onReset={() => founderDesign.resetFields([`regions.${selected.id}.iconColor`])}
                  >
                    {ICON_COLORS.map((color) => (
                      <option key={color} value={color}>
                        {ICON_COLOR_LABELS[color]}
                      </option>
                    ))}
                  </NativeSelect>
                </CollapsibleSection>
              ) : null}
            </>
          ) : null}

          {showTable ? (
            <CollapsibleSection
              title="Table"
              defaultOpen
              onReset={() =>
                founderDesign.resetFields(["tableDensity", "tableCellPx", "tableFontSize", "tableHeaderFontSize"])
              }
            >
              <p className="text-sm text-foreground">Row Density</p>
              <div className="flex gap-1.5 rounded-lg border border-border/70 p-1">
                {TABLE_DENSITIES.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => founderDesign.setTableDensity(option)}
                    className={cn(
                      "flex-1 rounded-md px-2 py-1.5 text-xs font-medium capitalize transition-colors",
                      density === option
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    {option}
                  </button>
                ))}
              </div>
              <Stepper
                label="Cell Horizontal Padding"
                value={tableCellPx}
                min={TABLE_CELL_PX_BOUNDS.min}
                max={TABLE_CELL_PX_BOUNDS.max}
                step={TABLE_CELL_PX_BOUNDS.step}
                onChange={founderDesign.setTableCellPx}
                onReset={() => founderDesign.resetFields(["tableCellPx"])}
              />
              <Stepper
                label="Table Text Size"
                value={tableFontSize}
                min={TABLE_FONT_SIZE_BOUNDS.min}
                max={TABLE_FONT_SIZE_BOUNDS.max}
                step={TABLE_FONT_SIZE_BOUNDS.step}
                onChange={founderDesign.setTableFontSize}
                onReset={() => founderDesign.resetFields(["tableFontSize"])}
              />
              <Stepper
                label="Header Text Size"
                value={tableHeaderFontSize}
                min={TABLE_HEADER_FONT_SIZE_BOUNDS.min}
                max={TABLE_HEADER_FONT_SIZE_BOUNDS.max}
                step={TABLE_HEADER_FONT_SIZE_BOUNDS.step}
                onChange={founderDesign.setTableHeaderFontSize}
                onReset={() => founderDesign.resetFields(["tableHeaderFontSize"])}
              />
            </CollapsibleSection>
          ) : null}

          {showPage || showWidth ? (
            <CollapsibleSection
              title={showWidth && !showPage ? "Details Panel" : "Page Spacing"}
              defaultOpen
              onReset={() =>
                founderDesign.resetFields(showWidth ? ["sectionGap", "panelWidth"] : ["sectionGap"])
              }
            >
              {showPage ? (
                <Stepper
                  label="Section Gap"
                  value={sectionGap}
                  min={SECTION_GAP_BOUNDS.min}
                  max={SECTION_GAP_BOUNDS.max}
                  step={SECTION_GAP_BOUNDS.step}
                  onChange={founderDesign.setSectionGap}
                  onReset={() => founderDesign.resetFields(["sectionGap"])}
                />
              ) : null}
              {showWidth ? (
                <>
                  <Stepper
                    label="Panel Width"
                    value={panelWidth}
                    min={PANEL_WIDTH_BOUNDS.min}
                    max={PANEL_WIDTH_BOUNDS.max}
                    step={PANEL_WIDTH_BOUNDS.step}
                    onChange={founderDesign.setPanelWidth}
                    onReset={() => founderDesign.resetFields(["panelWidth"])}
                  />
                  <p className="text-xs text-muted-foreground">Desktop only — mobile always uses its own stacked layout.</p>
                </>
              ) : null}
            </CollapsibleSection>
          ) : null}
        </div>

        <SheetFooter className="flex-col gap-2 border-t border-border/60">
          {confirmResetPage ? (
            <div className="w-full space-y-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3">
              <p className="text-sm text-foreground">Restore {pageLabel} to its approved default design?</p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={saving}
                  onClick={async () => {
                    await founderDesign.resetPage();
                    setConfirmResetPage(false);
                  }}
                >
                  Reset Page
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setConfirmResetPage(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex w-full flex-wrap items-center gap-2">
              <Button type="button" disabled={!isDirty || saving} onClick={() => founderDesign.save()}>
                {saving ? "Saving…" : "Save Changes"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!isDirty || saving}
                onClick={() => founderDesign.discard()}
              >
                Cancel / Discard
              </Button>
              {isDirty ? (
                <span className="flex size-2 shrink-0 rounded-full bg-amber-400" aria-label="Unsaved changes" />
              ) : null}
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                className="ml-auto text-destructive hover:text-destructive"
                onClick={() => setConfirmResetPage(true)}
              >
                Reset Page
              </Button>
            </div>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

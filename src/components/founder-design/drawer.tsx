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
  PAGE_HAS_TABLE,
  PANEL_WIDTH_BOUNDS,
  PANEL_WIDTH_DEFAULTS,
  SECTION_GAP_BOUNDS,
  SECTION_GAP_DEFAULT,
  TABLE_CELL_PX_BOUNDS,
  TABLE_CELL_PX_DEFAULTS,
  TABLE_DENSITIES,
  TABLE_FONT_SIZE_BOUNDS,
  TABLE_FONT_SIZE_DEFAULT,
  TABLE_HEADER_FONT_SIZE_BOUNDS,
  TABLE_HEADER_FONT_SIZE_DEFAULT,
  type KpiTokenKey,
  type TableDensity,
} from "@/lib/founder-design";
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
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  onReset?: () => void;
  unit?: string;
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
          {value}
          {unit}
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

/** Card-width stepper with an "Auto" state below the minimum (0 = Auto = stays flexible/fills remaining space). */
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

export function FounderDesignDrawer() {
  const founderDesign = useFounderDesign();
  const [confirmResetPage, setConfirmResetPage] = useState(false);

  if (!founderDesign) return null;

  const { pageKey, draftTokens, kpiCardLabels, isDirty, open, setOpen, saving } = founderDesign;
  const pageLabel = FOUNDER_PAGE_LABELS[pageKey];
  const kpiDefaults = KPI_DEFAULTS[pageKey];
  const hasTable = PAGE_HAS_TABLE[pageKey];
  const hasPanel = PAGE_HAS_PANEL[pageKey];
  const panelDefault = PANEL_WIDTH_DEFAULTS[pageKey] ?? PANEL_WIDTH_BOUNDS.min;
  const tableCellPxDefault = TABLE_CELL_PX_DEFAULTS[pageKey];

  function kpiValue(key: KpiTokenKey) {
    return draftTokens.kpi?.[key] ?? kpiDefaults[key];
  }

  const layout = draftTokens.kpiWidth?.layout ?? "equal";
  const groupWidth = draftTokens.kpiWidth?.groupWidth ?? KPI_WIDTH_BOUNDS.min;
  const density: TableDensity = draftTokens.tableDensity ?? "standard";
  const sectionGap = draftTokens.sectionGap ?? SECTION_GAP_DEFAULT;
  const panelWidth = draftTokens.panelWidth ?? panelDefault;
  const tableCellPx = draftTokens.tableCellPx ?? tableCellPxDefault;
  const tableFontSize = draftTokens.tableFontSize ?? TABLE_FONT_SIZE_DEFAULT;
  const tableHeaderFontSize = draftTokens.tableHeaderFontSize ?? TABLE_HEADER_FONT_SIZE_DEFAULT;

  function cardWidthValue(index: number): number {
    const override = draftTokens.kpiWidth?.cardWidths?.[index];
    if (override === "auto") return 0;
    if (typeof override === "number") return override;
    return 0;
  }

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
          <CollapsibleSection
            title="KPI Width / Layout"
            defaultOpen
            onReset={() => founderDesign.resetFields(["kpiWidth"])}
          >
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
                  <p className="text-xs font-medium text-muted-foreground">Group width (default for any card below without its own override)</p>
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
                  <p className="text-xs font-medium text-muted-foreground">Individual cards (overrides the group width above; &ldquo;Auto&rdquo; stays flexible/fills remaining space)</p>
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

          <CollapsibleSection
            title="Card Height & Padding"
            onReset={() => founderDesign.resetFields(["kpi.minHeight", "kpi.padding"])}
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
            <p className="text-xs text-muted-foreground">0px means &ldquo;no minimum -- natural height&rdquo; (today&apos;s behavior).</p>
            <Stepper
              label={KPI_TOKEN_LABELS.padding}
              value={kpiValue("padding")}
              min={KPI_TOKEN_BOUNDS.padding.min}
              max={KPI_TOKEN_BOUNDS.padding.max}
              step={KPI_TOKEN_BOUNDS.padding.step}
              onChange={(value) => founderDesign.setKpiToken("padding", value)}
              onReset={() => founderDesign.resetFields(["kpi.padding"])}
            />
          </CollapsibleSection>

          <CollapsibleSection
            title="Icon & Text Sizes"
            onReset={() =>
              founderDesign.resetFields(["kpi.iconSize", "kpi.labelFontSize", "kpi.numberFontSize", "kpi.supportingFontSize"])
            }
          >
            {(["iconSize", "labelFontSize", "numberFontSize", "supportingFontSize"] as const).map((key) => (
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

          <CollapsibleSection title="Card Gap / Spacing" onReset={() => founderDesign.resetFields(["kpi.gap"])}>
            <Stepper
              label={KPI_TOKEN_LABELS.gap}
              value={kpiValue("gap")}
              min={KPI_TOKEN_BOUNDS.gap.min}
              max={KPI_TOKEN_BOUNDS.gap.max}
              step={KPI_TOKEN_BOUNDS.gap.step}
              onChange={(value) => founderDesign.setKpiToken("gap", value)}
              onReset={() => founderDesign.resetFields(["kpi.gap"])}
            />
          </CollapsibleSection>

          {hasTable ? (
            <CollapsibleSection
              title="Table"
              onReset={() => founderDesign.resetFields(["tableDensity", "tableCellPx", "tableFontSize", "tableHeaderFontSize"])}
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

          {hasPanel ? (
            <CollapsibleSection title="Details Panel" onReset={() => founderDesign.resetFields(["panelWidth"])}>
              <Stepper
                label="Panel Width"
                value={panelWidth}
                min={PANEL_WIDTH_BOUNDS.min}
                max={PANEL_WIDTH_BOUNDS.max}
                step={PANEL_WIDTH_BOUNDS.step}
                onChange={founderDesign.setPanelWidth}
                onReset={() => founderDesign.resetFields(["panelWidth"])}
              />
              <p className="text-xs text-muted-foreground">Desktop only -- mobile always uses its own stacked layout.</p>
            </CollapsibleSection>
          ) : null}

          <CollapsibleSection title="Page Spacing" onReset={() => founderDesign.resetFields(["sectionGap"])}>
            <Stepper
              label="Section Gap"
              value={sectionGap}
              min={SECTION_GAP_BOUNDS.min}
              max={SECTION_GAP_BOUNDS.max}
              step={SECTION_GAP_BOUNDS.step}
              onChange={founderDesign.setSectionGap}
              onReset={() => founderDesign.resetFields(["sectionGap"])}
            />
          </CollapsibleSection>
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

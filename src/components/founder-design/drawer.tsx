"use client";

import { useState } from "react";
import { Minus, Plus, RotateCcw } from "lucide-react";
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
  KPI_TOKEN_KEYS,
  KPI_TOKEN_LABELS,
  PAGE_HAS_PANEL,
  PAGE_HAS_TABLE,
  PANEL_WIDTH_BOUNDS,
  PANEL_WIDTH_DEFAULTS,
  SECTION_GAP_BOUNDS,
  SECTION_GAP_DEFAULT,
  TABLE_DENSITIES,
  type KpiTokenKey,
  type TableDensity,
} from "@/lib/founder-design";
import { cn } from "@/lib/utils";

function Stepper({
  label,
  value,
  min,
  max,
  step,
  onChange,
  unit = "px",
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  unit?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="text-sm text-foreground">{label}</p>
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
      </div>
    </div>
  );
}

function SectionHeader({
  title,
  onReset,
}: {
  title: string;
  onReset: () => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</p>
      <Button type="button" size="sm" variant="ghost" onClick={onReset} className="h-7 gap-1 text-xs">
        <RotateCcw className="size-3" />
        Reset
      </Button>
    </div>
  );
}

export function FounderDesignDrawer() {
  const founderDesign = useFounderDesign();
  const [confirmResetPage, setConfirmResetPage] = useState(false);

  if (!founderDesign) return null;

  const { pageKey, draftTokens, isDirty, open, setOpen, saving } = founderDesign;
  const pageLabel = FOUNDER_PAGE_LABELS[pageKey];
  const kpiDefaults = KPI_DEFAULTS[pageKey];
  const hasTable = PAGE_HAS_TABLE[pageKey];
  const hasPanel = PAGE_HAS_PANEL[pageKey];
  const panelDefault = PANEL_WIDTH_DEFAULTS[pageKey] ?? PANEL_WIDTH_BOUNDS.min;

  function kpiValue(key: KpiTokenKey) {
    return draftTokens.kpi?.[key] ?? kpiDefaults[key];
  }

  const density: TableDensity = draftTokens.tableDensity ?? "standard";
  const sectionGap = draftTokens.sectionGap ?? SECTION_GAP_DEFAULT;
  const panelWidth = draftTokens.panelWidth ?? panelDefault;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-sm">
        <SheetHeader>
          <SheetTitle>Founder Design Mode</SheetTitle>
          <SheetDescription>
            Cosmetic-only tuning for {pageLabel}. Changes preview live on this page and only affect your
            own founder account -- never subscribers.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-6 overflow-y-auto px-4 py-2">
          <div className="space-y-3">
            <SectionHeader title="KPI Cards" onReset={() => founderDesign.resetSection("kpi")} />
            {KPI_TOKEN_KEYS.map((key) => {
              const bounds = KPI_TOKEN_BOUNDS[key];
              return (
                <Stepper
                  key={key}
                  label={KPI_TOKEN_LABELS[key]}
                  value={kpiValue(key)}
                  min={bounds.min}
                  max={bounds.max}
                  step={bounds.step}
                  onChange={(value) => founderDesign.setKpiToken(key, value)}
                  unit={key.includes("Font") ? "px" : "px"}
                />
              );
            })}
            <p className="text-xs text-muted-foreground">
              Card Height 0px means &ldquo;no minimum -- natural height&rdquo; (today&apos;s behavior).
            </p>
          </div>

          {hasTable ? (
            <div className="space-y-3 border-t border-border/60 pt-5">
              <SectionHeader title="Table" onReset={() => founderDesign.resetSection("tableDensity")} />
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
            </div>
          ) : null}

          <div className="space-y-3 border-t border-border/60 pt-5">
            <SectionHeader title="Page Spacing" onReset={() => founderDesign.resetSection("sectionGap")} />
            <Stepper
              label="Section Gap"
              value={sectionGap}
              min={SECTION_GAP_BOUNDS.min}
              max={SECTION_GAP_BOUNDS.max}
              step={SECTION_GAP_BOUNDS.step}
              onChange={founderDesign.setSectionGap}
            />
          </div>

          {hasPanel ? (
            <div className="space-y-3 border-t border-border/60 pt-5">
              <SectionHeader title="Details Panel" onReset={() => founderDesign.resetSection("panelWidth")} />
              <Stepper
                label="Panel Width"
                value={panelWidth}
                min={PANEL_WIDTH_BOUNDS.min}
                max={PANEL_WIDTH_BOUNDS.max}
                step={PANEL_WIDTH_BOUNDS.step}
                onChange={founderDesign.setPanelWidth}
              />
              <p className="text-xs text-muted-foreground">Desktop only -- mobile always uses its own stacked layout.</p>
            </div>
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
            <div className="flex w-full flex-wrap gap-2">
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

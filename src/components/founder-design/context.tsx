"use client";

import { createContext, useContext } from "react";
import type {
  FounderPageKey,
  FounderPageTokens,
  KpiAppearanceTokens,
  KpiCardWidthValue,
  KpiInternalLayout,
  KpiLayout,
  KpiTokenKey,
  RegionTokenKey,
  TableDensity,
} from "@/lib/founder-design";

export type FounderDesignContextValue = {
  pageKey: FounderPageKey;
  /** Real KPI card labels for this page, in order (e.g. ["Total Invoices", ..., "Total Revenue"]) -- never fabricated, always that page's actual kpis array. */
  kpiCardLabels: string[];
  /** Last known persisted-on-the-server values (what Discard reverts to, what a refresh shows). */
  savedTokens: FounderPageTokens;
  /** In-memory, unsaved values currently being previewed. */
  draftTokens: FounderPageTokens;
  isDirty: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Which KPI card (by index) is currently highlighted on the real page because its drawer row is hovered/focused -- purely visual, never persisted. */
  hoveredCardIndex: number | null;
  setHoveredCardIndex: (index: number | null) => void;
  /** Which visual region the drawer is currently editing. Changing this never saves. */
  selectedRegionId: string;
  setSelectedRegionId: (id: string) => void;

  setKpiToken: (key: KpiTokenKey, value: number) => void;
  setKpiLayout: (layout: KpiLayout) => void;
  setKpiGroupWidth: (value: number) => void;
  setKpiCardWidth: (index: number, value: KpiCardWidthValue) => void;
  setKpiInternalLayout: (layout: KpiInternalLayout) => void;
  setKpiAppearance: (index: number, patch: KpiAppearanceTokens) => void;
  setRegionToken: (regionId: string, key: RegionTokenKey, value: number) => void;
  setRegionAppearance: (regionId: string, patch: Pick<KpiAppearanceTokens, "icon" | "iconColor">) => void;

  setTableDensity: (density: TableDensity) => void;
  setTableCellPx: (value: number) => void;
  setTableFontSize: (value: number) => void;
  setTableHeaderFontSize: (value: number) => void;

  setSectionGap: (value: number) => void;
  setPanelWidth: (value: number) => void;

  save: () => Promise<void>;
  discard: () => void;
  /** Clears one or more specific field paths (e.g. ["kpi.minHeight","kpi.padding"], or ["kpiWidth.cardWidths.2"] for a single card's per-control reset) and persists that immediately. */
  resetFields: (fieldPaths: string[]) => Promise<void>;
  resetPage: () => Promise<void>;
  saving: boolean;
};

export const FounderDesignContext = createContext<FounderDesignContextValue | null>(null);

/** Safe to call from anywhere -- returns null when Founder Design Mode isn't active on this page (including for every non-founder). */
export function useFounderDesign() {
  return useContext(FounderDesignContext);
}

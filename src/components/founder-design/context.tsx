"use client";

import { createContext, useContext } from "react";
import type {
  FounderPageKey,
  FounderPageTokens,
  KpiTokenKey,
  TableDensity,
} from "@/lib/founder-design";

export type FounderDesignContextValue = {
  pageKey: FounderPageKey;
  /** Last known persisted-on-the-server values (what Discard reverts to, what a refresh shows). */
  savedTokens: FounderPageTokens;
  /** In-memory, unsaved values currently being previewed. */
  draftTokens: FounderPageTokens;
  isDirty: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  setKpiToken: (key: KpiTokenKey, value: number) => void;
  setTableDensity: (density: TableDensity) => void;
  setSectionGap: (value: number) => void;
  setPanelWidth: (value: number) => void;
  save: () => Promise<void>;
  discard: () => void;
  resetSection: (section: "kpi" | "tableDensity" | "sectionGap" | "panelWidth") => Promise<void>;
  resetPage: () => Promise<void>;
  saving: boolean;
};

export const FounderDesignContext = createContext<FounderDesignContextValue | null>(null);

/** Safe to call from anywhere -- returns null when Founder Design Mode isn't active on this page (including for every non-founder). */
export function useFounderDesign() {
  return useContext(FounderDesignContext);
}

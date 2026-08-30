"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  resetFounderDesignPage,
  resetFounderDesignSection,
  saveFounderDesignTokens,
} from "@/app/actions/founder-design";
import { FounderDesignDrawer } from "@/components/founder-design/drawer";
import { FounderDesignContext, type FounderDesignContextValue } from "@/components/founder-design/context";
import { FounderDesignTrigger } from "@/components/founder-design/trigger";
import {
  tokensToCssVars,
  type FounderPageKey,
  type FounderPageTokens,
  type KpiAppearanceTokens,
  type KpiCardWidthValue,
  type KpiInternalLayout,
  type KpiLayout,
  type KpiTokenKey,
  type RegionTokenKey,
  type TableDensity,
} from "@/lib/founder-design";
import { defaultFounderRegionId } from "@/lib/founder-regions";

/**
 * The single entry point every one of the 6 approved operating pages
 * renders around its own KPI/table/details-panel content (see
 * src/app/(app)/dashboard/page.tsx etc.). For any non-founder, `isFounder`
 * is false and this renders `children` completely unwrapped -- no extra
 * DOM, no CSS variables, no trigger button, nothing a subscriber could
 * ever observe. Only when the current session's own User.isFounder is
 * true (checked server-side by the caller, see checkFounderAccess() in
 * src/lib/founder-access.ts) does this mount the trigger + drawer + the
 * CSS-variable-applying wrapper.
 */
export function FounderDesignRoot({
  pageKey,
  isFounder,
  savedTokens,
  kpiCardLabels,
  children,
}: {
  pageKey: FounderPageKey;
  isFounder: boolean;
  savedTokens: FounderPageTokens;
  /** That page's real KPI card labels, in order -- see FounderDesignContextValue.kpiCardLabels. */
  kpiCardLabels: string[];
  children: ReactNode;
}) {
  if (!isFounder) {
    return <>{children}</>;
  }
  return (
    <FounderDesignActive pageKey={pageKey} savedTokens={savedTokens} kpiCardLabels={kpiCardLabels}>
      {children}
    </FounderDesignActive>
  );
}

function FounderDesignActive({
  pageKey,
  savedTokens,
  kpiCardLabels,
  children,
}: {
  pageKey: FounderPageKey;
  savedTokens: FounderPageTokens;
  kpiCardLabels: string[];
  children: ReactNode;
}) {
  const [saved, setSaved] = useState<FounderPageTokens>(savedTokens);
  const [draft, setDraft] = useState<FounderPageTokens>(savedTokens);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [hoveredCardIndex, setHoveredCardIndex] = useState<number | null>(null);
  const [selectedRegionId, setSelectedRegionId] = useState<string>(() => defaultFounderRegionId(pageKey));

  const isDirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(saved), [draft, saved]);

  const setKpiToken = useCallback((key: KpiTokenKey, value: number) => {
    setDraft((prev) => ({ ...prev, kpi: { ...prev.kpi, [key]: value } }));
  }, []);

  const setKpiLayout = useCallback((layout: KpiLayout) => {
    setDraft((prev) => ({ ...prev, kpiWidth: { ...prev.kpiWidth, layout } }));
  }, []);
  const setKpiGroupWidth = useCallback((value: number) => {
    setDraft((prev) => ({ ...prev, kpiWidth: { ...prev.kpiWidth, groupWidth: value } }));
  }, []);
  const setKpiCardWidth = useCallback((index: number, value: KpiCardWidthValue) => {
    setDraft((prev) => ({
      ...prev,
      kpiWidth: {
        ...prev.kpiWidth,
        cardWidths: { ...prev.kpiWidth?.cardWidths, [index]: value },
      },
    }));
  }, []);
  const setKpiInternalLayout = useCallback((layout: KpiInternalLayout) => {
    setDraft((prev) => ({ ...prev, kpiInternalLayout: layout }));
  }, []);
  const setKpiAppearance = useCallback((index: number, patch: KpiAppearanceTokens) => {
    setDraft((prev) => {
      const next = { ...prev.kpiAppearance?.[index], ...patch };
      if (!("icon" in patch) || !patch.icon) {
        if ("icon" in patch) delete next.icon;
      }
      return {
        ...prev,
        kpiAppearance: { ...prev.kpiAppearance, [index]: next },
      };
    });
  }, []);
  const setRegionToken = useCallback((regionId: string, key: RegionTokenKey, value: number) => {
    setDraft((prev) => ({
      ...prev,
      regions: {
        ...prev.regions,
        [regionId]: { ...prev.regions?.[regionId], [key]: value },
      },
    }));
  }, []);
  const setRegionAppearance = useCallback((regionId: string, patch: Pick<KpiAppearanceTokens, "icon" | "iconColor">) => {
    setDraft((prev) => ({
      ...prev,
      regions: {
        ...prev.regions,
        [regionId]: { ...prev.regions?.[regionId], ...patch },
      },
    }));
  }, []);

  const setTableDensity = useCallback((density: TableDensity) => {
    setDraft((prev) => ({ ...prev, tableDensity: density }));
  }, []);
  const setTableCellPx = useCallback((value: number) => {
    setDraft((prev) => ({ ...prev, tableCellPx: value }));
  }, []);
  const setTableFontSize = useCallback((value: number) => {
    setDraft((prev) => ({ ...prev, tableFontSize: value }));
  }, []);
  const setTableHeaderFontSize = useCallback((value: number) => {
    setDraft((prev) => ({ ...prev, tableHeaderFontSize: value }));
  }, []);

  const setSectionGap = useCallback((value: number) => {
    setDraft((prev) => ({ ...prev, sectionGap: value }));
  }, []);
  const setPanelWidth = useCallback((value: number) => {
    setDraft((prev) => ({ ...prev, panelWidth: value }));
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const result = await saveFounderDesignTokens(pageKey, draft);
      const next = result.tokens ?? draft;
      setSaved(next);
      setDraft(next);
    } finally {
      setSaving(false);
    }
  }, [pageKey, draft]);

  const discard = useCallback(() => {
    setDraft(saved);
  }, [saved]);

  const resetFields = useCallback(
    async (fieldPaths: string[]) => {
      setSaving(true);
      try {
        // Clears fieldPaths from the CURRENT DRAFT (what the founder is
        // actively previewing), never from whatever was last saved --
        // otherwise resetting one control would silently discard every
        // other unsaved adjustment still on screen.
        const result = await resetFounderDesignSection(pageKey, draft, fieldPaths);
        const next = result.tokens ?? {};
        setSaved(next);
        setDraft(next);
      } finally {
        setSaving(false);
      }
    },
    [pageKey, draft],
  );

  const resetPage = useCallback(async () => {
    setSaving(true);
    try {
      await resetFounderDesignPage(pageKey);
      setSaved({});
      setDraft({});
    } finally {
      setSaving(false);
    }
  }, [pageKey]);

  const value: FounderDesignContextValue = {
    pageKey,
    kpiCardLabels,
    savedTokens: saved,
    draftTokens: draft,
    isDirty,
    open,
    setOpen,
    hoveredCardIndex,
    setHoveredCardIndex,
    selectedRegionId,
    setSelectedRegionId,
    setKpiToken,
    setKpiLayout,
    setKpiGroupWidth,
    setKpiCardWidth,
    setKpiInternalLayout,
    setKpiAppearance,
    setRegionToken,
    setRegionAppearance,
    setTableDensity,
    setTableCellPx,
    setTableFontSize,
    setTableHeaderFontSize,
    setSectionGap,
    setPanelWidth,
    save,
    discard,
    resetFields,
    resetPage,
    saving,
  };

  const cssVars = tokensToCssVars(pageKey, draft);

  return (
    <FounderDesignContext.Provider value={value}>
      {/*
       * Always flex-col + rowGap (never a bare unconditional style
       * object) so the section spacing between children is ALWAYS
       * governed by --tbbt-section-gap with its 1.5rem fallback -- the
       * exact space-y-6 rhythm PageContainer already uses everywhere
       * else -- regardless of whether any OTHER token has been touched
       * yet. Only the KPI/table/panel vars are conditionally present.
       */}
      <div className="flex flex-col" style={{ rowGap: "var(--tbbt-section-gap, 1.5rem)", ...cssVars }}>
        {children}
      </div>
      <FounderDesignTrigger />
      <FounderDesignDrawer />
    </FounderDesignContext.Provider>
  );
}

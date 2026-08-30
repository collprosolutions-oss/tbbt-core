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
  type KpiTokenKey,
  type TableDensity,
} from "@/lib/founder-design";

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
  children,
}: {
  pageKey: FounderPageKey;
  isFounder: boolean;
  savedTokens: FounderPageTokens;
  children: ReactNode;
}) {
  if (!isFounder) {
    return <>{children}</>;
  }
  return (
    <FounderDesignActive pageKey={pageKey} savedTokens={savedTokens}>
      {children}
    </FounderDesignActive>
  );
}

function FounderDesignActive({
  pageKey,
  savedTokens,
  children,
}: {
  pageKey: FounderPageKey;
  savedTokens: FounderPageTokens;
  children: ReactNode;
}) {
  const [saved, setSaved] = useState<FounderPageTokens>(savedTokens);
  const [draft, setDraft] = useState<FounderPageTokens>(savedTokens);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const isDirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(saved), [draft, saved]);

  const setKpiToken = useCallback((key: KpiTokenKey, value: number) => {
    setDraft((prev) => ({ ...prev, kpi: { ...prev.kpi, [key]: value } }));
  }, []);
  const setTableDensity = useCallback((density: TableDensity) => {
    setDraft((prev) => ({ ...prev, tableDensity: density }));
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

  const resetSection = useCallback(
    async (section: "kpi" | "tableDensity" | "sectionGap" | "panelWidth") => {
      setSaving(true);
      try {
        const result = await resetFounderDesignSection(pageKey, section);
        const next = result.tokens ?? {};
        setSaved(next);
        setDraft(next);
      } finally {
        setSaving(false);
      }
    },
    [pageKey],
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
    savedTokens: saved,
    draftTokens: draft,
    isDirty,
    open,
    setOpen,
    setKpiToken,
    setTableDensity,
    setSectionGap,
    setPanelWidth,
    save,
    discard,
    resetSection,
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

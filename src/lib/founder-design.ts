/**
 * Founder Design Mode -- controlled design-token architecture.
 *
 * This module is the single source of truth for:
 *   1. which pages support Founder Design Mode (FOUNDER_PAGE_KEYS),
 *   2. which cosmetic tokens exist and their CSS custom-property names,
 *   3. the safe min/max/step bounds for every numeric token,
 *   4. each page's CURRENT approved default value for every token (the
 *      exact pixel values already hardcoded in that page's JSX today --
 *      see the comments below for where each number comes from),
 *   5. pure helpers to validate/clamp a partial override and turn it into
 *      the inline `style` object a page actually renders.
 *
 * PRESENTATION ONLY: nothing here reads or writes any business record
 * (Customer/Estimate/Job/Invoice/etc.), touches pricing/permissions/
 * workflows, or is scoped to a Business. It only ever produces CSS custom
 * property values (numbers -> "<n>px" strings) for a fixed, known set of
 * layout dimensions. See src/app/actions/founder-design.ts for the
 * persistence layer built on top of this, and
 * src/lib/founder-access.ts for who is allowed to call it.
 */
import type { CSSProperties } from "react";

export const FOUNDER_PAGE_KEYS = [
  "dashboard",
  "requests",
  "customers",
  "estimates",
  "jobs",
  "invoices",
] as const;
export type FounderPageKey = (typeof FOUNDER_PAGE_KEYS)[number];

export function isFounderPageKey(value: string): value is FounderPageKey {
  return (FOUNDER_PAGE_KEYS as readonly string[]).includes(value);
}

export const FOUNDER_PAGE_LABELS: Record<FounderPageKey, string> = {
  dashboard: "Dashboard",
  requests: "Requests",
  customers: "Customers",
  estimates: "Estimates",
  jobs: "Schedule / Jobs",
  invoices: "Invoices",
};

/** Whether a page has the dense table + master-detail panel section at all (Dashboard does not). */
export const PAGE_HAS_TABLE: Record<FounderPageKey, boolean> = {
  dashboard: false,
  requests: true,
  customers: true,
  estimates: true,
  jobs: true,
  invoices: true,
};

/** Whether a page has a right-side detail/rail panel with a tunable desktop width. */
export const PAGE_HAS_PANEL: Record<FounderPageKey, boolean> = {
  dashboard: false,
  requests: true,
  customers: true,
  estimates: true,
  jobs: true,
  invoices: true,
};

// ---------------------------------------------------------------------------
// KPI card tokens
// ---------------------------------------------------------------------------

export const KPI_TOKEN_KEYS = [
  "minHeight",
  "padding",
  "gap",
  "iconSize",
  "labelFontSize",
  "numberFontSize",
  "supportingFontSize",
] as const;
export type KpiTokenKey = (typeof KPI_TOKEN_KEYS)[number];
export type KpiTokens = Partial<Record<KpiTokenKey, number>>;

export const KPI_TOKEN_LABELS: Record<KpiTokenKey, string> = {
  minHeight: "Card Height",
  padding: "Card Padding",
  gap: "Card Gap",
  iconSize: "Icon Size",
  labelFontSize: "Label Text Size",
  numberFontSize: "Number Text Size",
  supportingFontSize: "Supporting Text Size",
};

/**
 * Safe bounds. `minHeight` floors at 0 (meaning "no minimum -- natural
 * height", i.e. today's actual behavior) rather than forcing an
 * artificial minimum on every page. All other floors are chosen so
 * content cannot visibly overlap or become unreadable (e.g. a 9px number
 * or a 16px icon circle is still legible/usable, going lower would not
 * be).
 */
export const KPI_TOKEN_BOUNDS: Record<KpiTokenKey, { min: number; max: number; step: number }> = {
  minHeight: { min: 0, max: 160, step: 4 },
  padding: { min: 8, max: 28, step: 2 },
  gap: { min: 8, max: 28, step: 2 },
  iconSize: { min: 20, max: 56, step: 2 },
  labelFontSize: { min: 9, max: 14, step: 1 },
  numberFontSize: { min: 16, max: 36, step: 2 },
  supportingFontSize: { min: 9, max: 14, step: 1 },
};

/**
 * Each page's CURRENT approved values -- the exact numbers already
 * hardcoded in that page's KpiCard/OverviewKpi JSX today. These are the
 * "baseline/default" required by the spec: installing Founder Design
 * Mode must not change anything until a founder actively saves an
 * override, and these are also what a founder's control panel starts
 * from when no override exists yet.
 *
 *  - dashboard: src/app/(app)/dashboard/page.tsx KpiCard() -- CardContent
 *    has no explicit padding override so uses Card's own
 *    --card-spacing (1rem = 16px); icon wrapper size-9 = 36px; label
 *    text-xs = 12px; number text-2xl = 24px; sublabel text-xs = 12px;
 *    grid gap-3 = 12px.
 *  - requests/estimates/jobs/invoices: identical KpiCard() -- CardContent
 *    p-5 = 20px; icon wrapper size-12 = 48px; label text-[11px]; number
 *    text-3xl = 30px; sublabel text-xs = 12px; grid gap-5 = 20px.
 *  - customers: OverviewKpi() -- p-3 = 12px; icon wrapper size-9 = 36px;
 *    label text-[0.7rem] ~= 11.2px; number text-xl = 20px; sublabel
 *    text-[0.7rem] ~= 11.2px; grid gap-3 = 12px.
 */
export const KPI_DEFAULTS: Record<FounderPageKey, Record<KpiTokenKey, number>> = {
  dashboard: { minHeight: 0, padding: 16, gap: 12, iconSize: 36, labelFontSize: 12, numberFontSize: 24, supportingFontSize: 12 },
  requests: { minHeight: 0, padding: 20, gap: 20, iconSize: 48, labelFontSize: 11, numberFontSize: 30, supportingFontSize: 12 },
  customers: { minHeight: 0, padding: 12, gap: 12, iconSize: 36, labelFontSize: 11, numberFontSize: 20, supportingFontSize: 11 },
  estimates: { minHeight: 0, padding: 20, gap: 20, iconSize: 48, labelFontSize: 11, numberFontSize: 30, supportingFontSize: 12 },
  jobs: { minHeight: 0, padding: 20, gap: 20, iconSize: 48, labelFontSize: 11, numberFontSize: 30, supportingFontSize: 12 },
  invoices: { minHeight: 0, padding: 20, gap: 20, iconSize: 48, labelFontSize: 11, numberFontSize: 30, supportingFontSize: 12 },
};

export function clampKpiTokens(input: KpiTokens): KpiTokens {
  const out: KpiTokens = {};
  for (const key of KPI_TOKEN_KEYS) {
    const raw = input[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    const bounds = KPI_TOKEN_BOUNDS[key];
    const stepped = Math.round(raw / bounds.step) * bounds.step;
    out[key] = Math.min(bounds.max, Math.max(bounds.min, stepped));
  }
  return out;
}

/** CSS custom-property names, shared by every page's KPI rendering. */
export const KPI_CSS_VARS: Record<KpiTokenKey, string> = {
  minHeight: "--tbbt-kpi-min-height",
  padding: "--tbbt-kpi-padding",
  gap: "--tbbt-kpi-gap",
  iconSize: "--tbbt-kpi-icon-size",
  labelFontSize: "--tbbt-kpi-label-font",
  numberFontSize: "--tbbt-kpi-number-font",
  supportingFontSize: "--tbbt-kpi-supporting-font",
};

// ---------------------------------------------------------------------------
// Table density (Compact / Standard / Comfortable preset)
// ---------------------------------------------------------------------------

export const TABLE_DENSITIES = ["compact", "standard", "comfortable"] as const;
export type TableDensity = (typeof TABLE_DENSITIES)[number];

export function isTableDensity(value: string): value is TableDensity {
  return (TABLE_DENSITIES as readonly string[]).includes(value);
}

/**
 * Each page's CURRENT actual row/header vertical padding -- these differ
 * per page today (Requests uses a more generous `py-5` = 20px body row
 * from its own visual-fidelity pass; Customers/Estimates/Jobs/Invoices
 * all use `py-4` = 16px; every table's header row uses `py-3.5` = 14px).
 * "standard" for a page is always exactly ITS OWN current value -- never
 * a single shared constant -- so picking "Standard" (the default) can
 * never change any page's current appearance.
 */
export const TABLE_DENSITY_DEFAULTS: Record<FounderPageKey, { rowPy: number; headerPy: number }> = {
  dashboard: { rowPy: 0, headerPy: 0 },
  requests: { rowPy: 20, headerPy: 14 },
  customers: { rowPy: 16, headerPy: 14 },
  estimates: { rowPy: 16, headerPy: 14 },
  jobs: { rowPy: 16, headerPy: 14 },
  invoices: { rowPy: 16, headerPy: 14 },
};

/**
 * "Compact"/"Comfortable" are relative offsets from that page's own
 * "standard" baseline above, floored so a row can never collapse to
 * something unusable.
 */
export function tableDensityPx(
  pageKey: FounderPageKey,
  density: TableDensity,
): { rowPy: number; headerPy: number } {
  const base = TABLE_DENSITY_DEFAULTS[pageKey];
  if (density === "standard") return base;
  if (density === "compact") {
    return { rowPy: Math.max(6, base.rowPy - 8), headerPy: Math.max(6, base.headerPy - 6) };
  }
  return { rowPy: base.rowPy + 6, headerPy: base.headerPy + 4 };
}

export const TABLE_CSS_VARS = {
  rowPy: "--tbbt-table-row-py",
  headerPy: "--tbbt-table-header-py",
} as const;

// ---------------------------------------------------------------------------
// Page section spacing (gap between the KPI row / tabs / table sections)
// ---------------------------------------------------------------------------

/** Matches PageContainer's existing space-y-6 (1.5rem = 24px) rhythm exactly. */
export const SECTION_GAP_DEFAULT = 24;
export const SECTION_GAP_BOUNDS = { min: 8, max: 40, step: 2 };
export const SECTION_GAP_CSS_VAR = "--tbbt-section-gap";

export function clampSectionGap(value: number): number {
  const stepped = Math.round(value / SECTION_GAP_BOUNDS.step) * SECTION_GAP_BOUNDS.step;
  return Math.min(SECTION_GAP_BOUNDS.max, Math.max(SECTION_GAP_BOUNDS.min, stepped));
}

// ---------------------------------------------------------------------------
// Desktop details/rail panel width
// ---------------------------------------------------------------------------

/**
 * Each page's current panel width -- the exact `_XXXpx` already in that
 * page's `lg:`/`xl:grid-cols-[minmax(0,1fr)_XXXpx]` grid today. Bounded
 * conservatively (220-420px) so an experimental value cannot visually
 * starve the table at 1440px the way the pre-minmax(0,1fr) bug once did.
 */
export const PANEL_WIDTH_DEFAULTS: Record<FounderPageKey, number | undefined> = {
  dashboard: undefined,
  requests: 280,
  customers: 300,
  estimates: 350,
  jobs: 350,
  invoices: 340,
};
export const PANEL_WIDTH_BOUNDS = { min: 220, max: 420, step: 10 };
export const PANEL_WIDTH_CSS_VAR = "--tbbt-panel-width";

export function clampPanelWidth(value: number): number {
  const stepped = Math.round(value / PANEL_WIDTH_BOUNDS.step) * PANEL_WIDTH_BOUNDS.step;
  return Math.min(PANEL_WIDTH_BOUNDS.max, Math.max(PANEL_WIDTH_BOUNDS.min, stepped));
}

// ---------------------------------------------------------------------------
// Combined per-page token bundle (this is exactly what gets persisted)
// ---------------------------------------------------------------------------

export type FounderPageTokens = {
  kpi?: KpiTokens;
  tableDensity?: TableDensity;
  sectionGap?: number;
  panelWidth?: number;
};

/**
 * Validates and clamps an arbitrary (client-submitted) payload into a
 * safe FounderPageTokens object. Never trusts the shape/values coming
 * from the client -- every numeric value is independently clamped to its
 * own bounds, every enum value is checked against the fixed allow-list,
 * and any unrecognized key/page-inapplicable section is silently
 * dropped rather than stored.
 */
export function sanitizeFounderPageTokens(
  pageKey: FounderPageKey,
  input: unknown,
): FounderPageTokens {
  if (!input || typeof input !== "object") {
    return {};
  }
  const raw = input as Record<string, unknown>;
  const result: FounderPageTokens = {};

  if (raw.kpi && typeof raw.kpi === "object") {
    const kpi = clampKpiTokens(raw.kpi as KpiTokens);
    if (Object.keys(kpi).length > 0) {
      result.kpi = kpi;
    }
  }

  if (PAGE_HAS_TABLE[pageKey] && typeof raw.tableDensity === "string" && isTableDensity(raw.tableDensity)) {
    result.tableDensity = raw.tableDensity;
  }

  if (typeof raw.sectionGap === "number" && Number.isFinite(raw.sectionGap)) {
    result.sectionGap = clampSectionGap(raw.sectionGap);
  }

  if (PAGE_HAS_PANEL[pageKey] && typeof raw.panelWidth === "number" && Number.isFinite(raw.panelWidth)) {
    result.panelWidth = clampPanelWidth(raw.panelWidth);
  }

  return result;
}

/**
 * Turns a (possibly partial) token bundle into the exact inline `style`
 * object a page's FounderDesignScope wrapper should render. Only keys
 * actually present in `tokens` get a CSS variable set -- everything else
 * is deliberately left unset, so the component's own hardcoded fallback
 * (`var(--tbbt-x, <current value>)`) applies, guaranteeing zero visual
 * change for any token the founder has never touched.
 */
export function tokensToCssVars(pageKey: FounderPageKey, tokens: FounderPageTokens): CSSProperties {
  const style: Record<string, string> = {};

  if (tokens.kpi) {
    for (const key of KPI_TOKEN_KEYS) {
      const value = tokens.kpi[key];
      if (typeof value === "number") {
        style[KPI_CSS_VARS[key]] = `${value}px`;
      }
    }
  }

  if (tokens.tableDensity) {
    const density = tableDensityPx(pageKey, tokens.tableDensity);
    style[TABLE_CSS_VARS.rowPy] = `${density.rowPy}px`;
    style[TABLE_CSS_VARS.headerPy] = `${density.headerPy}px`;
  }

  if (typeof tokens.sectionGap === "number") {
    style[SECTION_GAP_CSS_VAR] = `${tokens.sectionGap}px`;
  }

  if (typeof tokens.panelWidth === "number") {
    style[PANEL_WIDTH_CSS_VAR] = `${tokens.panelWidth}px`;
  }

  return style as CSSProperties;
}

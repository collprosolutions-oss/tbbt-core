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
import {
  isCuratedIconId,
  isIconColorToken,
  type CuratedIconId,
  type IconColorToken,
} from "@/lib/founder-icons";
import { isFounderRegionId } from "@/lib/founder-regions";

export const FOUNDER_PAGE_KEYS = [
  "dashboard",
  "requests",
  "customers",
  "estimates",
  "jobs",
  "invoices",
  "services",
  "time-cards",
  "payroll",
  "expenses",
  "reports",
  "marketing",
  "reviews",
  "pipeline",
  "knowledge",
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
  services: "Services",
  "time-cards": "Time Cards",
  payroll: "Payroll",
  expenses: "Expenses",
  reports: "Reports",
  marketing: "Marketing",
  reviews: "Reviews",
  pipeline: "Deals / Pipeline",
  knowledge: "Knowledge Hub",
};

/** Whether a page has the dense table + master-detail panel section at all (Dashboard does not). */
export const PAGE_HAS_TABLE: Record<FounderPageKey, boolean> = {
  dashboard: false,
  requests: true,
  customers: true,
  estimates: true,
  jobs: true,
  invoices: true,
  services: false,
  "time-cards": true,
  payroll: true,
  expenses: true,
  reports: true,
  marketing: true,
  reviews: true,
  pipeline: false,
  knowledge: true,
};

/** Whether a page has a right-side detail/rail panel with a tunable desktop width. */
export const PAGE_HAS_PANEL: Record<FounderPageKey, boolean> = {
  dashboard: false,
  requests: true,
  customers: true,
  estimates: true,
  jobs: true,
  invoices: true,
  services: true,
  "time-cards": true,
  payroll: true,
  expenses: true,
  reports: true,
  marketing: true,
  reviews: true,
  pipeline: true,
  knowledge: true,
};

/**
 * The exact number of KPI cards each page renders today (the length of
 * that page's own `kpis`/`overviewKpis` array) -- used only to bound
 * which per-card-index overrides are valid. Never used to fabricate a
 * card that doesn't exist; each page's real card labels are passed into
 * FounderDesignRoot at render time (see kpiCardLabels prop) for the
 * drawer to display, not hardcoded here.
 */
export const KPI_CARD_COUNTS: Record<FounderPageKey, number> = {
  dashboard: 5,
  requests: 4,
  customers: 4,
  estimates: 5,
  jobs: 5,
  invoices: 5,
  services: 4,
  "time-cards": 4,
  payroll: 4,
  expenses: 5,
  reports: 5,
  marketing: 4,
  reviews: 5,
  pipeline: 5,
  knowledge: 4,
};

// ---------------------------------------------------------------------------
// KPI card tokens
// ---------------------------------------------------------------------------

export const KPI_TOKEN_KEYS = [
  "minHeight",
  "padding",
  "paddingY",
  "paddingX",
  "gap",
  "internalGap",
  "iconSize",
  "labelFontSize",
  "numberFontSize",
  "supportingFontSize",
  "lineHeight",
] as const;
export type KpiTokenKey = (typeof KPI_TOKEN_KEYS)[number];
export type KpiTokens = Partial<Record<KpiTokenKey, number>>;

export const KPI_TOKEN_LABELS: Record<KpiTokenKey, string> = {
  minHeight: "Card Height",
  padding: "Card Padding",
  paddingY: "Vertical Padding",
  paddingX: "Horizontal Padding",
  gap: "Card Gap",
  internalGap: "Internal Vertical Gap",
  iconSize: "Icon Size",
  labelFontSize: "Label Text Size",
  numberFontSize: "Number Text Size",
  supportingFontSize: "Supporting Text Size",
  lineHeight: "Text Line Height",
};

/**
 * Safe but substantially broader bounds than V1. `minHeight` floors at 0
 * ("no minimum -- natural height"). Vertical padding and internal gap
 * may reach 0px so the founder can actually compress rendered geometry;
 * horizontal padding floors at 4px so labels stay readable. `lineHeight`
 * is stored as a percent (120 = 1.20) so it stays an integer token.
 *
 * Legacy `padding` is still accepted (mapped onto paddingY at read time)
 * so previously saved overrides keep working.
 */
export const KPI_TOKEN_BOUNDS: Record<KpiTokenKey, { min: number; max: number; step: number }> = {
  minHeight: { min: 0, max: 160, step: 4 },
  padding: { min: 0, max: 40, step: 2 },
  paddingY: { min: 0, max: 40, step: 2 },
  paddingX: { min: 4, max: 32, step: 2 },
  gap: { min: 2, max: 28, step: 2 },
  internalGap: { min: 0, max: 16, step: 2 },
  iconSize: { min: 16, max: 56, step: 2 },
  labelFontSize: { min: 9, max: 14, step: 1 },
  numberFontSize: { min: 14, max: 36, step: 2 },
  supportingFontSize: { min: 9, max: 14, step: 1 },
  lineHeight: { min: 100, max: 150, step: 5 },
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
 *  - requests/estimates/jobs/invoices/services: identical workspace KpiCard()
 *    -- CardContent p-5 = 20px; icon wrapper size-12 = 48px; label
 *    text-[11px]; number text-3xl = 30px; sublabel text-xs = 12px; grid
 *    gap-5 = 20px.
 *  - customers: OverviewKpi() -- p-3 = 12px; icon wrapper size-9 = 36px;
 *    label text-[0.7rem] ~= 11.2px; number text-xl = 20px; sublabel
 *    text-[0.7rem] ~= 11.2px; grid gap-3 = 12px.
 */
export const KPI_DEFAULTS: Record<FounderPageKey, Record<KpiTokenKey, number>> = {
  dashboard: {
    minHeight: 0,
    padding: 16,
    paddingY: 32,
    paddingX: 16,
    gap: 12,
    internalGap: 6,
    iconSize: 36,
    labelFontSize: 12,
    numberFontSize: 24,
    supportingFontSize: 12,
    lineHeight: 125,
  },
  requests: {
    minHeight: 0,
    padding: 20,
    paddingY: 36,
    paddingX: 20,
    gap: 20,
    internalGap: 4,
    iconSize: 48,
    labelFontSize: 11,
    numberFontSize: 30,
    supportingFontSize: 12,
    lineHeight: 120,
  },
  customers: {
    minHeight: 0,
    padding: 12,
    paddingY: 12,
    paddingX: 12,
    gap: 12,
    internalGap: 8,
    iconSize: 36,
    labelFontSize: 11,
    numberFontSize: 20,
    supportingFontSize: 11,
    lineHeight: 125,
  },
  estimates: {
    minHeight: 0,
    padding: 20,
    paddingY: 36,
    paddingX: 20,
    gap: 20,
    internalGap: 4,
    iconSize: 48,
    labelFontSize: 11,
    numberFontSize: 30,
    supportingFontSize: 12,
    lineHeight: 120,
  },
  jobs: {
    minHeight: 0,
    padding: 20,
    paddingY: 36,
    paddingX: 20,
    gap: 20,
    internalGap: 4,
    iconSize: 48,
    labelFontSize: 11,
    numberFontSize: 30,
    supportingFontSize: 12,
    lineHeight: 120,
  },
  invoices: {
    minHeight: 0,
    padding: 20,
    paddingY: 36,
    paddingX: 20,
    gap: 20,
    internalGap: 4,
    iconSize: 48,
    labelFontSize: 11,
    numberFontSize: 30,
    supportingFontSize: 12,
    lineHeight: 120,
  },
  services: {
    minHeight: 0,
    padding: 20,
    paddingY: 36,
    paddingX: 20,
    gap: 20,
    internalGap: 4,
    iconSize: 48,
    labelFontSize: 11,
    numberFontSize: 30,
    supportingFontSize: 12,
    lineHeight: 120,
  },
  "time-cards": {
    minHeight: 0,
    padding: 20,
    paddingY: 36,
    paddingX: 20,
    gap: 20,
    internalGap: 4,
    iconSize: 48,
    labelFontSize: 11,
    numberFontSize: 30,
    supportingFontSize: 12,
    lineHeight: 120,
  },
  payroll: {
    minHeight: 0,
    padding: 20,
    paddingY: 36,
    paddingX: 20,
    gap: 20,
    internalGap: 4,
    iconSize: 48,
    labelFontSize: 11,
    numberFontSize: 30,
    supportingFontSize: 12,
    lineHeight: 120,
  },
  expenses: {
    minHeight: 0,
    padding: 20,
    paddingY: 36,
    paddingX: 20,
    gap: 20,
    internalGap: 4,
    iconSize: 48,
    labelFontSize: 11,
    numberFontSize: 30,
    supportingFontSize: 12,
    lineHeight: 120,
  },
  reports: {
    minHeight: 0,
    padding: 20,
    paddingY: 36,
    paddingX: 20,
    gap: 20,
    internalGap: 4,
    iconSize: 48,
    labelFontSize: 11,
    numberFontSize: 30,
    supportingFontSize: 12,
    lineHeight: 120,
  },
  marketing: {
    minHeight: 0,
    padding: 20,
    paddingY: 36,
    paddingX: 20,
    gap: 20,
    internalGap: 4,
    iconSize: 48,
    labelFontSize: 11,
    numberFontSize: 30,
    supportingFontSize: 12,
    lineHeight: 120,
  },
  reviews: {
    minHeight: 0,
    padding: 20,
    paddingY: 36,
    paddingX: 20,
    gap: 20,
    internalGap: 4,
    iconSize: 48,
    labelFontSize: 11,
    numberFontSize: 30,
    supportingFontSize: 12,
    lineHeight: 120,
  },
  pipeline: {
    minHeight: 0,
    padding: 20,
    paddingY: 36,
    paddingX: 20,
    gap: 20,
    internalGap: 4,
    iconSize: 48,
    labelFontSize: 11,
    numberFontSize: 30,
    supportingFontSize: 12,
    lineHeight: 120,
  },
  knowledge: {
    minHeight: 0,
    padding: 20,
    paddingY: 36,
    paddingX: 20,
    gap: 20,
    internalGap: 4,
    iconSize: 48,
    labelFontSize: 11,
    numberFontSize: 30,
    supportingFontSize: 12,
    lineHeight: 120,
  },
};

/**
 * Effective vertical padding used when the founder has never set
 * paddingY. Includes the shadcn Card chrome (`py-(--card-spacing)` = 16px
 * each side) that used to sit OUTSIDE the founder `padding` token -- that
 * chrome was why reducing "Card Padding" could not shrink rendered
 * height. TunableKpiCard now zeros Card py/gap so this single token is
 * the actual padding-block.
 *
 * Legacy saved `kpi.padding` (content-only) is applied as-is -- without
 * re-adding chrome -- so a founder who already tried to compress gets
 * the shrinkage they asked for.
 */
export function resolveKpiPaddingY(pageKey: FounderPageKey, kpi: KpiTokens | undefined): number {
  if (typeof kpi?.paddingY === "number") return kpi.paddingY;
  if (typeof kpi?.padding === "number") return kpi.padding;
  return KPI_DEFAULTS[pageKey].paddingY;
}

export function resolveKpiPaddingX(pageKey: FounderPageKey, kpi: KpiTokens | undefined): number {
  if (typeof kpi?.paddingX === "number") return kpi.paddingX;
  if (typeof kpi?.padding === "number") return kpi.padding;
  return KPI_DEFAULTS[pageKey].paddingX;
}

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
  paddingY: "--tbbt-kpi-padding-y",
  paddingX: "--tbbt-kpi-padding-x",
  gap: "--tbbt-kpi-gap",
  internalGap: "--tbbt-kpi-internal-gap",
  iconSize: "--tbbt-kpi-icon-size",
  labelFontSize: "--tbbt-kpi-label-font",
  numberFontSize: "--tbbt-kpi-number-font",
  supportingFontSize: "--tbbt-kpi-supporting-font",
  lineHeight: "--tbbt-kpi-line-height",
};

export const KPI_INTERNAL_LAYOUTS = ["current", "aligned"] as const;
export type KpiInternalLayout = (typeof KPI_INTERNAL_LAYOUTS)[number];

export function isKpiInternalLayout(value: string): value is KpiInternalLayout {
  return (KPI_INTERNAL_LAYOUTS as readonly string[]).includes(value);
}

export type KpiAppearanceTokens = {
  icon?: CuratedIconId;
  iconColor?: IconColorToken;
};

// ---------------------------------------------------------------------------
// KPI width / layout -- "equal width" (today's behavior, every card
// shares the row equally) vs "custom widths" (a default "group" width
// for any card without its own override, plus a per-card-index override
// that always wins, including an explicit "auto" meaning "stay flexible
// / fill remaining space" -- this is how e.g. Invoices' compact
// count-cards + a wider Total Revenue card is expressed: group width
// narrow, Total Revenue's own override left at "auto").
//
// Deliberately resolved in the client (see
// src/components/founder-design/kpi-cards-layout.tsx), NOT via CSS
// variables, because a fixed-width card needs flex-grow:0 while a
// flexible one needs flex-grow:1 -- two different values, not just a
// different length -- which a single var() fallback chain cannot express.
// ---------------------------------------------------------------------------

export const KPI_LAYOUTS = ["equal", "custom"] as const;
export type KpiLayout = (typeof KPI_LAYOUTS)[number];

export function isKpiLayout(value: string): value is KpiLayout {
  return (KPI_LAYOUTS as readonly string[]).includes(value);
}

/** A specific pixel width, or "auto" to explicitly stay flexible/fill remaining space even in "custom" layout. */
export type KpiCardWidthValue = number | "auto";

export type KpiWidthTokens = {
  layout?: KpiLayout;
  groupWidth?: number;
  /** Keyed by card index (0-based, matching that page's real kpis array order). */
  cardWidths?: Record<number, KpiCardWidthValue>;
};

export const KPI_WIDTH_BOUNDS = { min: 80, max: 400, step: 10 };

export function clampKpiWidthValue(value: number): number {
  const stepped = Math.round(value / KPI_WIDTH_BOUNDS.step) * KPI_WIDTH_BOUNDS.step;
  return Math.min(KPI_WIDTH_BOUNDS.max, Math.max(KPI_WIDTH_BOUNDS.min, stepped));
}

function sanitizeKpiWidthTokens(pageKey: FounderPageKey, input: unknown): KpiWidthTokens | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const result: KpiWidthTokens = {};

  if (typeof raw.layout === "string" && isKpiLayout(raw.layout)) {
    result.layout = raw.layout;
  }
  if (typeof raw.groupWidth === "number" && Number.isFinite(raw.groupWidth)) {
    result.groupWidth = clampKpiWidthValue(raw.groupWidth);
  }
  if (raw.cardWidths && typeof raw.cardWidths === "object") {
    const count = KPI_CARD_COUNTS[pageKey];
    const cardWidths: Record<number, KpiCardWidthValue> = {};
    for (const [key, value] of Object.entries(raw.cardWidths as Record<string, unknown>)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= count) continue;
      if (value === "auto") {
        cardWidths[index] = "auto";
      } else if (typeof value === "number" && Number.isFinite(value)) {
        cardWidths[index] = clampKpiWidthValue(value);
      }
    }
    if (Object.keys(cardWidths).length > 0) {
      result.cardWidths = cardWidths;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizeKpiAppearance(pageKey: FounderPageKey, input: unknown): Record<number, KpiAppearanceTokens> | undefined {
  if (!input || typeof input !== "object") return undefined;
  const count = KPI_CARD_COUNTS[pageKey];
  const result: Record<number, KpiAppearanceTokens> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= count) continue;
    if (!value || typeof value !== "object") continue;
    const raw = value as Record<string, unknown>;
    const appearance: KpiAppearanceTokens = {};
    if (typeof raw.icon === "string" && isCuratedIconId(raw.icon)) {
      appearance.icon = raw.icon;
    }
    if (typeof raw.iconColor === "string" && isIconColorToken(raw.iconColor)) {
      appearance.iconColor = raw.iconColor;
    }
    if (Object.keys(appearance).length > 0) {
      result[index] = appearance;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizeRegionMap(pageKey: FounderPageKey, input: unknown): Record<string, RegionTokens> | undefined {
  if (!input || typeof input !== "object") return undefined;
  const result: Record<string, RegionTokens> = {};
  for (const [regionId, value] of Object.entries(input as Record<string, unknown>)) {
    if (!isFounderRegionId(pageKey, regionId)) continue;
    if (!value || typeof value !== "object") continue;
    const clean = clampRegionTokens(value as RegionTokens);
    if (Object.keys(clean).length > 0) {
      result[regionId] = clean;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Resolves one card's effective flex sizing from the current KPI width tokens. Pure/no side effects -- shared by the live-preview layout and (indirectly, via the same tokens) whatever gets saved. */
export function resolveKpiCardFlex(width: KpiWidthTokens | undefined, index: number): { flexBasis: string; flexGrow: number; flexShrink: number } {
  const override = width?.cardWidths?.[index];
  let pixels: number | undefined;
  if (typeof override === "number") {
    pixels = override;
  } else if (override === undefined && width?.layout === "custom" && typeof width.groupWidth === "number") {
    pixels = width.groupWidth;
  }
  if (typeof pixels === "number") {
    return { flexBasis: `${pixels}px`, flexGrow: 0, flexShrink: 0 };
  }
  return { flexBasis: "0%", flexGrow: 1, flexShrink: 1 };
}

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
  services: { rowPy: 0, headerPy: 0 },
  "time-cards": { rowPy: 16, headerPy: 14 },
  payroll: { rowPy: 16, headerPy: 14 },
  expenses: { rowPy: 16, headerPy: 14 },
  reports: { rowPy: 16, headerPy: 14 },
  marketing: { rowPy: 16, headerPy: 14 },
  reviews: { rowPy: 16, headerPy: 14 },
  pipeline: { rowPy: 0, headerPy: 0 },
  knowledge: { rowPy: 16, headerPy: 14 },
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
  cellPx: "--tbbt-table-cell-px",
  fontSize: "--tbbt-table-font-size",
  headerFontSize: "--tbbt-table-header-font-size",
} as const;

/**
 * Each page's current horizontal cell padding (Requests/Customers/Jobs/
 * Invoices use `px-2` = 8px; Estimates uses `px-2.5` = 10px) and base
 * text sizes (every table uses `text-sm` = 14px body, `text-xs` = 12px
 * header row today).
 */
export const TABLE_CELL_PX_DEFAULTS: Record<FounderPageKey, number> = {
  dashboard: 0,
  requests: 8,
  customers: 8,
  estimates: 10,
  jobs: 8,
  invoices: 8,
  services: 0,
  "time-cards": 8,
  payroll: 8,
  expenses: 8,
  reports: 8,
  marketing: 8,
  reviews: 8,
  pipeline: 0,
  knowledge: 8,
};
export const TABLE_CELL_PX_BOUNDS = { min: 4, max: 20, step: 2 };

export const TABLE_FONT_SIZE_DEFAULT = 14;
export const TABLE_HEADER_FONT_SIZE_DEFAULT = 12;
export const TABLE_FONT_SIZE_BOUNDS = { min: 11, max: 17, step: 1 };
export const TABLE_HEADER_FONT_SIZE_BOUNDS = { min: 10, max: 15, step: 1 };

export function clampTableCellPx(value: number): number {
  const stepped = Math.round(value / TABLE_CELL_PX_BOUNDS.step) * TABLE_CELL_PX_BOUNDS.step;
  return Math.min(TABLE_CELL_PX_BOUNDS.max, Math.max(TABLE_CELL_PX_BOUNDS.min, stepped));
}
export function clampTableFontSize(value: number): number {
  const stepped = Math.round(value / TABLE_FONT_SIZE_BOUNDS.step) * TABLE_FONT_SIZE_BOUNDS.step;
  return Math.min(TABLE_FONT_SIZE_BOUNDS.max, Math.max(TABLE_FONT_SIZE_BOUNDS.min, stepped));
}
export function clampTableHeaderFontSize(value: number): number {
  const stepped = Math.round(value / TABLE_HEADER_FONT_SIZE_BOUNDS.step) * TABLE_HEADER_FONT_SIZE_BOUNDS.step;
  return Math.min(TABLE_HEADER_FONT_SIZE_BOUNDS.max, Math.max(TABLE_HEADER_FONT_SIZE_BOUNDS.min, stepped));
}

// ---------------------------------------------------------------------------
// Page section spacing (gap between the KPI row / tabs / table sections)
// ---------------------------------------------------------------------------

/** Matches PageContainer's existing space-y-6 (1.5rem = 24px) rhythm exactly. */
export const SECTION_GAP_DEFAULT = 24;
export const SECTION_GAP_BOUNDS = { min: 4, max: 40, step: 2 };
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
  services: 340,
  "time-cards": 320,
  payroll: 340,
  expenses: 340,
  reports: 300,
  marketing: 300,
  reviews: 300,
  pipeline: 300,
  knowledge: 300,
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

export const REGION_TOKEN_KEYS = [
  "minHeight",
  "paddingY",
  "paddingX",
  "gap",
  "titleSize",
  "titleIconSize",
  "bodySize",
  "lineHeight",
  "buttonTextSize",
] as const;
export type RegionTokenKey = (typeof REGION_TOKEN_KEYS)[number];

export type RegionTokens = Partial<Record<RegionTokenKey, number>> & {
  icon?: CuratedIconId;
  iconColor?: IconColorToken;
};

export const REGION_TOKEN_LABELS: Record<RegionTokenKey, string> = {
  minHeight: "Min Height",
  paddingY: "Vertical Padding",
  paddingX: "Horizontal Padding",
  gap: "Internal Spacing",
  titleSize: "Title Size",
  titleIconSize: "Title Icon Size",
  bodySize: "Body Text Size",
  lineHeight: "Text Line Height",
  buttonTextSize: "Button Text Size",
};

export const REGION_TOKEN_BOUNDS: Record<RegionTokenKey, { min: number; max: number; step: number }> = {
  minHeight: { min: 0, max: 400, step: 8 },
  paddingY: { min: 0, max: 32, step: 2 },
  paddingX: { min: 4, max: 32, step: 2 },
  gap: { min: 0, max: 24, step: 2 },
  titleSize: { min: 12, max: 22, step: 1 },
  titleIconSize: { min: 12, max: 28, step: 2 },
  bodySize: { min: 11, max: 16, step: 1 },
  lineHeight: { min: 110, max: 160, step: 5 },
  buttonTextSize: { min: 11, max: 16, step: 1 },
};

export const REGION_TOKEN_DEFAULTS: Record<RegionTokenKey, number> = {
  minHeight: 0,
  paddingY: 16,
  paddingX: 16,
  gap: 16,
  titleSize: 16,
  titleIconSize: 16,
  bodySize: 14,
  lineHeight: 140,
  buttonTextSize: 14,
};

export const REGION_CSS_VARS: Record<RegionTokenKey, string> = {
  minHeight: "--tbbt-region-min-h",
  paddingY: "--tbbt-region-pad-y",
  paddingX: "--tbbt-region-pad-x",
  gap: "--tbbt-region-gap",
  titleSize: "--tbbt-region-title-size",
  titleIconSize: "--tbbt-region-icon-size",
  bodySize: "--tbbt-region-body-size",
  lineHeight: "--tbbt-region-line-height",
  buttonTextSize: "--tbbt-region-btn-text",
};

export function clampRegionTokens(input: RegionTokens): RegionTokens {
  const out: RegionTokens = {};
  for (const key of REGION_TOKEN_KEYS) {
    const raw = input[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    const bounds = REGION_TOKEN_BOUNDS[key];
    const stepped = Math.round(raw / bounds.step) * bounds.step;
    out[key] = Math.min(bounds.max, Math.max(bounds.min, stepped));
  }
  if (typeof input.icon === "string" && isCuratedIconId(input.icon)) {
    out.icon = input.icon;
  }
  if (typeof input.iconColor === "string" && isIconColorToken(input.iconColor)) {
    out.iconColor = input.iconColor;
  }
  return out;
}

export function regionTokensToStyle(tokens: RegionTokens | undefined): CSSProperties {
  if (!tokens) return {};
  const style: Record<string, string> = {};
  for (const key of REGION_TOKEN_KEYS) {
    const value = tokens[key];
    if (typeof value !== "number") continue;
    if (key === "lineHeight") {
      style[REGION_CSS_VARS[key]] = (value / 100).toFixed(2);
    } else {
      style[REGION_CSS_VARS[key]] = `${value}px`;
    }
  }
  return style as CSSProperties;
}

export type FounderPageTokens = {
  kpi?: KpiTokens;
  kpiWidth?: KpiWidthTokens;
  kpiInternalLayout?: KpiInternalLayout;
  kpiAppearance?: Record<number, KpiAppearanceTokens>;
  tableDensity?: TableDensity;
  tableCellPx?: number;
  tableFontSize?: number;
  tableHeaderFontSize?: number;
  sectionGap?: number;
  panelWidth?: number;
  regions?: Record<string, RegionTokens>;
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

  const kpiWidth = sanitizeKpiWidthTokens(pageKey, raw.kpiWidth);
  if (kpiWidth) {
    result.kpiWidth = kpiWidth;
  }

  if (typeof raw.kpiInternalLayout === "string" && isKpiInternalLayout(raw.kpiInternalLayout)) {
    result.kpiInternalLayout = raw.kpiInternalLayout;
  }

  const kpiAppearance = sanitizeKpiAppearance(pageKey, raw.kpiAppearance);
  if (kpiAppearance) {
    result.kpiAppearance = kpiAppearance;
  }

  const regions = sanitizeRegionMap(pageKey, raw.regions);
  if (regions) {
    result.regions = regions;
  }

  if (PAGE_HAS_TABLE[pageKey]) {
    if (typeof raw.tableDensity === "string" && isTableDensity(raw.tableDensity)) {
      result.tableDensity = raw.tableDensity;
    }
    if (typeof raw.tableCellPx === "number" && Number.isFinite(raw.tableCellPx)) {
      result.tableCellPx = clampTableCellPx(raw.tableCellPx);
    }
    if (typeof raw.tableFontSize === "number" && Number.isFinite(raw.tableFontSize)) {
      result.tableFontSize = clampTableFontSize(raw.tableFontSize);
    }
    if (typeof raw.tableHeaderFontSize === "number" && Number.isFinite(raw.tableHeaderFontSize)) {
      result.tableHeaderFontSize = clampTableHeaderFontSize(raw.tableHeaderFontSize);
    }
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
 * Removes one or more dot-path fields from a token bundle (e.g.
 * "kpi.minHeight", "kpi.padding" for the "Card Height & Padding"
 * section, or a bare top-level key like "kpiWidth" or "tableDensity" to
 * clear a whole section at once). Used by resetFounderDesignSection() so
 * each collapsible drawer section can reset independently without
 * disturbing any other saved section.
 */
export function clearFieldPaths(tokens: FounderPageTokens, paths: readonly string[]): FounderPageTokens {
  const next: Record<string, unknown> = structuredClone(tokens as Record<string, unknown>);
  for (const path of paths) {
    const segments = path.split(".");
    const branches: Record<string, unknown>[] = [next];
    let ok = true;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const branch = branches[branches.length - 1][segments[i]];
      if (!branch || typeof branch !== "object") {
        ok = false;
        break;
      }
      branches.push(branch as Record<string, unknown>);
    }
    if (!ok) continue;
    delete branches[branches.length - 1][segments[segments.length - 1]];
    // Prune now-empty ancestor objects so an empty {} never lingers in storage.
    for (let i = branches.length - 1; i > 0; i -= 1) {
      if (Object.keys(branches[i]).length === 0) {
        delete branches[i - 1][segments[i - 1]];
      }
    }
  }
  return next as FounderPageTokens;
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
      if (typeof value !== "number") continue;
      if (key === "lineHeight") {
        style[KPI_CSS_VARS[key]] = (value / 100).toFixed(2);
      } else {
        style[KPI_CSS_VARS[key]] = `${value}px`;
      }
    }
    // Legacy readers (and the founder-design check) look for
    // --tbbt-kpi-padding. When only paddingY is set, alias it.
    if (typeof tokens.kpi.padding !== "number" && typeof tokens.kpi.paddingY === "number") {
      style[KPI_CSS_VARS.padding] = `${tokens.kpi.paddingY}px`;
    }
  }

  if (tokens.tableDensity) {
    const density = tableDensityPx(pageKey, tokens.tableDensity);
    style[TABLE_CSS_VARS.rowPy] = `${density.rowPy}px`;
    style[TABLE_CSS_VARS.headerPy] = `${density.headerPy}px`;
  }
  if (typeof tokens.tableCellPx === "number") {
    style[TABLE_CSS_VARS.cellPx] = `${tokens.tableCellPx}px`;
  }
  if (typeof tokens.tableFontSize === "number") {
    style[TABLE_CSS_VARS.fontSize] = `${tokens.tableFontSize}px`;
  }
  if (typeof tokens.tableHeaderFontSize === "number") {
    style[TABLE_CSS_VARS.headerFontSize] = `${tokens.tableHeaderFontSize}px`;
  }

  if (typeof tokens.sectionGap === "number") {
    style[SECTION_GAP_CSS_VAR] = `${tokens.sectionGap}px`;
  }

  if (typeof tokens.panelWidth === "number") {
    style[PANEL_WIDTH_CSS_VAR] = `${tokens.panelWidth}px`;
  }

  return style as CSSProperties;
}

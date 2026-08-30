/**
 * Founder Design Mode V2 -- per-page visual region registry.
 *
 * Each supported page lists only the REAL major boxes already rendered
 * on that page. Labels are human-readable and page-specific -- Dashboard
 * names are never reused on other pages. The drawer "Editing" selector
 * is driven from this list; it never fabricates a panel that does not
 * exist in the page's JSX.
 */
import type { FounderPageKey } from "@/lib/founder-design";
import type { CuratedIconId } from "@/lib/founder-icons";

export type FounderRegionKind = "kpi" | "panel" | "table" | "tabs" | "page";

export type FounderRegionDef = {
  id: string;
  label: string;
  kind: FounderRegionKind;
  hasTitle?: boolean;
  hasBody?: boolean;
  hasButtons?: boolean;
  hasIcon?: boolean;
  /** Desktop rail / details-panel width already expressed as --tbbt-panel-width. */
  hasWidth?: boolean;
  defaultIcon?: CuratedIconId;
};

export const FOUNDER_REGIONS: Record<FounderPageKey, readonly FounderRegionDef[]> = {
  dashboard: [
    { id: "kpi", label: "Top KPI Cards", kind: "kpi" },
    { id: "attention", label: "Needs Attention", kind: "panel", hasTitle: true, hasBody: true, hasButtons: true },
    {
      id: "today",
      label: "Today",
      kind: "panel",
      hasTitle: true,
      hasBody: true,
      hasButtons: true,
      hasIcon: true,
      defaultIcon: "calendar-clock",
    },
    {
      id: "actions",
      label: "Quick Actions",
      kind: "panel",
      hasTitle: true,
      hasButtons: true,
      hasIcon: true,
      defaultIcon: "sparkles",
    },
    { id: "recent", label: "Recent Activity", kind: "panel", hasTitle: true, hasBody: true },
    { id: "page", label: "Page Spacing", kind: "page" },
  ],
  requests: [
    { id: "kpi", label: "Top KPI Cards", kind: "kpi" },
    { id: "tabs", label: "Status Tabs & Filters", kind: "tabs", hasTitle: true },
    { id: "table", label: "Request Table", kind: "table" },
    {
      id: "details",
      label: "Request Details",
      kind: "panel",
      hasTitle: true,
      hasBody: true,
      hasButtons: true,
      hasWidth: true,
    },
    {
      id: "calendar",
      label: "Schedule & Calendar",
      kind: "panel",
      hasTitle: true,
      hasIcon: true,
      defaultIcon: "calendar-days",
    },
    {
      id: "today",
      label: "Today",
      kind: "panel",
      hasTitle: true,
      hasBody: true,
      hasButtons: true,
      hasIcon: true,
      defaultIcon: "calendar-clock",
    },
    {
      id: "actions",
      label: "Quick Actions",
      kind: "panel",
      hasTitle: true,
      hasButtons: true,
      hasIcon: true,
      defaultIcon: "sparkles",
    },
    { id: "page", label: "Page Spacing", kind: "page" },
  ],
  customers: [
    { id: "table", label: "Customer Table", kind: "table" },
    { id: "overview", label: "Customer Overview", kind: "kpi", hasTitle: true },
    { id: "activity", label: "Recent Activity", kind: "panel", hasTitle: true, hasBody: true },
    {
      id: "services",
      label: "Top Services",
      kind: "panel",
      hasTitle: true,
      hasBody: true,
      hasIcon: true,
      defaultIcon: "wrench",
    },
    { id: "rail", label: "Right Rail Width", kind: "page", hasWidth: true },
    { id: "page", label: "Page Spacing", kind: "page" },
  ],
  estimates: [
    { id: "kpi", label: "Top KPI Cards", kind: "kpi" },
    { id: "tabs", label: "Status Tabs & Filters", kind: "tabs", hasTitle: true },
    { id: "table", label: "Estimate Table", kind: "table" },
    {
      id: "details",
      label: "Estimate Details",
      kind: "panel",
      hasTitle: true,
      hasBody: true,
      hasButtons: true,
      hasWidth: true,
    },
    { id: "page", label: "Page Spacing", kind: "page" },
  ],
  jobs: [
    { id: "kpi", label: "Top KPI Cards", kind: "kpi" },
    { id: "calendar", label: "Calendar", kind: "panel", hasTitle: true },
    { id: "tabs", label: "Status Tabs & Filters", kind: "tabs", hasTitle: true },
    { id: "table", label: "Job Table", kind: "table" },
    {
      id: "details",
      label: "Job Details",
      kind: "panel",
      hasTitle: true,
      hasBody: true,
      hasButtons: true,
      hasWidth: true,
    },
    { id: "page", label: "Page Spacing", kind: "page" },
  ],
  invoices: [
    { id: "kpi", label: "Top KPI Cards", kind: "kpi" },
    { id: "tabs", label: "Status Tabs & Filters", kind: "tabs", hasTitle: true },
    { id: "table", label: "Invoice Table", kind: "table" },
    {
      id: "details",
      label: "Invoice Details",
      kind: "panel",
      hasTitle: true,
      hasBody: true,
      hasButtons: true,
      hasWidth: true,
    },
    { id: "page", label: "Page Spacing", kind: "page" },
  ],
  services: [
    { id: "kpi", label: "Top Summary", kind: "kpi" },
    {
      id: "presentation",
      label: "Service Presentation",
      kind: "panel",
      hasTitle: true,
      hasBody: true,
    },
    {
      id: "pricing",
      label: "Pricing Intelligence / Service Details",
      kind: "panel",
      hasTitle: true,
      hasBody: true,
      hasButtons: true,
    },
    {
      id: "catalog",
      label: "Service Catalog",
      kind: "panel",
      hasTitle: true,
      hasBody: true,
      hasWidth: true,
    },
    { id: "page", label: "Page Spacing", kind: "page" },
  ],
};

export function getFounderRegions(pageKey: FounderPageKey): readonly FounderRegionDef[] {
  return FOUNDER_REGIONS[pageKey];
}

export function getFounderRegion(pageKey: FounderPageKey, regionId: string): FounderRegionDef | undefined {
  return FOUNDER_REGIONS[pageKey].find((region) => region.id === regionId);
}

export function isFounderRegionId(pageKey: FounderPageKey, regionId: string): boolean {
  return FOUNDER_REGIONS[pageKey].some((region) => region.id === regionId);
}

export function defaultFounderRegionId(pageKey: FounderPageKey): string {
  return FOUNDER_REGIONS[pageKey][0]?.id ?? "page";
}

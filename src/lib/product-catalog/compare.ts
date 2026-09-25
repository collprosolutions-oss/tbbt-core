/**
 * Pricing comparison rows. Values are catalog facts, not UI strings
 * invented in the page component.
 *
 * "Trade Availability" is plan public status, not a software capability.
 */
import { PRODUCT_CAPABILITY_DEFINITIONS } from "@/lib/product-catalog/capabilities";
import {
  PLAN_CODES,
  PLAN_PUBLIC_STATUSES,
  PRODUCT_CAPABILITIES,
  type PlanCode,
  type ProductCapabilityCode,
} from "@/lib/product-catalog/codes";
import { planIncludesCapability, PLAN_DEFINITIONS } from "@/lib/product-catalog/plans";

export type CompareCellValue = "check" | "dash" | string;

export type PricingCompareRow = {
  id: string;
  label: string;
  kind: "PLAN_STATUS" | "CAPABILITY";
  capability?: ProductCapabilityCode;
  values: readonly [CompareCellValue, CompareCellValue, CompareCellValue, CompareCellValue];
};

const COMPARE_PLAN_ORDER = [
  PLAN_CODES.STARTER,
  PLAN_CODES.FOUNDER,
  PLAN_CODES.BUSINESS,
  PLAN_CODES.ENTERPRISE,
] as const;

function publicStatusLabel(code: PlanCode): string {
  const status = PLAN_DEFINITIONS[code].publicStatus;
  if (status === PLAN_PUBLIC_STATUSES.LIVE) return "Available Now";
  if (status === PLAN_PUBLIC_STATUSES.PLANNED) return "Planned";
  return "Coming Soon";
}

function capabilityCells(capability: ProductCapabilityCode): PricingCompareRow["values"] {
  return COMPARE_PLAN_ORDER.map((code) =>
    planIncludesCapability(code, capability) ? "check" : "dash",
  ) as unknown as PricingCompareRow["values"];
}

export const PRICING_COMPARE_ROWS: readonly PricingCompareRow[] = [
  {
    id: "trade-availability",
    label: "Trade Availability",
    kind: "PLAN_STATUS",
    values: [
      publicStatusLabel(PLAN_CODES.STARTER),
      publicStatusLabel(PLAN_CODES.FOUNDER),
      publicStatusLabel(PLAN_CODES.BUSINESS),
      publicStatusLabel(PLAN_CODES.ENTERPRISE),
    ],
  },
  {
    id: "website-builder",
    label: PRODUCT_CAPABILITY_DEFINITIONS[PRODUCT_CAPABILITIES.WEBSITE_BUILDER].displayName,
    kind: "CAPABILITY",
    capability: PRODUCT_CAPABILITIES.WEBSITE_BUILDER,
    values: capabilityCells(PRODUCT_CAPABILITIES.WEBSITE_BUILDER),
  },
  {
    id: "crm",
    label: PRODUCT_CAPABILITY_DEFINITIONS[PRODUCT_CAPABILITIES.CRM].displayName,
    kind: "CAPABILITY",
    capability: PRODUCT_CAPABILITIES.CRM,
    values: capabilityCells(PRODUCT_CAPABILITIES.CRM),
  },
  {
    id: "scheduling",
    label: PRODUCT_CAPABILITY_DEFINITIONS[PRODUCT_CAPABILITIES.SCHEDULING].displayName,
    kind: "CAPABILITY",
    capability: PRODUCT_CAPABILITIES.SCHEDULING,
    values: capabilityCells(PRODUCT_CAPABILITIES.SCHEDULING),
  },
  {
    id: "estimates-invoices",
    label: PRODUCT_CAPABILITY_DEFINITIONS[PRODUCT_CAPABILITIES.ESTIMATES_INVOICES].displayName,
    kind: "CAPABILITY",
    capability: PRODUCT_CAPABILITIES.ESTIMATES_INVOICES,
    values: capabilityCells(PRODUCT_CAPABILITIES.ESTIMATES_INVOICES),
  },
  {
    id: "time-tracking",
    label: PRODUCT_CAPABILITY_DEFINITIONS[PRODUCT_CAPABILITIES.TIME_TRACKING].displayName,
    kind: "CAPABILITY",
    capability: PRODUCT_CAPABILITIES.TIME_TRACKING,
    values: capabilityCells(PRODUCT_CAPABILITIES.TIME_TRACKING),
  },
  {
    id: "jobs",
    label: PRODUCT_CAPABILITY_DEFINITIONS[PRODUCT_CAPABILITIES.JOBS_TASKS].displayName,
    kind: "CAPABILITY",
    capability: PRODUCT_CAPABILITIES.JOBS_TASKS,
    values: capabilityCells(PRODUCT_CAPABILITIES.JOBS_TASKS),
  },
  {
    id: "team",
    label: PRODUCT_CAPABILITY_DEFINITIONS[PRODUCT_CAPABILITIES.TEAM_MANAGEMENT].displayName,
    kind: "CAPABILITY",
    capability: PRODUCT_CAPABILITIES.TEAM_MANAGEMENT,
    values: capabilityCells(PRODUCT_CAPABILITIES.TEAM_MANAGEMENT),
  },
  {
    id: "marketing",
    label: PRODUCT_CAPABILITY_DEFINITIONS[PRODUCT_CAPABILITIES.MARKETING_TOOLS].displayName,
    kind: "CAPABILITY",
    capability: PRODUCT_CAPABILITIES.MARKETING_TOOLS,
    values: capabilityCells(PRODUCT_CAPABILITIES.MARKETING_TOOLS),
  },
  {
    id: "reporting",
    label: PRODUCT_CAPABILITY_DEFINITIONS[PRODUCT_CAPABILITIES.REPORTING_INSIGHTS].displayName,
    kind: "CAPABILITY",
    capability: PRODUCT_CAPABILITIES.REPORTING_INSIGHTS,
    values: capabilityCells(PRODUCT_CAPABILITIES.REPORTING_INSIGHTS),
  },
  {
    id: "client-portal",
    label: PRODUCT_CAPABILITY_DEFINITIONS[PRODUCT_CAPABILITIES.CLIENT_PORTAL].displayName,
    kind: "CAPABILITY",
    capability: PRODUCT_CAPABILITIES.CLIENT_PORTAL,
    values: capabilityCells(PRODUCT_CAPABILITIES.CLIENT_PORTAL),
  },
  {
    id: "multi-location",
    label: PRODUCT_CAPABILITY_DEFINITIONS[PRODUCT_CAPABILITIES.MULTI_LOCATION].displayName,
    kind: "CAPABILITY",
    capability: PRODUCT_CAPABILITIES.MULTI_LOCATION,
    values: capabilityCells(PRODUCT_CAPABILITIES.MULTI_LOCATION),
  },
  {
    id: "integrations-white-label",
    label: "Custom Integrations / White Label",
    kind: "CAPABILITY",
    capability: PRODUCT_CAPABILITIES.CUSTOM_INTEGRATIONS,
    values: capabilityCells(PRODUCT_CAPABILITIES.CUSTOM_INTEGRATIONS),
  },
];

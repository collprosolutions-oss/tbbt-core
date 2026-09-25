/**
 * Authoritative TBBT product plans.
 *
 * Inheritance is one-way (Enterprise → Business → Founder) and never
 * circular. Limits are defined per plan and are not inherited, so
 * Starter's approved 1-trade cap cannot leak onto Founder.
 *
 * Checkout eligibility is a catalog fact. Public purchasability also
 * requires LIVE status plus an approved, configured provider price.
 */
import { TBBT_SAAS_PLAN_NAME as FOUNDER_PLAN_DISPLAY_NAME } from "@/lib/saas-billing/config";
import {
  TBBT_FOUNDER_PLAN_AMOUNT_CENTS,
  TBBT_FOUNDER_PLAN_CURRENCY,
  TBBT_FOUNDER_PLAN_INTERVAL,
  TBBT_FOUNDER_PLAN_PRICE_LABEL,
} from "@/lib/saas-billing/founder-price";
import {
  PLAN_CODES,
  PLAN_CODE_LIST,
  PLAN_PUBLIC_STATUSES,
  PRODUCT_CAPABILITIES,
  PRODUCT_LIMITS,
  type PlanCode,
  type PlanPublicStatus,
  type ProductCapabilityCode,
  type ProductLimitCode,
} from "@/lib/product-catalog/codes";

export type PlanServiceLevel = {
  code: string;
  displayName: string;
  kind: "SUPPORT" | "ACCOUNT" | "DEVELOPMENT";
};

export type PlanCardFeature = {
  label: string;
  kind: "CAPABILITY" | "LIMIT" | "SERVICE" | "INHERITANCE" | "SETUP";
  capability?: ProductCapabilityCode;
  limit?: ProductLimitCode;
  liveSoftware: boolean;
};

export type PlanDefinition = {
  code: PlanCode;
  displayName: string;
  tagline: string;
  publicStatus: PlanPublicStatus;
  publicDescription: string;
  /** True when the commercial offer is approved for checkout once a price exists. */
  checkoutEligible: boolean;
  stripePriceEnvKeys: readonly string[];
  approvedDisplayPrice: {
    amountCents: number;
    currency: string;
    interval: string;
    label: string;
  } | null;
  includesPlans: readonly PlanCode[];
  capabilities: readonly ProductCapabilityCode[];
  limits: Partial<Record<ProductLimitCode, number | null>>;
  cardFeatures: readonly PlanCardFeature[];
  serviceLevels: readonly PlanServiceLevel[];
};

const STARTER_CAPABILITIES = [
  PRODUCT_CAPABILITIES.WEBSITE_BUILDER,
  PRODUCT_CAPABILITIES.CRM,
  PRODUCT_CAPABILITIES.SCHEDULING,
  PRODUCT_CAPABILITIES.ESTIMATES_INVOICES,
  PRODUCT_CAPABILITIES.TIME_TRACKING,
  PRODUCT_CAPABILITIES.MOBILE_ACCESS,
] as const;

const FOUNDER_CAPABILITIES = [
  ...STARTER_CAPABILITIES,
  PRODUCT_CAPABILITIES.CUSTOMER_REQUEST_INTAKE,
  PRODUCT_CAPABILITIES.JOBS_TASKS,
  PRODUCT_CAPABILITIES.TEAM_MANAGEMENT,
  PRODUCT_CAPABILITIES.MARKETING_TOOLS,
  PRODUCT_CAPABILITIES.REPORTING_INSIGHTS,
  PRODUCT_CAPABILITIES.MULTI_TRADE,
] as const;

const BUSINESS_OWN_CAPABILITIES = [
  PRODUCT_CAPABILITIES.MULTI_LOCATION,
  PRODUCT_CAPABILITIES.ADVANCED_REPORTING,
  PRODUCT_CAPABILITIES.CLIENT_PORTAL,
  PRODUCT_CAPABILITIES.DOCUMENT_STORAGE,
  PRODUCT_CAPABILITIES.EXPANDED_TEAM_ROLES,
] as const;

const ENTERPRISE_OWN_CAPABILITIES = [
  PRODUCT_CAPABILITIES.CUSTOM_INTEGRATIONS,
  PRODUCT_CAPABILITIES.ADVANCED_AUTOMATION,
  PRODUCT_CAPABILITIES.WHITE_LABEL,
] as const;

export const PLAN_DEFINITIONS: Record<PlanCode, PlanDefinition> = {
  [PLAN_CODES.STARTER]: {
    code: PLAN_CODES.STARTER,
    displayName: "Starter",
    tagline: "Perfect for getting started",
    publicStatus: PLAN_PUBLIC_STATUSES.COMING_SOON,
    publicDescription: "Core operating tools for a single trade. Not purchasable until an approved price is configured and the plan is marked LIVE.",
    checkoutEligible: false,
    stripePriceEnvKeys: ["STRIPE_SAAS_PRICE_ID_STARTER"],
    approvedDisplayPrice: null,
    includesPlans: [],
    capabilities: STARTER_CAPABILITIES,
    limits: {
      [PRODUCT_LIMITS.TRADES]: 1,
      [PRODUCT_LIMITS.USERS]: null,
      [PRODUCT_LIMITS.STORAGE_BYTES]: null,
      [PRODUCT_LIMITS.LOCATIONS]: null,
    },
    cardFeatures: [
      { label: "1 Trade / Industry", kind: "LIMIT", limit: PRODUCT_LIMITS.TRADES, liveSoftware: true },
      { label: "Website Builder", kind: "CAPABILITY", capability: PRODUCT_CAPABILITIES.WEBSITE_BUILDER, liveSoftware: true },
      { label: "Basic CRM", kind: "CAPABILITY", capability: PRODUCT_CAPABILITIES.CRM, liveSoftware: true },
      { label: "Scheduling & Calendar", kind: "CAPABILITY", capability: PRODUCT_CAPABILITIES.SCHEDULING, liveSoftware: true },
      { label: "Estimates & Invoices", kind: "CAPABILITY", capability: PRODUCT_CAPABILITIES.ESTIMATES_INVOICES, liveSoftware: true },
      { label: "Time Tracking", kind: "CAPABILITY", capability: PRODUCT_CAPABILITIES.TIME_TRACKING, liveSoftware: true },
      { label: "Mobile Access", kind: "CAPABILITY", capability: PRODUCT_CAPABILITIES.MOBILE_ACCESS, liveSoftware: false },
    ],
    serviceLevels: [],
  },
  [PLAN_CODES.FOUNDER]: {
    code: PLAN_CODES.FOUNDER,
    displayName: FOUNDER_PLAN_DISPLAY_NAME,
    tagline: "Built for growing businesses",
    publicStatus: PLAN_PUBLIC_STATUSES.LIVE,
    publicDescription:
      "The currently approved TBBT offer. $49/month while a continuous Founder subscription remains eligible.",
    checkoutEligible: true,
    stripePriceEnvKeys: ["STRIPE_SAAS_PRICE_ID"],
    approvedDisplayPrice: {
      amountCents: TBBT_FOUNDER_PLAN_AMOUNT_CENTS,
      currency: TBBT_FOUNDER_PLAN_CURRENCY,
      interval: TBBT_FOUNDER_PLAN_INTERVAL,
      label: TBBT_FOUNDER_PLAN_PRICE_LABEL,
    },
    includesPlans: [],
    capabilities: FOUNDER_CAPABILITIES,
    limits: {
      [PRODUCT_LIMITS.TRADES]: null,
      [PRODUCT_LIMITS.USERS]: null,
      [PRODUCT_LIMITS.STORAGE_BYTES]: null,
      [PRODUCT_LIMITS.LOCATIONS]: null,
    },
    cardFeatures: [
      { label: "Handyman starting setup", kind: "SETUP", liveSoftware: true },
      { label: "Public business website", kind: "CAPABILITY", capability: PRODUCT_CAPABILITIES.WEBSITE_BUILDER, liveSoftware: true },
      { label: "Customer request intake", kind: "CAPABILITY", capability: PRODUCT_CAPABILITIES.CUSTOMER_REQUEST_INTAKE, liveSoftware: true },
      { label: "Customers / CRM", kind: "CAPABILITY", capability: PRODUCT_CAPABILITIES.CRM, liveSoftware: true },
      { label: "Scheduling", kind: "CAPABILITY", capability: PRODUCT_CAPABILITIES.SCHEDULING, liveSoftware: true },
      { label: "Estimates", kind: "CAPABILITY", capability: PRODUCT_CAPABILITIES.ESTIMATES_INVOICES, liveSoftware: true },
      { label: "Jobs", kind: "CAPABILITY", capability: PRODUCT_CAPABILITIES.JOBS_TASKS, liveSoftware: true },
      { label: "Invoices", kind: "CAPABILITY", capability: PRODUCT_CAPABILITIES.ESTIMATES_INVOICES, liveSoftware: true },
      { label: "Team management", kind: "CAPABILITY", capability: PRODUCT_CAPABILITIES.TEAM_MANAGEMENT, liveSoftware: true },
      { label: "Reports and business insights", kind: "CAPABILITY", capability: PRODUCT_CAPABILITIES.REPORTING_INSIGHTS, liveSoftware: true },
    ],
    serviceLevels: [],
  },
  [PLAN_CODES.BUSINESS]: {
    code: PLAN_CODES.BUSINESS,
    displayName: "Business",
    tagline: "For established companies",
    publicStatus: PLAN_PUBLIC_STATUSES.COMING_SOON,
    publicDescription:
      "Everything in Founder plus multi-location, advanced reporting, client portal, document storage, and expanded roles. Not purchasable until an approved price is configured and the plan is marked LIVE.",
    checkoutEligible: false,
    stripePriceEnvKeys: ["STRIPE_SAAS_PRICE_ID_BUSINESS"],
    approvedDisplayPrice: null,
    includesPlans: [PLAN_CODES.FOUNDER],
    capabilities: BUSINESS_OWN_CAPABILITIES,
    limits: {
      [PRODUCT_LIMITS.TRADES]: null,
      [PRODUCT_LIMITS.USERS]: null,
      [PRODUCT_LIMITS.STORAGE_BYTES]: null,
      [PRODUCT_LIMITS.LOCATIONS]: null,
    },
    cardFeatures: [
      { label: "More trades", kind: "LIMIT", limit: PRODUCT_LIMITS.TRADES, liveSoftware: true },
      { label: "Everything in Founder", kind: "INHERITANCE", liveSoftware: true },
      { label: "Multi-Location Support", kind: "CAPABILITY", capability: PRODUCT_CAPABILITIES.MULTI_LOCATION, liveSoftware: false },
      { label: "Advanced Reporting", kind: "CAPABILITY", capability: PRODUCT_CAPABILITIES.ADVANCED_REPORTING, liveSoftware: false },
      { label: "Client Portal", kind: "CAPABILITY", capability: PRODUCT_CAPABILITIES.CLIENT_PORTAL, liveSoftware: false },
      { label: "Document Storage", kind: "CAPABILITY", capability: PRODUCT_CAPABILITIES.DOCUMENT_STORAGE, liveSoftware: false },
      { label: "Expanded Team Roles & Permissions", kind: "CAPABILITY", capability: PRODUCT_CAPABILITIES.EXPANDED_TEAM_ROLES, liveSoftware: false },
      { label: "Priority Support", kind: "SERVICE", liveSoftware: false },
    ],
    serviceLevels: [
      { code: "PRIORITY_SUPPORT", displayName: "Priority Support", kind: "SUPPORT" },
    ],
  },
  [PLAN_CODES.ENTERPRISE]: {
    code: PLAN_CODES.ENTERPRISE,
    displayName: "Enterprise",
    tagline: "For larger operations",
    publicStatus: PLAN_PUBLIC_STATUSES.PLANNED,
    publicDescription:
      "Everything in Business plus custom integrations, advanced automation, and white-label options. Contact TBBT. Not purchasable until commercially approved.",
    checkoutEligible: false,
    stripePriceEnvKeys: ["STRIPE_SAAS_PRICE_ID_ENTERPRISE"],
    approvedDisplayPrice: null,
    includesPlans: [PLAN_CODES.BUSINESS],
    capabilities: ENTERPRISE_OWN_CAPABILITIES,
    limits: {
      [PRODUCT_LIMITS.TRADES]: null,
      [PRODUCT_LIMITS.USERS]: null,
      [PRODUCT_LIMITS.STORAGE_BYTES]: null,
      [PRODUCT_LIMITS.LOCATIONS]: null,
    },
    cardFeatures: [
      { label: "Expanded trade support", kind: "LIMIT", limit: PRODUCT_LIMITS.TRADES, liveSoftware: true },
      { label: "Everything in Business", kind: "INHERITANCE", liveSoftware: true },
      { label: "Custom Integrations", kind: "CAPABILITY", capability: PRODUCT_CAPABILITIES.CUSTOM_INTEGRATIONS, liveSoftware: false },
      { label: "Advanced Automation", kind: "CAPABILITY", capability: PRODUCT_CAPABILITIES.ADVANCED_AUTOMATION, liveSoftware: false },
      { label: "White Label Options", kind: "CAPABILITY", capability: PRODUCT_CAPABILITIES.WHITE_LABEL, liveSoftware: false },
      { label: "Dedicated Account Support", kind: "SERVICE", liveSoftware: false },
      { label: "Priority Development Requests", kind: "SERVICE", liveSoftware: false },
      { label: "Highest Priority Support", kind: "SERVICE", liveSoftware: false },
    ],
    serviceLevels: [
      { code: "DEDICATED_ACCOUNT_SUPPORT", displayName: "Dedicated Account Support", kind: "ACCOUNT" },
      { code: "PRIORITY_DEVELOPMENT", displayName: "Priority Development Requests", kind: "DEVELOPMENT" },
      { code: "HIGHEST_PRIORITY_SUPPORT", displayName: "Highest Priority Support", kind: "SUPPORT" },
    ],
  },
};

function collectInheritedCapabilities(
  code: PlanCode,
  seen: Set<PlanCode> = new Set(),
): Set<ProductCapabilityCode> {
  if (seen.has(code)) {
    throw new Error(`Circular plan definition: ${code}`);
  }
  seen.add(code);
  const plan = PLAN_DEFINITIONS[code];
  const caps = new Set<ProductCapabilityCode>(plan.capabilities);
  for (const parent of plan.includesPlans) {
    for (const capability of collectInheritedCapabilities(parent, new Set(seen))) {
      caps.add(capability);
    }
  }
  return caps;
}

const PLAN_CAPABILITY_CACHE = new Map<PlanCode, ReadonlySet<ProductCapabilityCode>>();

export function getPlanDefinition(code: PlanCode): PlanDefinition {
  return PLAN_DEFINITIONS[code];
}

export function listPlanDefinitions(): PlanDefinition[] {
  return PLAN_CODE_LIST.map((code) => PLAN_DEFINITIONS[code]);
}

export function resolvePlanCapabilities(code: PlanCode): ReadonlySet<ProductCapabilityCode> {
  const cached = PLAN_CAPABILITY_CACHE.get(code);
  if (cached) return cached;
  const resolved = collectInheritedCapabilities(code);
  PLAN_CAPABILITY_CACHE.set(code, resolved);
  return resolved;
}

export function planIncludesCapability(code: PlanCode, capability: ProductCapabilityCode) {
  return resolvePlanCapabilities(code).has(capability);
}

export function resolvePlanLimit(
  code: PlanCode,
  limit: ProductLimitCode,
): number | null {
  const value = PLAN_DEFINITIONS[code].limits[limit];
  return value === undefined ? null : value;
}

export function assertPlanDefinitionsAcyclic() {
  for (const code of PLAN_CODE_LIST) {
    collectInheritedCapabilities(code);
  }
}

export { FOUNDER_PLAN_DISPLAY_NAME, TBBT_FOUNDER_PLAN_PRICE_LABEL };

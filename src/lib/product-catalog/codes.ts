/**
 * Stable commercial identities. Display text is never identity.
 *
 * Plan codes, add-on codes, product capabilities, and limit codes live
 * here so marketing, billing, checkout, and enforcement cannot drift.
 *
 * Role capabilities in authorization.ts are a different namespace.
 * A plan never grants a role permission.
 */

export const PLAN_CODES = {
  STARTER: "STARTER",
  FOUNDER: "FOUNDER",
  BUSINESS: "BUSINESS",
  ENTERPRISE: "ENTERPRISE",
} as const;

export type PlanCode = (typeof PLAN_CODES)[keyof typeof PLAN_CODES];

export const PLAN_CODE_LIST = [
  PLAN_CODES.STARTER,
  PLAN_CODES.FOUNDER,
  PLAN_CODES.BUSINESS,
  PLAN_CODES.ENTERPRISE,
] as const;

/**
 * Historical Stripe / settings identity for the live Founder offer.
 * New rows store FOUNDER. Resolvers accept this alias.
 */
export const LEGACY_FOUNDER_PLAN_CODE = "tbbt_founder";

export const PLAN_CODE_ALIASES: Record<string, PlanCode> = {
  [LEGACY_FOUNDER_PLAN_CODE]: PLAN_CODES.FOUNDER,
  founder: PLAN_CODES.FOUNDER,
  starter: PLAN_CODES.STARTER,
  business: PLAN_CODES.BUSINESS,
  enterprise: PLAN_CODES.ENTERPRISE,
};

export const PLAN_PUBLIC_STATUSES = {
  LIVE: "LIVE",
  COMING_SOON: "COMING_SOON",
  PLANNED: "PLANNED",
} as const;

export type PlanPublicStatus =
  (typeof PLAN_PUBLIC_STATUSES)[keyof typeof PLAN_PUBLIC_STATUSES];

export const ADDON_CODES = {
  ADDITIONAL_TRADE: "ADDITIONAL_TRADE",
  SMS_MESSAGING: "SMS_MESSAGING",
  AI_BUSINESS_COACH: "AI_BUSINESS_COACH",
  ADDITIONAL_USERS: "ADDITIONAL_USERS",
  EXTRA_STORAGE: "EXTRA_STORAGE",
  BUSINESS_EMAIL: "BUSINESS_EMAIL",
} as const;

export type AddonCode = (typeof ADDON_CODES)[keyof typeof ADDON_CODES];

export const ADDON_CODE_LIST = [
  ADDON_CODES.ADDITIONAL_TRADE,
  ADDON_CODES.SMS_MESSAGING,
  ADDON_CODES.AI_BUSINESS_COACH,
  ADDON_CODES.ADDITIONAL_USERS,
  ADDON_CODES.EXTRA_STORAGE,
  ADDON_CODES.BUSINESS_EMAIL,
] as const;

export const PRODUCT_CAPABILITIES = {
  WEBSITE_BUILDER: "WEBSITE_BUILDER",
  CRM: "CRM",
  CUSTOMER_REQUEST_INTAKE: "CUSTOMER_REQUEST_INTAKE",
  SCHEDULING: "SCHEDULING",
  ESTIMATES_INVOICES: "ESTIMATES_INVOICES",
  TIME_TRACKING: "TIME_TRACKING",
  JOBS_TASKS: "JOBS_TASKS",
  TEAM_MANAGEMENT: "TEAM_MANAGEMENT",
  MARKETING_TOOLS: "MARKETING_TOOLS",
  REPORTING_INSIGHTS: "REPORTING_INSIGHTS",
  CLIENT_PORTAL: "CLIENT_PORTAL",
  MULTI_TRADE: "MULTI_TRADE",
  MULTI_LOCATION: "MULTI_LOCATION",
  DOCUMENT_STORAGE: "DOCUMENT_STORAGE",
  ADVANCED_REPORTING: "ADVANCED_REPORTING",
  EXPANDED_TEAM_ROLES: "EXPANDED_TEAM_ROLES",
  CUSTOM_INTEGRATIONS: "CUSTOM_INTEGRATIONS",
  ADVANCED_AUTOMATION: "ADVANCED_AUTOMATION",
  WHITE_LABEL: "WHITE_LABEL",
  SMS_MESSAGING: "SMS_MESSAGING",
  AI_BUSINESS_COACH: "AI_BUSINESS_COACH",
  EXTRA_STORAGE: "EXTRA_STORAGE",
  BUSINESS_EMAIL: "BUSINESS_EMAIL",
  MOBILE_ACCESS: "MOBILE_ACCESS",
} as const;

export type ProductCapabilityCode =
  (typeof PRODUCT_CAPABILITIES)[keyof typeof PRODUCT_CAPABILITIES];

export const PRODUCT_CAPABILITY_LIST = Object.values(PRODUCT_CAPABILITIES);

export const CAPABILITY_IMPLEMENTATION_STATUSES = {
  LIVE: "LIVE",
  PARTIAL: "PARTIAL",
  COMING_SOON: "COMING_SOON",
  PLANNED: "PLANNED",
} as const;

export type CapabilityImplementationStatus =
  (typeof CAPABILITY_IMPLEMENTATION_STATUSES)[keyof typeof CAPABILITY_IMPLEMENTATION_STATUSES];

export const PRODUCT_LIMITS = {
  TRADES: "TRADES",
  USERS: "USERS",
  STORAGE_BYTES: "STORAGE_BYTES",
  LOCATIONS: "LOCATIONS",
} as const;

export type ProductLimitCode = (typeof PRODUCT_LIMITS)[keyof typeof PRODUCT_LIMITS];

export const PRODUCT_LIMIT_LIST = Object.values(PRODUCT_LIMITS);

export const ADDON_STATUSES = {
  ACTIVE: "ACTIVE",
  INACTIVE: "INACTIVE",
} as const;

export type AddonStatus = (typeof ADDON_STATUSES)[keyof typeof ADDON_STATUSES];

export const PRODUCT_GRANT_TYPES = {
  CAPABILITY: "CAPABILITY",
  LIMIT: "LIMIT",
} as const;

export type ProductGrantType =
  (typeof PRODUCT_GRANT_TYPES)[keyof typeof PRODUCT_GRANT_TYPES];

export const PRODUCT_GRANT_SOURCES = {
  SUPPORT: "SUPPORT",
  GRANDFATHER: "GRANDFATHER",
  MANUAL: "MANUAL",
} as const;

export const ADDON_SOURCES = {
  PROVIDER: "PROVIDER",
  SUPPORT: "SUPPORT",
  MANUAL: "MANUAL",
} as const;

export function isPlanCode(value: string | null | undefined): value is PlanCode {
  return PLAN_CODE_LIST.includes((value ?? "") as PlanCode);
}

export function isAddonCode(value: string | null | undefined): value is AddonCode {
  return ADDON_CODE_LIST.includes((value ?? "") as AddonCode);
}

export function isProductCapabilityCode(
  value: string | null | undefined,
): value is ProductCapabilityCode {
  return PRODUCT_CAPABILITY_LIST.includes((value ?? "") as ProductCapabilityCode);
}

export function canonicalizePlanCode(value: string | null | undefined): PlanCode | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (isPlanCode(trimmed)) return trimmed;
  const aliased = PLAN_CODE_ALIASES[trimmed] ?? PLAN_CODE_ALIASES[trimmed.toLowerCase()];
  return aliased ?? null;
}

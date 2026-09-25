/**
 * Trade Definition / Trade Configuration boundary.
 *
 * Capabilities and defaults live here so UI and actions do not scatter
 * trade-equality branches in UI or actions. A business may hold multiple active
 * trades under one identity; each trade keeps its own configuration.
 */

import { currentIntakeSchema, type IntakeSchema } from "@/lib/intake-schema";
import {
  parsePricingMode,
  type PricingMode,
} from "@/lib/pricing-mode";
import {
  DEFAULT_TRADE,
  TRADE_CODES,
  isConfiguredTrade,
  tradeLabel,
  type TradeCode,
} from "@/lib/trades";

export const CATALOG_STARTER_SOURCES = [
  "HANDYMAN_STARTER",
  "CLEANING_STARTER",
  "NONE",
] as const;
export type CatalogStarterSource = (typeof CATALOG_STARTER_SOURCES)[number];

export const PUBLIC_PRICING_BEHAVIORS = [
  "SHOW_PRICE",
  "SHOW_STARTING_AT",
  "REQUEST_QUOTE",
] as const;
export type PublicPricingBehavior = (typeof PUBLIC_PRICING_BEHAVIORS)[number];

export type TradeServiceTerminology = {
  request: string;
  job: string;
  estimate: string;
  catalog: string;
  customer: string;
};

export type TradeCustomerLanguage = {
  requestTitle: string;
  requestDescription: string;
  requestCta: string;
  emptyCatalogHint: string;
};

export type TradeSchedulingDefaults = {
  defaultDurationMinutes: number;
  defaultServiceIntent: "ONE_TIME" | "RECURRING";
  recurrenceSupported: boolean;
};

export type TradeConfiguration = {
  tradeCode: TradeCode;
  label: string;
  customerFacingLabel: string;
  allowedPricingModes: PricingMode[];
  defaultPricingMode: PricingMode;
  publicPricingBehavior: PublicPricingBehavior;
  intakeSchema: IntakeSchema;
  measurementQuestions: boolean;
  serviceTerminology: TradeServiceTerminology;
  schedulingDefaults: TradeSchedulingDefaults;
  recurrenceSupport: boolean;
  catalogStarterSource: CatalogStarterSource;
  catalogCategories: readonly string[];
  customerLanguage: TradeCustomerLanguage;
};

export const HANDYMAN_TRADE_CONFIG: TradeConfiguration = {
  tradeCode: "HANDYMAN",
  label: "Handyman",
  customerFacingLabel: "Handyman",
  allowedPricingModes: ["FIXED", "STARTING_AT", "VARIABLE", "CUSTOM_QUOTE"],
  defaultPricingMode: "STARTING_AT",
  publicPricingBehavior: "SHOW_STARTING_AT",
  intakeSchema: currentIntakeSchema("HANDYMAN"),
  measurementQuestions: true,
  serviceTerminology: {
    request: "service request",
    job: "job",
    estimate: "estimate",
    catalog: "services",
    customer: "customer",
  },
  schedulingDefaults: {
    defaultDurationMinutes: 120,
    defaultServiceIntent: "ONE_TIME",
    recurrenceSupported: false,
  },
  recurrenceSupport: false,
  catalogStarterSource: "HANDYMAN_STARTER",
  catalogCategories: [
    "Doors & Locks",
    "Mounting & Hanging",
    "Walls & Drywall",
    "Trim & Carpentry",
    "Bathroom / Caulking / Accessories",
    "Furniture & Assembly",
    "Exterior Repairs",
    "Cabinets / Kitchen",
    "Fans & Fixtures",
    "Punch Lists / Small Jobs",
    "General Home Repairs",
  ],
  customerLanguage: {
    requestTitle: "Request Service",
    requestDescription: "Request one or more handyman tasks in a single visit request.",
    requestCta: "Request a Quote",
    emptyCatalogHint: "Describe the work if you do not see the right service.",
  },
};

export const CLEANING_TRADE_CONFIG: TradeConfiguration = {
  tradeCode: "CLEANING",
  label: "Cleaning",
  customerFacingLabel: "Cleaning",
  allowedPricingModes: ["FIXED", "STARTING_AT", "VARIABLE", "CUSTOM_QUOTE"],
  defaultPricingMode: "STARTING_AT",
  publicPricingBehavior: "SHOW_STARTING_AT",
  intakeSchema: currentIntakeSchema("CLEANING"),
  measurementQuestions: false,
  serviceTerminology: {
    request: "cleaning request",
    job: "cleaning visit",
    estimate: "quote",
    catalog: "cleaning services",
    customer: "customer",
  },
  schedulingDefaults: {
    defaultDurationMinutes: 180,
    defaultServiceIntent: "ONE_TIME",
    recurrenceSupported: true,
  },
  recurrenceSupport: true,
  catalogStarterSource: "CLEANING_STARTER",
  catalogCategories: [
    "Standard Cleaning",
    "Deep Cleaning",
    "Move-In / Move-Out",
    "Add-Ons",
    "Custom Cleaning",
  ],
  customerLanguage: {
    requestTitle: "Request Cleaning",
    requestDescription: "Tell us about the home and how often you would like it cleaned.",
    requestCta: "Request Cleaning",
    emptyCatalogHint: "Describe the cleaning if you do not see the right service.",
  },
};

const TRADE_CONFIGS: Record<TradeCode, TradeConfiguration> = {
  HANDYMAN: HANDYMAN_TRADE_CONFIG,
  CLEANING: CLEANING_TRADE_CONFIG,
};

export type TradeConfigOverrides = {
  defaultPricingMode?: PricingMode;
  publicPricingBehavior?: PublicPricingBehavior;
  customerLanguage?: Partial<TradeCustomerLanguage>;
  schedulingDefaults?: Partial<TradeSchedulingDefaults>;
};

export function getTradeConfig(tradeCode: string): TradeConfiguration {
  return isConfiguredTrade(tradeCode)
    ? TRADE_CONFIGS[tradeCode]
    : TRADE_CONFIGS[DEFAULT_TRADE];
}

export function listConfiguredTradeCodes() {
  return [...TRADE_CODES];
}

export function parseTradeConfigOverrides(raw: string | null | undefined): TradeConfigOverrides {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as TradeConfigOverrides;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function applyTradeConfigOverrides(
  base: TradeConfiguration,
  overrides: TradeConfigOverrides,
): TradeConfiguration {
  const defaultPricingMode =
    overrides.defaultPricingMode &&
    base.allowedPricingModes.includes(overrides.defaultPricingMode)
      ? overrides.defaultPricingMode
      : base.defaultPricingMode;
  const publicPricingBehavior =
    overrides.publicPricingBehavior &&
    (PUBLIC_PRICING_BEHAVIORS as readonly string[]).includes(overrides.publicPricingBehavior)
      ? overrides.publicPricingBehavior
      : base.publicPricingBehavior;
  return {
    ...base,
    defaultPricingMode,
    publicPricingBehavior,
    customerLanguage: {
      ...base.customerLanguage,
      ...overrides.customerLanguage,
    },
    schedulingDefaults: {
      ...base.schedulingDefaults,
      ...overrides.schedulingDefaults,
    },
  };
}

export function resolveTradeConfiguration(
  tradeCode: string,
  overridesJson?: string | null,
) {
  return applyTradeConfigOverrides(getTradeConfig(tradeCode), parseTradeConfigOverrides(overridesJson));
}

export function pricingModeAllowedForTrade(tradeCode: string, mode: string) {
  const parsed = parsePricingMode(mode);
  if (!parsed) return false;
  return getTradeConfig(tradeCode).allowedPricingModes.includes(parsed);
}

export function tradeOffersStarterCatalog(tradeCode: string | null | undefined) {
  if (!tradeCode) return false;
  return getTradeConfig(tradeCode).catalogStarterSource !== "NONE";
}

export function preferredCatalogCategoryOrder(tradeCode: string) {
  return [...getTradeConfig(tradeCode).catalogCategories];
}

export function publicTradeProjection(config: TradeConfiguration) {
  return {
    code: config.tradeCode,
    label: config.customerFacingLabel,
    requestTitle: config.customerLanguage.requestTitle,
    requestDescription: config.customerLanguage.requestDescription,
    requestCta: config.customerLanguage.requestCta,
    serviceNoun: config.serviceTerminology.catalog,
  };
}

export type PublicTradeProjection = ReturnType<typeof publicTradeProjection>;

export function publicTradeProjectionForCode(tradeCode: string) {
  return publicTradeProjection(getTradeConfig(tradeCode));
}

export function composePublicRequestCopy(configs: TradeConfiguration[]) {
  if (configs.length === 0) {
    return HANDYMAN_TRADE_CONFIG.customerLanguage;
  }
  if (configs.length === 1) {
    return configs[0].customerLanguage;
  }
  return {
    requestTitle: "Request Service",
    requestDescription: `Request ${configs.map((config) => config.customerFacingLabel.toLowerCase()).join(" or ")} from this business in one visit request.`,
    requestCta: "Request a Quote",
    emptyCatalogHint: "Describe the work if you do not see the right service.",
  };
}

export function workspaceTradeLabel(codes: string[]) {
  if (codes.length === 0) return tradeLabel(DEFAULT_TRADE);
  return codes.map((code) => getTradeConfig(code).label).join(" + ");
}

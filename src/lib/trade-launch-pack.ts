/**
 * Typed trade launch-pack registry.
 *
 * A pack is the trade's existing configuration plus its starter catalog.
 * It is not a second application, catalog engine, or intake engine.
 * Future verticals register here the same way Cleaning does.
 */

import {
  CLEANING_CATALOG_CATEGORIES,
  CLEANING_STARTER_SERVICES,
  cleaningStarterPricingMode,
  planCleaningStarterCatalogInstall,
  type CleaningStarterService,
} from "@/lib/cleaning-starter-catalog";
import {
  HANDYMAN_STARTER_SERVICES,
  planStarterCatalogInstall,
  type HandymanStarterService,
} from "@/lib/handyman-starter-catalog";
import {
  PRESSURE_WASHING_CATALOG_CATEGORIES,
  PRESSURE_WASHING_STARTER_SERVICES,
  planPressureWashingStarterCatalogInstall,
  pressureWashingStarterPricingMode,
  type PressureWashingStarterService,
} from "@/lib/pressure-washing-starter-catalog";
import { currentIntakeSchema, type IntakeSchema } from "@/lib/intake-schema";
import type { PricingMode } from "@/lib/pricing-mode";
import {
  getTradeConfig,
  type CatalogStarterSource,
  type TradeConfiguration,
  type TradeCustomerLanguage,
} from "@/lib/trade-config";
import { TRADE_CODES, isConfiguredTrade, type TradeCode } from "@/lib/trades";

export const CANONICAL_PUBLIC_PRICING_MODES = [
  "FIXED",
  "STARTING_AT",
  "CUSTOM_QUOTE",
] as const;
export type CanonicalPublicPricingMode =
  (typeof CANONICAL_PUBLIC_PRICING_MODES)[number];

export type TradeLaunchPack = {
  tradeCode: TradeCode;
  catalogStarterSource: CatalogStarterSource;
  catalogCategories: readonly string[];
  customerLanguage: TradeCustomerLanguage;
  intakeSchema: IntakeSchema;
  config: TradeConfiguration;
};

export type StarterCatalogPlan = {
  add: Array<
    CleaningStarterService | HandymanStarterService | PressureWashingStarterService
  >;
  skip: Array<
    CleaningStarterService | HandymanStarterService | PressureWashingStarterService
  >;
  pending: Array<
    CleaningStarterService | HandymanStarterService | PressureWashingStarterService
  >;
};

export function getTradeLaunchPack(tradeCode: string): TradeLaunchPack {
  const config = getTradeConfig(tradeCode);
  return {
    tradeCode: config.tradeCode,
    catalogStarterSource: config.catalogStarterSource,
    catalogCategories: config.catalogCategories,
    customerLanguage: config.customerLanguage,
    intakeSchema: currentIntakeSchema(config.tradeCode),
    config,
  };
}

export function listTradeLaunchPacks() {
  return TRADE_CODES.map((code) => getTradeLaunchPack(code));
}

export function planStarterCatalogInstallForTrade(
  tradeCode: string,
  existingNames: string[],
): StarterCatalogPlan {
  const source = getTradeConfig(tradeCode).catalogStarterSource;
  if (source === "CLEANING_STARTER") {
    return planCleaningStarterCatalogInstall(existingNames);
  }
  if (source === "HANDYMAN_STARTER") {
    return planStarterCatalogInstall(existingNames);
  }
  if (source === "PRESSURE_WASHING_STARTER") {
    return planPressureWashingStarterCatalogInstall(existingNames);
  }
  return { add: [], skip: [], pending: [] };
}

export function isCanonicalPublicPricingMode(
  mode: string,
): mode is CanonicalPublicPricingMode {
  return (CANONICAL_PUBLIC_PRICING_MODES as readonly string[]).includes(mode);
}

export function cleaningLaunchPackStarterServices() {
  return CLEANING_STARTER_SERVICES;
}

export function cleaningLaunchPackCategories() {
  return CLEANING_CATALOG_CATEGORIES;
}

export function handymanLaunchPackStarterServices() {
  return HANDYMAN_STARTER_SERVICES;
}

export function pressureWashingLaunchPackStarterServices() {
  return PRESSURE_WASHING_STARTER_SERVICES;
}

export function pressureWashingLaunchPackCategories() {
  return PRESSURE_WASHING_CATALOG_CATEGORIES;
}

export function cleaningStarterMode(service: CleaningStarterService): PricingMode {
  return cleaningStarterPricingMode(service);
}

export function pressureWashingStarterMode(
  service: PressureWashingStarterService,
): PricingMode {
  return pressureWashingStarterPricingMode(service);
}

export function tradeLaunchPackOffersStarter(tradeCode: string) {
  return isConfiguredTrade(tradeCode) && getTradeConfig(tradeCode).catalogStarterSource !== "NONE";
}

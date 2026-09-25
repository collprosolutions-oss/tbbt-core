/**
 * TBBT trade registry.
 *
 * business_trades is the Core source of truth for which trades a Business
 * actually operates. This file only names configured trades and their
 * display labels. Do not scatter `if (trade === "HANDYMAN")` through UI
 * or actions — use TradeConfiguration instead.
 */
export const TRADE_CODES = ["HANDYMAN", "CLEANING"] as const;

export type TradeCode = (typeof TRADE_CODES)[number];

export const DEFAULT_TRADE: TradeCode = "HANDYMAN";

export const TRADE_STATUS_ACTIVE = "ACTIVE";
export const TRADE_STATUS_INACTIVE = "INACTIVE";

export const TRADES: Record<
  TradeCode,
  { name: string; status: "available"; note: string }
> = {
  HANDYMAN: {
    name: "Handyman",
    status: "available",
    note: "First Trade",
  },
  CLEANING: {
    name: "Cleaning",
    status: "available",
    note: "Second Trade",
  },
};

export function isConfiguredTrade(code: string): code is TradeCode {
  return (TRADE_CODES as readonly string[]).includes(code);
}

/** @deprecated Use isConfiguredTrade. Kept so existing Handyman gates compile. */
export function isActiveTrade(code: string): code is TradeCode {
  return isConfiguredTrade(code);
}

export function getTrade(code: string) {
  if (isConfiguredTrade(code)) {
    return TRADES[code];
  }
  return null;
}

export function tradeLabel(code: string) {
  return getTrade(code)?.name ?? code;
}

export function formatActiveTradeLabels(codes: string[]) {
  const labels = codes
    .filter(isConfiguredTrade)
    .map((code) => TRADES[code].name);
  if (labels.length === 0) return TRADES[DEFAULT_TRADE].name;
  return labels.join(" + ");
}

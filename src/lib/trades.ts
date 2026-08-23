/**
 * TBBT trade registry.
 * Only HANDYMAN is active. Other trades must not be implemented until authorized.
 */
export const TRADE_CODES = ["HANDYMAN"] as const;

export type TradeCode = (typeof TRADE_CODES)[number];

export const DEFAULT_TRADE: TradeCode = "HANDYMAN";

export const TRADES: Record<
  TradeCode,
  { name: string; status: "available"; note: string }
> = {
  HANDYMAN: {
    name: "Handyman",
    status: "available",
    note: "First Trade",
  },
};

export function isActiveTrade(code: string): code is TradeCode {
  return code === DEFAULT_TRADE;
}

export function getTrade(code: string) {
  if (isActiveTrade(code)) {
    return TRADES[code];
  }
  return null;
}

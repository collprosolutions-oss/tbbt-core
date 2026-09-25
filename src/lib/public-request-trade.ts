/**
 * Public request trade resolution.
 *
 * Catalog records and ACTIVE BusinessTrade rows are the authority.
 * A browser-supplied trade value may hint Other/custom work on a
 * multi-trade business, but it never authorizes.
 *
 * Mixed Handyman + Cleaning in one request is blocked: one ServiceRequest
 * cannot truthfully freeze two conflicting intake/recurrence schemas.
 */

import { DEFAULT_TRADE, isConfiguredTrade, type TradeCode } from "@/lib/trades";

export const CROSS_TRADE_REQUEST_MESSAGE =
  "Please submit a separate request for each trade. This request can include services from one trade only.";

export const CUSTOM_WORK_TRADE_REQUIRED_MESSAGE =
  "Choose which trade this custom work is for.";

export const INACTIVE_TRADE_REQUEST_MESSAGE =
  "That trade is not currently offered.";

export const INACTIVE_CATALOG_TRADE_MESSAGE =
  "That service is not currently offered.";

export function catalogItemTradeCode(item: { tradeCode?: string | null }): TradeCode {
  return isConfiguredTrade(item.tradeCode ?? "")
    ? (item.tradeCode as TradeCode)
    : DEFAULT_TRADE;
}

export function catalogItemIsPubliclyOffered(
  item: { active?: boolean; tradeCode?: string | null },
  activeTradeCodes: string[],
) {
  if (item.active === false) return false;
  return activeTradeCodes.includes(catalogItemTradeCode(item));
}

export function selectedCatalogTradeCodes(
  items: Array<{ id: string; tradeCode?: string | null }>,
  catalogIds: string[],
): TradeCode[] {
  const codes = new Set<TradeCode>();
  for (const id of catalogIds) {
    const item = items.find((row) => row.id === id);
    if (item) codes.add(catalogItemTradeCode(item));
  }
  return [...codes];
}

export function canAddCatalogItemToSelection(
  items: Array<{ id: string; tradeCode?: string | null }>,
  selectedIds: string[],
  nextId: string,
) {
  if (selectedIds.includes(nextId)) return true;
  const current = selectedCatalogTradeCodes(items, selectedIds);
  const nextItem = items.find((row) => row.id === nextId);
  if (!nextItem) return false;
  if (current.length === 0) return true;
  return current.every((code) => code === catalogItemTradeCode(nextItem));
}

export type ResolvePublicRequestTradeInput = {
  /** Trade codes taken from tenant-owned catalog records. */
  catalogTradeCodes: string[];
  /** ACTIVE BusinessTrade codes (or compatibility fallback). */
  authorizedActiveTradeCodes: string[];
  /** Browser hint. Never authorization. */
  requestedTradeCode?: string | null;
  includeOther: boolean;
};

export type ResolvePublicRequestTradeResult =
  | { ok: true; tradeCode: TradeCode }
  | { ok: false; error: string };

export function resolvePublicRequestTrade(
  input: ResolvePublicRequestTradeInput,
): ResolvePublicRequestTradeResult {
  const authorized = input.authorizedActiveTradeCodes.filter(isConfiguredTrade);
  const catalogCodes = [
    ...new Set(input.catalogTradeCodes.filter(isConfiguredTrade)),
  ];

  if (catalogCodes.some((code) => !authorized.includes(code))) {
    return { ok: false, error: INACTIVE_CATALOG_TRADE_MESSAGE };
  }

  if (catalogCodes.length > 1) {
    return { ok: false, error: CROSS_TRADE_REQUEST_MESSAGE };
  }

  if (catalogCodes.length === 1) {
    return { ok: true, tradeCode: catalogCodes[0] };
  }

  if (authorized.length === 0) {
    return { ok: false, error: INACTIVE_TRADE_REQUEST_MESSAGE };
  }

  const hint = (input.requestedTradeCode ?? "").trim();
  if (hint) {
    if (isConfiguredTrade(hint) && authorized.includes(hint)) {
      return { ok: true, tradeCode: hint };
    }
    return { ok: false, error: INACTIVE_TRADE_REQUEST_MESSAGE };
  }

  if (authorized.length === 1) {
    return { ok: true, tradeCode: authorized[0] };
  }

  return { ok: false, error: CUSTOM_WORK_TRADE_REQUIRED_MESSAGE };
}

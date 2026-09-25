/**
 * business_trades authority.
 *
 * Readers prefer ACTIVE BusinessTrade rows. Business.tradeCode is a
 * temporary compatibility projection of the primary active trade and is
 * synced on write. Browser-supplied trade/business IDs never authorize.
 *
 * Transition path:
 * 1. Migration backfills one ACTIVE row per Business from tradeCode.
 * 2. New writers create/update BusinessTrade, then sync tradeCode.
 * 3. Remaining readers should call listActiveBusinessTrades() or
 *    resolvePrimaryTradeCode(). After that, tradeCode can be dropped.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { assertBusinessRecord } from "@/lib/access-scope";
import {
  currentIntakeSchema,
  type IntakeSchema,
} from "@/lib/intake-schema";
import {
  getTradeConfig,
  resolveTradeConfiguration,
  type TradeConfiguration,
} from "@/lib/trade-config";
import {
  DEFAULT_TRADE,
  TRADE_STATUS_ACTIVE,
  TRADE_STATUS_INACTIVE,
  isConfiguredTrade,
  type TradeCode,
} from "@/lib/trades";

type TradeDb = PrismaClient | Prisma.TransactionClient;

export type BusinessTradeRecord = {
  id: string;
  businessId: string;
  tradeCode: string;
  status: string;
  configOverridesJson: string;
  intakeSchemaVersion: number;
  activatedAt: Date;
  deactivatedAt: Date | null;
};

export type ActiveBusinessTrade = BusinessTradeRecord & {
  tradeCode: TradeCode;
  config: TradeConfiguration;
};

function asActive(row: BusinessTradeRecord): ActiveBusinessTrade | null {
  if (row.status !== TRADE_STATUS_ACTIVE) return null;
  if (!isConfiguredTrade(row.tradeCode)) return null;
  return {
    ...row,
    tradeCode: row.tradeCode,
    config: resolveTradeConfiguration(row.tradeCode, row.configOverridesJson),
  };
}

export async function listBusinessTrades(db: TradeDb, businessId: string) {
  return db.businessTrade.findMany({
    where: { businessId },
    orderBy: [{ activatedAt: "asc" }, { createdAt: "asc" }],
  });
}

export async function listActiveBusinessTrades(
  db: TradeDb,
  businessId: string,
): Promise<ActiveBusinessTrade[]> {
  const rows = await db.businessTrade.findMany({
    where: { businessId, status: TRADE_STATUS_ACTIVE },
    orderBy: [{ activatedAt: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(asActive).filter((row): row is ActiveBusinessTrade => row != null);
}

export async function listActiveTradeCodes(
  db: TradeDb,
  businessId: string,
): Promise<TradeCode[]> {
  const active = await listActiveBusinessTrades(db, businessId);
  if (active.length > 0) return active.map((row) => row.tradeCode);
  const business = await db.business.findFirst({
    where: { id: businessId },
    select: { tradeCode: true },
  });
  const fallback = business?.tradeCode;
  return isConfiguredTrade(fallback ?? "") ? [fallback as TradeCode] : [DEFAULT_TRADE];
}

export function primaryTradeCodeFrom(
  rows: Array<{ tradeCode: string; status: string }>,
  compatibilityTradeCode?: string | null,
): TradeCode {
  const active = rows.filter(
    (row) => row.status === TRADE_STATUS_ACTIVE && isConfiguredTrade(row.tradeCode),
  );
  if (compatibilityTradeCode && isConfiguredTrade(compatibilityTradeCode)) {
    const match = active.find((row) => row.tradeCode === compatibilityTradeCode);
    if (match) return match.tradeCode as TradeCode;
  }
  if (active[0] && isConfiguredTrade(active[0].tradeCode)) {
    return active[0].tradeCode as TradeCode;
  }
  return isConfiguredTrade(compatibilityTradeCode ?? "")
    ? (compatibilityTradeCode as TradeCode)
    : DEFAULT_TRADE;
}

export async function resolvePrimaryTradeCode(db: TradeDb, businessId: string) {
  const [rows, business] = await Promise.all([
    db.businessTrade.findMany({
      where: { businessId },
      select: { tradeCode: true, status: true },
    }),
    db.business.findFirst({
      where: { id: businessId },
      select: { tradeCode: true },
    }),
  ]);
  return primaryTradeCodeFrom(rows, business?.tradeCode);
}

export async function syncCompatibilityTradeCode(db: TradeDb, businessId: string) {
  const primary = await resolvePrimaryTradeCode(db, businessId);
  await db.business.update({
    where: { id: businessId },
    data: { tradeCode: primary },
  });
  return primary;
}

export async function ensurePrimaryBusinessTrade(
  db: TradeDb,
  businessId: string,
  tradeCode: string = DEFAULT_TRADE,
) {
  const code = isConfiguredTrade(tradeCode) ? tradeCode : DEFAULT_TRADE;
  const existing = await db.businessTrade.findFirst({
    where: { businessId, tradeCode: code },
  });
  if (existing) {
    if (existing.status !== TRADE_STATUS_ACTIVE) {
      await db.businessTrade.update({
        where: { id: existing.id },
        data: {
          status: TRADE_STATUS_ACTIVE,
          deactivatedAt: null,
          activatedAt: new Date(),
          intakeSchemaVersion: currentIntakeSchema(code).version,
        },
      });
    }
  } else {
    await db.businessTrade.create({
      data: {
        businessId,
        tradeCode: code,
        status: TRADE_STATUS_ACTIVE,
        configOverridesJson: "{}",
        intakeSchemaVersion: currentIntakeSchema(code).version,
      },
    });
  }
  await syncCompatibilityTradeCode(db, businessId);
}

export async function activateBusinessTradeOp(
  db: TradeDb,
  access: { businessId: string; assertOwned: <T extends { businessId: string }>(row: T | null | undefined) => T },
  tradeCode: string,
) {
  if (!isConfiguredTrade(tradeCode)) {
    throw new Error("That trade is not configured.");
  }
  const existing = await db.businessTrade.findFirst({
    where: { businessId: access.businessId, tradeCode },
  });
  if (existing) {
    access.assertOwned(existing);
    const updated = await db.businessTrade.update({
      where: { id: existing.id },
      data: {
        status: TRADE_STATUS_ACTIVE,
        deactivatedAt: null,
        activatedAt: existing.status === TRADE_STATUS_ACTIVE ? existing.activatedAt : new Date(),
        intakeSchemaVersion: currentIntakeSchema(tradeCode).version,
      },
    });
    await syncCompatibilityTradeCode(db, access.businessId);
    return updated;
  }
  const created = await db.businessTrade.create({
    data: {
      businessId: access.businessId,
      tradeCode,
      status: TRADE_STATUS_ACTIVE,
      configOverridesJson: "{}",
      intakeSchemaVersion: currentIntakeSchema(tradeCode).version,
    },
  });
  await syncCompatibilityTradeCode(db, access.businessId);
  return created;
}

export async function deactivateBusinessTradeOp(
  db: TradeDb,
  access: { businessId: string; assertOwned: <T extends { businessId: string }>(row: T | null | undefined) => T },
  tradeCode: string,
) {
  const existing = await db.businessTrade.findFirst({
    where: { businessId: access.businessId, tradeCode },
  });
  const owned = access.assertOwned(existing);
  const remaining = await db.businessTrade.count({
    where: {
      businessId: access.businessId,
      status: TRADE_STATUS_ACTIVE,
      NOT: { id: owned.id },
    },
  });
  if (remaining === 0) {
    throw new Error("A business must keep at least one active trade.");
  }
  const updated = await db.businessTrade.update({
    where: { id: owned.id },
    data: {
      status: TRADE_STATUS_INACTIVE,
      deactivatedAt: new Date(),
    },
  });
  await syncCompatibilityTradeCode(db, access.businessId);
  return updated;
}

export async function assertOwnedBusinessTrade(
  db: TradeDb,
  businessId: string,
  tradeId: string,
) {
  const row = await db.businessTrade.findFirst({
    where: { id: tradeId, businessId },
  });
  return assertBusinessRecord(row, businessId);
}

export function businessHoldsTrade(
  rows: Array<{ tradeCode: string; status: string }>,
  tradeCode: string,
) {
  return rows.some(
    (row) => row.tradeCode === tradeCode && row.status === TRADE_STATUS_ACTIVE,
  );
}

export class InactiveCatalogTradeError extends Error {
  constructor(message = "That trade is not active on this business.") {
    super(message);
    this.name = "InactiveCatalogTradeError";
  }
}

/**
 * Resolve a catalog write trade.
 *
 * An explicit requested trade must be a configured ACTIVE BusinessTrade.
 * Invalid/inactive values fail closed instead of silently becoming the
 * primary trade. Fallback-to-primary is only used when no trade was
 * requested.
 */
export async function authorizeCatalogTradeCode(
  db: TradeDb,
  businessId: string,
  requested: string | null | undefined,
) {
  const explicit = typeof requested === "string" ? requested.trim() : "";
  const active = await listActiveTradeCodes(db, businessId);
  if (explicit) {
    if (isConfiguredTrade(explicit) && active.includes(explicit)) {
      return explicit;
    }
    throw new InactiveCatalogTradeError();
  }
  return (await resolvePrimaryTradeCode(db, businessId)) as TradeCode;
}

export async function intakeSchemasForBusiness(db: TradeDb, businessId: string) {
  const codes = await listActiveTradeCodes(db, businessId);
  return codes.map((code) => currentIntakeSchema(code));
}

export async function composeBusinessIntakeSchema(
  db: TradeDb,
  businessId: string,
  selectedTradeCodes: string[] = [],
): Promise<IntakeSchema> {
  const active = await listActiveTradeCodes(db, businessId);
  const wanted = selectedTradeCodes.filter((code) =>
    active.includes(code as TradeCode),
  );
  const unique = [...new Set(wanted)];
  // Do not merge conflicting Handyman + Cleaning field keys.
  const code = (unique[0] ?? active[0] ?? DEFAULT_TRADE) as TradeCode;
  return currentIntakeSchema(code);
}

export function tradeConfigForCode(tradeCode: string) {
  return getTradeConfig(tradeCode);
}

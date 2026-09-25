/**
 * Reusable limit enforcement.
 *
 * Only numeric limits that are approved in the catalog are hard-enforced.
 * Starter's 1-trade cap is the only current approved number.
 * Add-ons and support grants can add allowance later.
 *
 * Downgrade never removes existing trades, members, files, or locations.
 * Over-limit states block additional consuming operations.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { PRODUCT_LIMITS, type ProductLimitCode } from "@/lib/product-catalog/codes";
import { TRADE_STATUS_ACTIVE } from "@/lib/trades";
import { ProductLimitExceededError } from "@/lib/product-entitlements/errors";
import { loadProductEntitlement } from "@/lib/product-entitlements/enforce";

type Db = PrismaClient | Prisma.TransactionClient;

export async function countActiveTrades(db: Db, businessId: string) {
  return db.businessTrade.count({
    where: { businessId, status: TRADE_STATUS_ACTIVE },
  });
}

export async function countActiveMembers(db: Db, businessId: string) {
  return db.membership.count({
    where: { businessId, active: true },
  });
}

export async function assertTradeActivationAllowed(
  db: Db,
  businessId: string,
  input: { alreadyActive: boolean },
) {
  if (input.alreadyActive) return;
  const entitlement = await loadProductEntitlement(db, businessId);
  const limit = entitlement.limits[PRODUCT_LIMITS.TRADES]?.effective ?? null;
  if (limit == null) return;
  const current = await countActiveTrades(db, businessId);
  if (current + 1 > limit) {
    throw new ProductLimitExceededError(
      PRODUCT_LIMITS.TRADES,
      `This TBBT plan includes ${limit} trade${limit === 1 ? "" : "s"}. Existing trades are retained.`,
    );
  }
}

export async function assertMemberInviteAllowed(db: Db, businessId: string) {
  const entitlement = await loadProductEntitlement(db, businessId);
  const limit = entitlement.limits[PRODUCT_LIMITS.USERS]?.effective ?? null;
  if (limit == null) return;
  const current = await countActiveMembers(db, businessId);
  if (current + 1 > limit) {
    throw new ProductLimitExceededError(
      PRODUCT_LIMITS.USERS,
      `This TBBT plan includes ${limit} user${limit === 1 ? "" : "s"}. Existing members are retained.`,
    );
  }
}

export async function resolveEffectiveStorageLimitBytes(
  db: Db,
  businessId: string,
  operationalLimitBytes: number | bigint,
) {
  const entitlement = await loadProductEntitlement(db, businessId);
  const entitled = entitlement.limits[PRODUCT_LIMITS.STORAGE_BYTES]?.effective ?? null;
  if (entitled == null) return Number(operationalLimitBytes);
  return entitled;
}

export function storageLimitBlocksIncoming(input: {
  usedBytes: number | bigint;
  reservedBytes: number | bigint;
  incomingBytes: number;
  limitBytes: number;
}) {
  return (
    Number(input.usedBytes) + Number(input.reservedBytes) + input.incomingBytes >
    input.limitBytes
  );
}

export function describeLimitArchitecture(): Record<ProductLimitCode, string> {
  return {
    TRADES:
      "Starter advertises 1 trade. Additional Trade add-on adds +1. Founder/Business/Enterprise have no invented numeric cap.",
    USERS:
      "No approved numeric user cap is published. Additional Users can add allowance later. Downgrade never removes members.",
    STORAGE_BYTES:
      "Operational BusinessStorageAccount limit remains. Extra Storage can add bytes later. Downgrade never deletes files.",
    LOCATIONS:
      "No approved numeric location cap. Architecture only until multi-location operations exist.",
  };
}

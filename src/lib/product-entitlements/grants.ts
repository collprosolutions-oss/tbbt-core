/**
 * Explicit, additive, tenant-scoped support / grandfather grants.
 * Never overload a plan code with invisible special cases.
 * Never accept a browser-controlled override.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  isProductCapabilityCode,
  PRODUCT_GRANT_SOURCES,
  PRODUCT_GRANT_TYPES,
  PRODUCT_LIMIT_LIST,
  type ProductCapabilityCode,
  type ProductLimitCode,
} from "@/lib/product-catalog/codes";

type Db = PrismaClient | Prisma.TransactionClient;

export async function grantProductCapability(
  db: Db,
  input: {
    businessId: string;
    capability: ProductCapabilityCode;
    source?: string;
    note?: string | null;
  },
) {
  if (!isProductCapabilityCode(input.capability)) {
    throw new Error("Unknown product capability.");
  }
  return db.businessProductGrant.create({
    data: {
      businessId: input.businessId,
      grantType: PRODUCT_GRANT_TYPES.CAPABILITY,
      code: input.capability,
      status: "ACTIVE",
      source: input.source ?? PRODUCT_GRANT_SOURCES.SUPPORT,
      note: input.note ?? null,
    },
  });
}

export async function grantProductLimit(
  db: Db,
  input: {
    businessId: string;
    limit: ProductLimitCode;
    quantity: number;
    source?: string;
    note?: string | null;
  },
) {
  if (!PRODUCT_LIMIT_LIST.includes(input.limit)) {
    throw new Error("Unknown product limit.");
  }
  return db.businessProductGrant.create({
    data: {
      businessId: input.businessId,
      grantType: PRODUCT_GRANT_TYPES.LIMIT,
      code: input.limit,
      quantity: input.quantity,
      status: "ACTIVE",
      source: input.source ?? PRODUCT_GRANT_SOURCES.SUPPORT,
      note: input.note ?? null,
    },
  });
}

export async function revokeProductGrant(
  db: Db,
  input: { businessId: string; grantId: string },
) {
  const existing = await db.businessProductGrant.findFirst({
    where: { id: input.grantId, businessId: input.businessId },
  });
  if (!existing) return null;
  return db.businessProductGrant.update({
    where: { id: existing.id },
    data: { status: "INACTIVE", revokedAt: new Date() },
  });
}

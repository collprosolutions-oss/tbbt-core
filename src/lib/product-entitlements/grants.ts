/**
 * Explicit, additive, tenant-scoped support / grandfather grants.
 * Never overload a plan code with invisible special cases.
 * Never accept a browser-controlled override.
 *
 * sourceRef is an optional idempotency key. Retrying the same
 * business/source/type/code/sourceRef cannot silently double a limit.
 * Independent grants without a sourceRef remain allowed.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  isProductCapabilityCode,
  PRODUCT_GRANT_SOURCES,
  PRODUCT_GRANT_TYPES,
  PRODUCT_LIMIT_LIST,
  type ProductCapabilityCode,
  type ProductLimitCode,
} from "@/lib/product-catalog/codes";
import { assertPositiveIntegerQuantity } from "@/lib/product-entitlements/errors";

type Db = PrismaClient | Prisma.TransactionClient;

function normalizeSourceRef(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

async function findIdempotentGrant(
  db: Db,
  input: {
    businessId: string;
    grantType: string;
    code: string;
    source: string;
    sourceRef: string;
  },
) {
  return db.businessProductGrant.findFirst({
    where: {
      businessId: input.businessId,
      grantType: input.grantType,
      code: input.code,
      source: input.source,
      sourceRef: input.sourceRef,
    },
  });
}

export async function grantProductCapability(
  db: Db,
  input: {
    businessId: string;
    capability: ProductCapabilityCode;
    source?: string;
    sourceRef?: string | null;
    note?: string | null;
  },
) {
  if (!isProductCapabilityCode(input.capability)) {
    throw new Error("Unknown product capability.");
  }
  const source = input.source ?? PRODUCT_GRANT_SOURCES.SUPPORT;
  const sourceRef = normalizeSourceRef(input.sourceRef);
  if (sourceRef) {
    const existing = await findIdempotentGrant(db, {
      businessId: input.businessId,
      grantType: PRODUCT_GRANT_TYPES.CAPABILITY,
      code: input.capability,
      source,
      sourceRef,
    });
    if (existing) return existing;
  }
  try {
    return await db.businessProductGrant.create({
      data: {
        businessId: input.businessId,
        grantType: PRODUCT_GRANT_TYPES.CAPABILITY,
        code: input.capability,
        status: "ACTIVE",
        source,
        sourceRef,
        note: input.note ?? null,
      },
    });
  } catch (error) {
    if (
      sourceRef &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const existing = await findIdempotentGrant(db, {
        businessId: input.businessId,
        grantType: PRODUCT_GRANT_TYPES.CAPABILITY,
        code: input.capability,
        source,
        sourceRef,
      });
      if (existing) return existing;
    }
    throw error;
  }
}

export async function grantProductLimit(
  db: Db,
  input: {
    businessId: string;
    limit: ProductLimitCode;
    quantity: number;
    source?: string;
    sourceRef?: string | null;
    note?: string | null;
  },
) {
  if (!PRODUCT_LIMIT_LIST.includes(input.limit)) {
    throw new Error("Unknown product limit.");
  }
  const quantity = assertPositiveIntegerQuantity(input.quantity);
  const source = input.source ?? PRODUCT_GRANT_SOURCES.SUPPORT;
  const sourceRef = normalizeSourceRef(input.sourceRef);
  if (sourceRef) {
    const existing = await findIdempotentGrant(db, {
      businessId: input.businessId,
      grantType: PRODUCT_GRANT_TYPES.LIMIT,
      code: input.limit,
      source,
      sourceRef,
    });
    if (existing) return existing;
  }
  try {
    return await db.businessProductGrant.create({
      data: {
        businessId: input.businessId,
        grantType: PRODUCT_GRANT_TYPES.LIMIT,
        code: input.limit,
        quantity,
        status: "ACTIVE",
        source,
        sourceRef,
        note: input.note ?? null,
      },
    });
  } catch (error) {
    if (
      sourceRef &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const existing = await findIdempotentGrant(db, {
        businessId: input.businessId,
        grantType: PRODUCT_GRANT_TYPES.LIMIT,
        code: input.limit,
        source,
        sourceRef,
      });
      if (existing) return existing;
    }
    throw error;
  }
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

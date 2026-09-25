/**
 * Business-scoped product entitlement helpers.
 *
 * These never authorize a role. Callers must still pass tenant access
 * and requireBusinessCapability / requireBusinessRole independently.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import type { ProductCapabilityCode, ProductLimitCode } from "@/lib/product-catalog/codes";
import { getProductCapabilityDefinition } from "@/lib/product-catalog/capabilities";
import { requireSaasOperatingEntitlement } from "@/lib/saas-billing/entitlement";
import {
  ProductCapabilityRequiredError,
  ProductLimitExceededError,
} from "@/lib/product-entitlements/errors";
import {
  resolveProductEntitlement,
  type ProductEntitlement,
} from "@/lib/product-entitlements/resolver";

type EntitlementDb = PrismaClient | Prisma.TransactionClient;

async function loadBusiness(
  db: EntitlementDb,
  businessId: string,
): Promise<{ id: string; slug: string }> {
  const business = await db.business.findUnique({
    where: { id: businessId },
    select: { id: true, slug: true },
  });
  if (!business) {
    throw new Error("Business workspace is required for product entitlement.");
  }
  return business;
}

function businessIdOf(access: { businessId?: string; workspace?: { business?: { id?: string } } }) {
  const id = access.workspace?.business?.id ?? access.businessId;
  if (!id) {
    throw new Error("Business workspace is required for product entitlement.");
  }
  return id;
}

export async function loadProductEntitlement(
  db: EntitlementDb,
  businessId: string,
): Promise<ProductEntitlement> {
  const business = await loadBusiness(db, businessId);
  return resolveProductEntitlement(db, business);
}

export async function hasProductCapability(
  db: EntitlementDb,
  businessId: string,
  capability: ProductCapabilityCode,
) {
  const entitlement = await loadProductEntitlement(db, businessId);
  return entitlement.capabilities.includes(capability);
}

export async function requireProductCapability(
  db: EntitlementDb,
  businessId: string,
  capability: ProductCapabilityCode,
) {
  const entitlement = await loadProductEntitlement(db, businessId);
  if (!entitlement.capabilities.includes(capability)) {
    const definition = getProductCapabilityDefinition(capability);
    throw new ProductCapabilityRequiredError(
      capability,
      `The ${entitlement.planName} does not include ${definition.displayName}. Existing records are retained.`,
    );
  }
  return entitlement;
}

export async function resolveProductLimit(
  db: EntitlementDb,
  businessId: string,
  limit: ProductLimitCode,
): Promise<number | null> {
  const entitlement = await loadProductEntitlement(db, businessId);
  return entitlement.limits[limit]?.effective ?? null;
}

export async function requireOperatingProductCapability(
  db: EntitlementDb,
  access: BusinessAccess,
  capability: ProductCapabilityCode,
) {
  await requireSaasOperatingEntitlement(db, access);
  return requireProductCapability(db, businessIdOf(access), capability);
}

export function assertProductLimitAllows(
  entitlement: ProductEntitlement,
  limit: ProductLimitCode,
  nextCount: number,
) {
  const effective = entitlement.limits[limit]?.effective ?? null;
  if (effective == null) return;
  if (nextCount > effective) {
    throw new ProductLimitExceededError(
      limit,
      `This TBBT plan allows ${effective} ${limit.toLowerCase()}. Existing records are retained.`,
    );
  }
}

export async function requireProductLimitAllows(
  db: EntitlementDb,
  businessId: string,
  limit: ProductLimitCode,
  nextCount: number,
) {
  const entitlement = await loadProductEntitlement(db, businessId);
  assertProductLimitAllows(entitlement, limit, nextCount);
  return entitlement;
}

/**
 * Central commercial entitlement resolver.
 *
 * Answers: current base plan, SaaS operating state, effective product
 * capabilities, active add-ons, limits, and capability sources.
 *
 * UI strings are never the source of truth. Browser plan/feature/price
 * values never authorize.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { getAddonDefinition } from "@/lib/product-catalog/addons";
import { PRODUCT_CAPABILITY_DEFINITIONS } from "@/lib/product-catalog/capabilities";
import {
  ADDON_STATUSES,
  canonicalizePlanCode,
  isAddonCode,
  isProductCapabilityCode,
  PLAN_CODES,
  PRODUCT_LIMIT_LIST,
  PRODUCT_GRANT_TYPES,
  type AddonCode,
  type PlanCode,
  type ProductCapabilityCode,
  type ProductLimitCode,
} from "@/lib/product-catalog/codes";
import {
  getPlanDefinition,
  resolvePlanCapabilities,
  resolvePlanLimit,
} from "@/lib/product-catalog/plans";
import { resolveSaasEntitlement, type SaasEntitlement } from "@/lib/saas-billing/entitlement";
import { resolveCompatiblePlanCode } from "@/lib/product-entitlements/compatibility";
import { resolvePlanCodeFromPriceId } from "@/lib/product-entitlements/price-map";

type EntitlementDb = PrismaClient | Prisma.TransactionClient;

export type EntitlementSourceKind = "PLAN" | "ADDON" | "GRANT" | "COMPATIBILITY";

export type CapabilitySource = {
  capability: ProductCapabilityCode;
  source: EntitlementSourceKind;
  code: string;
};

export type ResolvedLimit = {
  code: ProductLimitCode;
  base: number | null;
  additive: number;
  effective: number | null;
};

export type ResolvedProductAddon = {
  code: AddonCode;
  displayName: string;
  status: string;
  quantity: number;
  source: string;
  grantedAt: string | null;
  revokedAt: string | null;
};

export type ProductEntitlement = {
  businessId: string;
  planCode: PlanCode;
  planName: string;
  planPublicStatus: string;
  compatibilityResolved: boolean;
  storedPlanCode: string | null;
  operating: SaasEntitlement;
  capabilities: ProductCapabilityCode[];
  capabilitySources: CapabilitySource[];
  addons: ResolvedProductAddon[];
  limits: Record<ProductLimitCode, ResolvedLimit>;
};

function capabilitySourceMap(sources: CapabilitySource[]) {
  const map = new Map<ProductCapabilityCode, CapabilitySource[]>();
  for (const source of sources) {
    const current = map.get(source.capability) ?? [];
    current.push(source);
    map.set(source.capability, current);
  }
  return map;
}

export function hasResolvedProductCapability(
  entitlement: Pick<ProductEntitlement, "capabilities">,
  capability: ProductCapabilityCode,
) {
  return entitlement.capabilities.includes(capability);
}

export function resolveProductLimitValue(
  entitlement: Pick<ProductEntitlement, "limits">,
  limit: ProductLimitCode,
): number | null {
  return entitlement.limits[limit]?.effective ?? null;
}

export async function resolveProductEntitlement(
  db: EntitlementDb,
  business: { id: string; slug: string },
  now = new Date(),
): Promise<ProductEntitlement> {
  const [subscription, addonRows, grantRows] = await Promise.all([
    db.businessSaasSubscription.findUnique({
      where: { businessId: business.id },
    }),
    db.businessProductAddon.findMany({
      where: { businessId: business.id },
    }),
    db.businessProductGrant.findMany({
      where: { businessId: business.id, status: "ACTIVE" },
    }),
  ]);

  const storedPlanCode = subscription?.planCode ?? null;
  const planCode = resolveCompatiblePlanCode({
    planCode: storedPlanCode,
    stripePriceId: subscription?.stripePriceId ?? null,
    founderEligible: subscription?.founderEligible,
    founderConvertedAt: subscription?.founderConvertedAt,
    trialStartedAt: subscription?.trialStartedAt,
    legacyExempt: subscription?.legacyExempt,
    resolvePricePlanCode: resolvePlanCodeFromPriceId,
  });
  const plan = getPlanDefinition(planCode);
  const operating = resolveSaasEntitlement({
    slug: business.slug,
    row: subscription
      ? {
          status: subscription.status,
          trialStartedAt: subscription.trialStartedAt,
          trialEndsAt: subscription.trialEndsAt,
          founderEligible: subscription.founderEligible,
          founderConvertedAt: subscription.founderConvertedAt,
          founderEligibilityEndedAt: subscription.founderEligibilityEndedAt,
          legacyExempt: subscription.legacyExempt,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          currentPeriodEnd: subscription.currentPeriodEnd,
        }
      : null,
    now,
  });

  const capabilitySources: CapabilitySource[] = [];
  for (const capability of resolvePlanCapabilities(planCode)) {
    capabilitySources.push({
      capability,
      source: storedPlanCode ? "PLAN" : "COMPATIBILITY",
      code: planCode,
    });
  }

  const addons: ResolvedProductAddon[] = [];
  const limitAdditive: Partial<Record<ProductLimitCode, number>> = {};

  for (const row of addonRows) {
    if (!isAddonCode(row.addonCode)) continue;
    const definition = getAddonDefinition(row.addonCode);
    const active = row.status === ADDON_STATUSES.ACTIVE;
    addons.push({
      code: row.addonCode,
      displayName: definition.displayName,
      status: row.status,
      quantity: row.quantity,
      source: row.source,
      grantedAt: row.grantedAt?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
    });
    if (!active) continue;
    for (const capability of definition.grantsCapabilities) {
      capabilitySources.push({
        capability,
        source: "ADDON",
        code: row.addonCode,
      });
    }
    const quantity = Number.isInteger(row.quantity) && row.quantity > 0 ? row.quantity : 0;
    if (quantity <= 0) continue;
    for (const [limitCode, delta] of Object.entries(definition.limitDeltas)) {
      if (delta == null) continue;
      const key = limitCode as ProductLimitCode;
      limitAdditive[key] = (limitAdditive[key] ?? 0) + delta * quantity;
    }
  }

  for (const grant of grantRows) {
    if (grant.grantType === PRODUCT_GRANT_TYPES.CAPABILITY && isProductCapabilityCode(grant.code)) {
      capabilitySources.push({
        capability: grant.code,
        source: "GRANT",
        code: grant.code,
      });
    }
    if (grant.grantType === PRODUCT_GRANT_TYPES.LIMIT && grant.quantity != null) {
      if (!Number.isInteger(grant.quantity) || grant.quantity <= 0) continue;
      const key = grant.code as ProductLimitCode;
      if (PRODUCT_LIMIT_LIST.includes(key)) {
        limitAdditive[key] = (limitAdditive[key] ?? 0) + grant.quantity;
      }
    }
  }

  const uniqueCapabilities = [...new Set(capabilitySources.map((item) => item.capability))];
  const limits = Object.fromEntries(
    PRODUCT_LIMIT_LIST.map((code) => {
      const base = resolvePlanLimit(planCode, code);
      const additive = limitAdditive[code] ?? 0;
      const effective = base == null && additive === 0 ? null : (base ?? 0) + additive;
      return [code, { code, base, additive, effective } satisfies ResolvedLimit];
    }),
  ) as Record<ProductLimitCode, ResolvedLimit>;

  return {
    businessId: business.id,
    planCode,
    planName: plan.displayName,
    planPublicStatus: plan.publicStatus,
    compatibilityResolved: !storedPlanCode || canonicalizePlanCode(storedPlanCode) !== storedPlanCode,
    storedPlanCode,
    operating,
    capabilities: uniqueCapabilities,
    capabilitySources,
    addons: addons.filter((addon) => addon.status === ADDON_STATUSES.ACTIVE),
    limits,
  };
}

export function capabilitySourcesFor(
  entitlement: ProductEntitlement,
  capability: ProductCapabilityCode,
) {
  return capabilitySourceMap(entitlement.capabilitySources).get(capability) ?? [];
}

export function describeCapability(capability: ProductCapabilityCode) {
  return PRODUCT_CAPABILITY_DEFINITIONS[capability];
}

export const DEFAULT_COMPATIBILITY_PLAN = PLAN_CODES.FOUNDER;

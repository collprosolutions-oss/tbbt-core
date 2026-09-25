/**
 * Tenant-scoped service catalog mutations used by Services management
 * and the focused catalog-safety checks. Callers must already have
 * requireBusinessAccess(); this module never trusts a browser businessId.
 *
 * Deleting a catalog item SetNulls LineItem / request FKs. Historical
 * estimate line snapshots keep their recorded title, scope, and prices.
 */
import type { PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { requireSaasOperatingEntitlement } from "@/lib/saas-billing/entitlement";
import {
  authorizeCatalogTradeCode,
  InactiveCatalogTradeError,
} from "@/lib/business-trades";
import { catalogRecurrenceEligibleForTrade } from "@/lib/catalog-item-fields";
import { normalizeServiceCategory } from "@/lib/service-catalog-category";
import { pricingModeAllowedForTrade } from "@/lib/trade-config";
import { allocateUnusedWebsiteSlug } from "@/lib/website-engine/slugs";

type Db = PrismaClient;

export class CatalogOpsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogOpsError";
  }
}

/**
 * Create a catalog service without silently storing a price.
 * Launch / AI apply always uses CUSTOM_QUOTE unless the owner later
 * sets a price in Services.
 */
export async function createOwnedQuoteService(
  db: Db,
  access: BusinessAccess,
  input: { name: string; description?: string; tradeCode?: string | null; category?: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CATALOG);
  await requireSaasOperatingEntitlement(db, access);
  const name = input.name.trim();
  if (!name) {
    throw new CatalogOpsError("A service needs a name.");
  }
  let tradeCode;
  try {
    tradeCode = await authorizeCatalogTradeCode(db, access.businessId, input.tradeCode ?? null);
  } catch (error) {
    throw new CatalogOpsError(
      error instanceof InactiveCatalogTradeError
        ? error.message
        : "That trade is not active on this business.",
    );
  }
  if (!pricingModeAllowedForTrade(tradeCode, "CUSTOM_QUOTE")) {
    throw new CatalogOpsError("Custom quote services are not allowed for that trade.");
  }
  const websiteSlug = await allocateUnusedWebsiteSlug(db, access.businessId, name);
  return db.serviceCatalogItem.create({
    data: {
      businessId: access.businessId,
      tradeCode,
      name,
      websiteSlug,
      pricingMode: "CUSTOM_QUOTE",
      price: null,
      description: input.description?.trim() || null,
      category: normalizeServiceCategory(input.category),
      recurrenceEligible: catalogRecurrenceEligibleForTrade(tradeCode, true, false, false),
    },
  });
}

export async function setOwnedServiceCatalogItemActive(
  db: Db,
  access: BusinessAccess,
  input: { id: string; active: boolean },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CATALOG);
  await requireSaasOperatingEntitlement(db, access);
  const item = access.assertOwned(
    await db.serviceCatalogItem.findFirst({
      where: { id: input.id, ...access.scope },
    }),
  );
  return db.serviceCatalogItem.update({
    where: { id: item.id },
    data: { active: input.active },
  });
}

export async function deleteOwnedServiceCatalogItem(
  db: Db,
  access: BusinessAccess,
  input: { id: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CATALOG);
  await requireSaasOperatingEntitlement(db, access);
  const item = access.assertOwned(
    await db.serviceCatalogItem.findFirst({
      where: { id: input.id, ...access.scope },
    }),
  );
  await db.serviceCatalogItem.delete({
    where: { id: item.id },
  });
  return item;
}

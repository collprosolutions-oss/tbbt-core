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

type Db = PrismaClient;

export async function setOwnedServiceCatalogItemActive(
  db: Db,
  access: BusinessAccess,
  input: { id: string; active: boolean },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CATALOG);
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

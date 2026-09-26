/**
 * Tenant-scoped Integration Center loader.
 *
 * Reuses `loadGoLiveCenter` for health and `loadProductEntitlement` for
 * plan capability truth. Callers must pass the authenticated workspace
 * — never a browser-supplied business id.
 *
 * This loader does not connect providers, mutate billing, or log secrets.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { loadGoLiveCenter, requireGoLiveAccess, type GoLiveAccess } from "@/lib/go-live-data";
import { loadProductEntitlement } from "@/lib/product-entitlements";
import { buildIntegrationCenter } from "@/lib/integrations/center";
import { INTEGRATION_REGISTRY } from "@/lib/integrations/registry";
import type { IntegrationCenter, IntegrationDefinition } from "@/lib/integrations/types";

type Db = PrismaClient | Prisma.TransactionClient;

export function requireIntegrationCenterAccess(access: GoLiveAccess) {
  requireGoLiveAccess(access);
}

export async function loadIntegrationCenter(
  db: Db,
  access: GoLiveAccess,
  registry: readonly IntegrationDefinition[] = INTEGRATION_REGISTRY,
): Promise<IntegrationCenter> {
  requireIntegrationCenterAccess(access);
  if (access.workspace.business?.id && access.workspace.business.id !== access.businessId) {
    throw new Error("Integration Center cannot load a foreign business.");
  }
  const goLive = await loadGoLiveCenter(db, access);
  const entitlement = await loadProductEntitlement(db, access.businessId);
  if (entitlement.businessId !== access.businessId) {
    throw new Error("Integration entitlement resolved for a foreign business.");
  }
  return buildIntegrationCenter({
    businessId: access.businessId,
    goLive,
    entitlement: {
      businessId: entitlement.businessId,
      planCode: entitlement.planCode,
      planName: entitlement.planName,
      capabilities: entitlement.capabilities,
    },
    registry,
  });
}

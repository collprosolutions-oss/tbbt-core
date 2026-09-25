/**
 * Tenant-scoped Handyman starter catalog installer.
 *
 * This is the existing Services-page install behavior, extracted so
 * onboarding and /services share one write path. Cleaning uses
 * installStarterCatalogForTrade("CLEANING") and is never written here.
 */
import type { PrismaClient } from "@prisma/client";
import { installStarterCatalogForTrade } from "@/lib/trade-catalog";

export async function installHandymanStarterCatalogForBusiness(
  db: PrismaClient,
  businessId: string,
) {
  return installStarterCatalogForTrade(db, businessId, "HANDYMAN");
}

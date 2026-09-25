/**
 * Trade-aware starter catalog install.
 *
 * Each trade's starter rows are tenant-scoped and tagged with tradeCode.
 * Installing Cleaning never writes Cleaning services into a Handyman-only
 * catalog. Deduping is per trade so the same display name can exist on
 * another trade later without colliding.
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import {
  planCleaningStarterCatalogInstall,
  cleaningStarterPricingMode,
} from "@/lib/cleaning-starter-catalog";
import {
  planStarterCatalogInstall,
  starterIntakeFields,
  starterPricingMode,
} from "@/lib/handyman-starter-catalog";
import { getTradeConfig } from "@/lib/trade-config";
import { isConfiguredTrade, type TradeCode } from "@/lib/trades";

type CatalogDb = PrismaClient | Prisma.TransactionClient;

export async function installStarterCatalogForTrade(
  db: CatalogDb,
  businessId: string,
  tradeCode: string,
) {
  if (!isConfiguredTrade(tradeCode)) {
    return { added: 0, skipped: 0, pending: 0, tradeCode: null as TradeCode | null };
  }
  const source = getTradeConfig(tradeCode).catalogStarterSource;
  if (source === "HANDYMAN_STARTER") {
    return {
      ...(await installHandymanStarterRows(db, businessId)),
      tradeCode: "HANDYMAN" as const,
    };
  }
  if (source === "CLEANING_STARTER") {
    return {
      ...(await installCleaningStarterRows(db, businessId)),
      tradeCode: "CLEANING" as const,
    };
  }
  return { added: 0, skipped: 0, pending: 0, tradeCode };
}

async function installHandymanStarterRows(db: CatalogDb, businessId: string) {
  const existing = await db.serviceCatalogItem.findMany({
    where: { businessId, tradeCode: "HANDYMAN" },
    select: { name: true },
  });
  const plan = planStarterCatalogInstall(existing.map((item) => item.name));
  for (const service of plan.add) {
    await db.serviceCatalogItem.create({
      data: {
        businessId,
        tradeCode: "HANDYMAN",
        name: service.name,
        description: service.description,
        pricingMode: starterPricingMode(service),
        price:
          service.startingPrice == null
            ? null
            : new Prisma.Decimal(service.startingPrice),
        category: service.category,
        active: true,
        recurrenceEligible: false,
        unitLabel: "",
        ...starterIntakeFields(service),
      },
    });
  }
  return {
    added: plan.add.length,
    skipped: plan.skip.length,
    pending: plan.pending.length,
  };
}

async function installCleaningStarterRows(db: CatalogDb, businessId: string) {
  const existing = await db.serviceCatalogItem.findMany({
    where: { businessId, tradeCode: "CLEANING" },
    select: { name: true },
  });
  const plan = planCleaningStarterCatalogInstall(existing.map((item) => item.name));
  for (const service of plan.add) {
    await db.serviceCatalogItem.create({
      data: {
        businessId,
        tradeCode: "CLEANING",
        name: service.name,
        description: service.description,
        pricingMode: cleaningStarterPricingMode(service),
        price:
          service.startingPrice == null
            ? null
            : new Prisma.Decimal(service.startingPrice),
        category: service.category,
        active: true,
        recurrenceEligible: Boolean(service.recurrenceEligible),
        unitLabel: service.unitLabel ?? "",
      },
    });
  }
  return {
    added: plan.add.length,
    skipped: plan.skip.length,
    pending: plan.pending.length,
  };
}

export function catalogItemMatchesTrade(
  item: { tradeCode?: string | null },
  tradeCode: string,
) {
  return (item.tradeCode ?? "HANDYMAN") === tradeCode;
}

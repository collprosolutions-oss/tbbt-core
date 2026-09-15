/**
 * Tenant-scoped Handyman starter catalog installer.
 *
 * This is the existing Services-page install behavior, extracted so
 * onboarding and /services share one write path. It copies the current
 * Handyman starter templates into one business. It does not change
 * prices, create a Cleaning catalog, or touch another tenant.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  planStarterCatalogInstall,
  starterIntakeFields,
  starterPricingMode,
} from "@/lib/handyman-starter-catalog";

export async function installHandymanStarterCatalogForBusiness(
  db: PrismaClient,
  businessId: string,
) {
  const existing = await db.serviceCatalogItem.findMany({
    where: { businessId },
    select: { name: true },
  });

  const plan = planStarterCatalogInstall(existing.map((item) => item.name));

  if (plan.add.length > 0) {
    await db.$transaction(
      plan.add.map((service) =>
        db.serviceCatalogItem.create({
          data: {
            businessId,
            name: service.name,
            description: service.description,
            pricingMode: starterPricingMode(service),
            price:
              service.startingPrice == null
                ? null
                : new Prisma.Decimal(service.startingPrice),
            category: service.category,
            active: true,
            ...starterIntakeFields(service),
          },
        }),
      ),
    );
  }

  return {
    added: plan.add.length,
    skipped: plan.skip.length,
    pending: plan.pending.length,
  };
}

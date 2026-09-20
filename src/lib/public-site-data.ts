import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ensureBusinessPublicContactSchema } from "@/lib/business-contact";
import {
  COLLPRO_RENO_SLUGS,
  groupPublicCatalog,
  toPublicCatalogItem,
  type PublicBusiness,
  type PublicCatalogGroup,
  type PublicCatalogItem,
} from "@/lib/public-site";

type PublicSiteDb = PrismaClient | Prisma.TransactionClient;

export type PublicSitePayload = {
  business: PublicBusiness;
  items: PublicCatalogItem[];
  groups: PublicCatalogGroup[];
};

export async function loadPublicBusiness(slug: string, db: PublicSiteDb = prisma) {
  const safeSlug = slug.trim().toLowerCase();
  if (!safeSlug) return null;
  await ensureBusinessPublicContactSchema(db);
  return db.business.findUnique({
    where: { slug: safeSlug },
    select: {
      id: true,
      name: true,
      slug: true,
      tradeCode: true,
      publicPhone: true,
      publicEmail: true,
      publicWebsite: true,
      publicServiceAreaLabel: true,
    },
  });
}

export async function loadDefaultPublicBusiness(db: PublicSiteDb = prisma) {
  for (const slug of COLLPRO_RENO_SLUGS) {
    const business = await loadPublicBusiness(slug, db);
    if (business) return business;
  }
  return null;
}

export async function loadPublicCatalog(business: PublicBusiness, db: PublicSiteDb = prisma) {
  const rows = await db.serviceCatalogItem.findMany({
    where: { businessId: business.id, active: true },
    select: {
      id: true,
      name: true,
      description: true,
      category: true,
      pricingMode: true,
      price: true,
      intakeMeasurementMode: true,
      intakeMeasurementAxes: true,
      intakeMeasurementUnit: true,
    },
    orderBy: { name: "asc" },
  });
  const items = rows.map(toPublicCatalogItem);
  return {
    items,
    groups: groupPublicCatalog(items, business.tradeCode),
  };
}

export async function loadPublicSite(
  slug: string,
  db: PublicSiteDb = prisma,
): Promise<PublicSitePayload | null> {
  const business = await loadPublicBusiness(slug, db);
  if (!business) return null;
  const catalog = await loadPublicCatalog(business, db);
  return { business, ...catalog };
}

export async function loadPublicAboutCopy(businessId: string, db: PublicSiteDb = prisma) {
  const settings = await db.businessSettings.findUnique({
    where: { businessId },
    select: { approvedPublicAboutCopy: true },
  });
  return settings?.approvedPublicAboutCopy ?? "";
}

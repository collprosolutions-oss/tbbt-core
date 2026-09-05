import { prisma } from "@/lib/prisma";
import {
  COLLPRO_RENO_SLUGS,
  groupPublicCatalog,
  toPublicCatalogItem,
  type PublicBusiness,
  type PublicCatalogGroup,
  type PublicCatalogItem,
} from "@/lib/public-site";

export type PublicSitePayload = {
  business: PublicBusiness;
  items: PublicCatalogItem[];
  groups: PublicCatalogGroup[];
};

export async function loadPublicBusiness(slug: string) {
  const safeSlug = slug.trim().toLowerCase();
  if (!safeSlug) return null;
  return prisma.business.findUnique({
    where: { slug: safeSlug },
    select: { id: true, name: true, slug: true, tradeCode: true },
  });
}

export async function loadDefaultPublicBusiness() {
  for (const slug of COLLPRO_RENO_SLUGS) {
    const business = await loadPublicBusiness(slug);
    if (business) return business;
  }
  return null;
}

export async function loadPublicCatalog(business: PublicBusiness) {
  const rows = await prisma.serviceCatalogItem.findMany({
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

export async function loadPublicSite(slug: string): Promise<PublicSitePayload | null> {
  const business = await loadPublicBusiness(slug);
  if (!business) return null;
  const catalog = await loadPublicCatalog(business);
  return { business, ...catalog };
}

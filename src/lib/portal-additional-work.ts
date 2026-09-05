import { prisma } from "@/lib/prisma";
import {
  groupPublicCatalog,
  toPublicCatalogItem,
  type PublicCatalogGroup,
} from "@/lib/public-site";

export async function loadPortalAdditionalWorkCatalog(business: {
  id: string;
  tradeCode: string;
}): Promise<PublicCatalogGroup[]> {
  const rows = await prisma.serviceCatalogItem.findMany({
    where: { businessId: business.id, active: true },
    select: {
      id: true,
      name: true,
      description: true,
      category: true,
      pricingMode: true,
      price: true,
    },
    orderBy: { name: "asc" },
  });
  return groupPublicCatalog(rows.map(toPublicCatalogItem), business.tradeCode);
}

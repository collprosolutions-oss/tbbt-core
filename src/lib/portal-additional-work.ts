import { prisma } from "@/lib/prisma";
import {
  groupPublicCatalog,
  toPublicCatalogItem,
  type PublicCatalogItem,
} from "@/lib/public-site";

export async function loadPortalAdditionalWorkCatalog(business: {
  id: string;
  tradeCode: string;
}): Promise<PublicCatalogItem[]> {
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
  const items = rows.map(toPublicCatalogItem);
  return groupPublicCatalog(items, business.tradeCode).flatMap(
    (group) => group.items,
  );
}

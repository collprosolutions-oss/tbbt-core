import type { Prisma, PrismaClient } from "@prisma/client";
import { slugifyLocalPagePart } from "@/lib/service-areas";

type Db = PrismaClient | Prisma.TransactionClient;

export function websiteServiceSlug(name: string) {
  return slugifyLocalPagePart(name) || "service";
}

export function allocateUniqueServiceSlugs(names: string[]) {
  const used = new Set<string>();
  return names.map((name) => {
    const base = websiteServiceSlug(name);
    let slug = base;
    let n = 2;
    while (used.has(slug)) {
      slug = `${base}-${n}`;
      n += 1;
    }
    used.add(slug);
    return slug;
  });
}

export function nextUniqueWebsiteSlug(name: string, used: Set<string>) {
  const base = websiteServiceSlug(name);
  let slug = base;
  let n = 2;
  while (used.has(slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  used.add(slug);
  return slug;
}

export async function allocateUnusedWebsiteSlug(
  db: Db,
  businessId: string,
  name: string,
) {
  const existing = await db.serviceCatalogItem.findMany({
    where: { businessId, websiteSlug: { not: null } },
    select: { websiteSlug: true },
  });
  const used = new Set(
    existing
      .map((row) => row.websiteSlug)
      .filter((slug): slug is string => Boolean(slug)),
  );
  return nextUniqueWebsiteSlug(name, used);
}

export async function ensureCatalogWebsiteSlugs(
  db: Db,
  businessId: string,
  items: Array<{ id: string; name: string; websiteSlug?: string | null }>,
) {
  const existing = await db.serviceCatalogItem.findMany({
    where: { businessId, websiteSlug: { not: null } },
    select: { id: true, websiteSlug: true },
  });
  const byId = new Map(
    existing
      .filter((row) => row.websiteSlug)
      .map((row) => [row.id, row.websiteSlug as string]),
  );
  const used = new Set(byId.values());
  const slugs = new Map<string, string>();

  for (const item of items) {
    const persisted = item.websiteSlug?.trim() || byId.get(item.id) || "";
    if (persisted) {
      slugs.set(item.id, persisted);
      used.add(persisted);
      continue;
    }
    const slug = nextUniqueWebsiteSlug(item.name, used);
    await db.serviceCatalogItem.update({
      where: { id: item.id },
      data: { websiteSlug: slug },
    });
    slugs.set(item.id, slug);
    byId.set(item.id, slug);
  }

  return slugs;
}

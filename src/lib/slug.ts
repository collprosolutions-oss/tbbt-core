import type { Prisma } from "@prisma/client";

type SlugStore = {
  business: {
    findUnique: (args: {
      where: { slug: string };
      select: { id: true };
    }) => Promise<{ id: string } | null>;
  };
};

export function slugifyName(name: string) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "business";
}

export async function allocateBusinessSlug(
  name: string,
  db: SlugStore | Prisma.TransactionClient,
) {
  const base = slugifyName(name);
  let candidate = base;
  let suffix = 2;

  while (await db.business.findUnique({ where: { slug: candidate }, select: { id: true } })) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}

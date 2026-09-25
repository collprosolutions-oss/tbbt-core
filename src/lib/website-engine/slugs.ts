import { slugifyLocalPagePart } from "@/lib/service-areas";

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

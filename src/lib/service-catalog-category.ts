/**
 * Generic, trade-agnostic service-category helpers.
 *
 * ServiceCatalogItem.category (see prisma/schema.prisma) is a plain
 * per-business string column, not a shared enum. This file only groups and
 * normalizes by that persisted value -- it must never hardcode Handyman (or
 * any other single trade)'s category names, so a future trade (Cleaning,
 * Painting, Landscaping, ...) can use its own category vocabulary without
 * any change here. Handyman-specific category names/ordering live in
 * src/lib/handyman-starter-catalog.ts and are passed in by callers as a
 * `preferredOrder`, not baked into this module.
 */

/**
 * Fallback used when a service has no meaningful persisted category.
 * Matches the app's pre-existing OTHER_SERVICES_CATEGORY fallback value
 * (src/lib/handyman-starter-catalog.ts), which is also this column's
 * database default (see prisma/schema.prisma) and the value the Step 3
 * migration backfills onto any existing service that doesn't match a known
 * Handyman starter-catalog name.
 */
export const DEFAULT_SERVICE_CATEGORY = "Other Services";

export function normalizeServiceCategory(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : DEFAULT_SERVICE_CATEGORY;
}

/**
 * Groups items by their own persisted `category` field (NOT by matching
 * name against any hardcoded list). `preferredOrder` lets a caller that
 * knows its business's trade (e.g. Handyman) request a specific display
 * order for the categories it recognizes; any other category present on
 * the data is appended afterward in alphabetical order, with the
 * DEFAULT_SERVICE_CATEGORY fallback bucket always shown last.
 */
export function groupServiceCatalogItemsByCategory<
  T extends { category: string; id?: string; templateKey?: string },
>(items: T[], preferredOrder: readonly string[] = []) {
  const groups = new Map<string, T[]>();
  const seen = new Set<string>();

  for (const item of items) {
    const dedupeKey = item.id ?? item.templateKey;
    if (dedupeKey) {
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
    }
    const category = normalizeServiceCategory(item.category);
    const current = groups.get(category);
    if (current) {
      current.push(item);
    } else {
      groups.set(category, [item]);
    }
  }

  const ordered: Array<{ category: string; items: T[] }> = [];
  const used = new Set<string>();

  for (const category of preferredOrder) {
    const grouped = groups.get(category);
    if (grouped?.length) {
      ordered.push({ category, items: grouped });
      used.add(category);
    }
  }

  const remaining = [...groups.keys()]
    .filter((category) => !used.has(category) && category !== DEFAULT_SERVICE_CATEGORY)
    .sort((a, b) => a.localeCompare(b));

  for (const category of remaining) {
    ordered.push({ category, items: groups.get(category)! });
    used.add(category);
  }

  const other = groups.get(DEFAULT_SERVICE_CATEGORY);
  if (other?.length && !used.has(DEFAULT_SERVICE_CATEGORY)) {
    ordered.push({ category: DEFAULT_SERVICE_CATEGORY, items: other });
  }

  return ordered;
}

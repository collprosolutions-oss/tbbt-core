/**
 * Starting store/ZIP context from the business service area.
 * One preferred location per business/provider — not multi-store search.
 */
import { resolveBusinessServiceArea } from "@/lib/business-service-area";

const COLLPRO_RENO_SLUGS = new Set([
  "collpro-reno",
  "collpro-reno-handyman-services",
]);

export type SupplierLocationContext = {
  zip: string | null;
  label: string | null;
};

export function defaultSupplierLocationForBusiness(business: {
  slug: string;
}): SupplierLocationContext {
  const slug = business.slug.trim().toLowerCase();
  const area = resolveBusinessServiceArea(business);
  if (COLLPRO_RENO_SLUGS.has(slug)) {
    return {
      zip: "33901",
      label: area.cities[0]
        ? `${area.cities[0]}, ${area.region ?? "FL"}`
        : "Fort Myers, FL",
    };
  }
  if (area.cities[0] && area.region) {
    return { zip: null, label: `${area.cities[0]}, ${area.region}` };
  }
  return { zip: null, label: null };
}

export function supplierLocationKey(zip?: string | null) {
  const trimmed = zip?.trim() ?? "";
  return trimmed || "_";
}

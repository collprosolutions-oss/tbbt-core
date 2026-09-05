/**
 * Tenant-scoped service-area configuration for public intake.
 *
 * This is not a second CRM and not hardcoded into shared form UI.
 * The request form receives a resolved { cities, region, country } payload.
 *
 * Preview and Production share a database, and Preview builds skip
 * `prisma migrate deploy`. Until a settings-backed model can ship with a
 * production migration, CollPro's known service area lives here by slug.
 * Other businesses get an empty area (free-text city, no default state).
 */
export type BusinessServiceArea = {
  cities: string[];
  /** Default state/region code when known, e.g. "FL". Never assumed globally. */
  region: string | null;
  /** ISO-ish country code. "US" requires ZIP on the public form. */
  country: string | null;
};

export const EMPTY_BUSINESS_SERVICE_AREA: BusinessServiceArea = {
  cities: [],
  region: null,
  country: null,
};

/**
 * CollPro Reno's current public service-area cities. Kept out of reusable
 * UI so another subscriber does not inherit Fort Myers / Florida.
 */
const COLLPRO_RENO_SERVICE_AREA: BusinessServiceArea = {
  cities: ["Fort Myers", "Cape Coral", "North Fort Myers"],
  region: "FL",
  country: "US",
};

const SERVICE_AREA_BY_SLUG: Record<string, BusinessServiceArea> = {
  "collpro-reno": COLLPRO_RENO_SERVICE_AREA,
  "collpro-reno-handyman-services": COLLPRO_RENO_SERVICE_AREA,
};

export function resolveBusinessServiceArea(business: {
  slug: string;
}): BusinessServiceArea {
  const configured = SERVICE_AREA_BY_SLUG[business.slug.trim().toLowerCase()];
  if (!configured) {
    return EMPTY_BUSINESS_SERVICE_AREA;
  }
  return {
    cities: [...configured.cities],
    region: configured.region,
    country: configured.country,
  };
}

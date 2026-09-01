import { getBusinessLogoSrc } from "@/lib/business-branding";
import {
  HANDYMAN_CATALOG_CATEGORIES,
} from "@/lib/handyman-starter-catalog";
import { getAppUrl } from "@/lib/mail";
import { formatCatalogPriceLabel } from "@/lib/pricing-mode";
import { groupServiceCatalogItemsByCategory } from "@/lib/service-catalog-category";
import { isActiveTrade } from "@/lib/trades";

/**
 * CollPro Reno is the live customer-facing launch business on this
 * deployment (www.collproreno.com / Vercel project collpro-reno). Both
 * historical slugs are recognized -- see src/lib/business-branding.ts.
 *
 * This file is presentation/contact copy for the public website only.
 * It is not Settings, not a second CRM, and not a service-area engine.
 */
export const COLLPRO_RENO_SLUGS = [
  "collpro-reno",
  "collpro-reno-handyman-services",
] as const;

export const DEFAULT_PUBLIC_BUSINESS_SLUG = "collpro-reno";

export const COLLPRO_RENO_DISPLAY_NAME = "CollPro Reno Handyman Services";
export const COLLPRO_RENO_PHONE = "239-357-8199";

export const PUBLIC_PRICING_DISCLAIMER =
  "Prices shown are starting labor prices where applicable. Final pricing depends on project scope, site conditions, materials, access, and other project details.";

export const HOW_IT_WORKS_STEPS = [
  {
    step: 1,
    title: "Tell Us What You Need",
    body: "Choose one or more handyman tasks, or describe something else. Photos are optional and help us understand the work.",
  },
  {
    step: 2,
    title: "We Review Your Project",
    body: "CollPro Reno reviews your request, selected tasks, and notes before anyone is scheduled.",
  },
  {
    step: 3,
    title: "Receive Your Estimate",
    body: "You receive a written estimate to review. Estimates are not instant and are not a final invoice.",
  },
  {
    step: 4,
    title: "Approve & Schedule",
    body: "After you approve the estimate, the work can be scheduled.",
  },
  {
    step: 5,
    title: "We Complete the Work",
    body: "The approved work is completed, and you can follow the project online through a private link when one is provided.",
  },
] as const;

export const TRUST_POINTS = [
  {
    title: "Skilled Project Work",
    body: "Quality-minded workmanship on the jobs we take on.",
  },
  {
    title: "Clear Estimates",
    body: "You review a written estimate before work is scheduled.",
  },
  {
    title: "Reliable Communication",
    body: "Your request becomes an organized project record we can follow up on.",
  },
  {
    title: "Respect for Your Home",
    body: "We treat your property carefully and keep the work organized.",
  },
] as const;

export const SERVICE_AREA_COPY =
  "Serving homeowners in the Fort Myers / Cape Coral area. Submit your project address and we'll confirm service availability for your location.";

export const PRIMARY_CTA_LABEL = "Get a Free Quote";
export const TEXT_US_LABEL = "Text Us";

export const ABOUT_COPY = {
  eyebrow: "About Us",
  title: "Reliable. Professional. Done Right.",
  lead:
    "CollPro Reno Handyman Services helps homeowners with repairs, installations, and home-improvement projects — from a single task to several jobs in one visit.",
  body:
    "We focus on attention to project details, clear estimates, organized communication, and practical solutions. Quality-minded workmanship matters on every job we take on.",
  signature: "— CollPro Reno Team",
  priorityTitle: "Your Home. Our Priority.",
  priorityBody: "We treat every home carefully and keep the work organized.",
  points: [
    "Clear project communication from the first request",
    "Organized written estimates you can review before scheduling",
    "Homeowner-focused service and attention to detail",
    "One request can include multiple tasks for the same visit",
  ],
} as const;

export const REVIEWS_PLACEHOLDER_COPY =
  "Real customer feedback will appear here as it becomes available.";

export const PUBLIC_HOME_HERO_IMAGE = "/brand/illustrative/craftsman-hero.jpg";
export const PUBLIC_SERVICES_HERO_IMAGE = "/brand/illustrative/tools-services.jpg";
export const PUBLIC_REVIEWS_HERO_IMAGE = "/brand/illustrative/tools-reviews.jpg";
export const PUBLIC_AREA_HERO_IMAGE = "/brand/illustrative/coastal-area.jpg";
export const PUBLIC_CONTACT_HERO_IMAGE = "/brand/illustrative/dusk-home.jpg";
export const PUBLIC_PROJECTS_HERO_IMAGE = "/brand/projects/lanai-porch.jpg";
export const PUBLIC_ABOUT_HERO_IMAGE = "/brand/projects/feature-wall-tv.jpg";
export const PUBLIC_QUOTE_HERO_IMAGE = "/brand/projects/wall-cabinets.jpg";
export const PUBLIC_ABOUT_PHOTO = "/brand/projects/lanai-porch.jpg";
export const PUBLIC_INNER_HERO_IMAGE = "/brand/illustrative/tools-services.jpg";

const CATEGORY_VISUALS: Record<string, string> = {
  "Doors & Locks": "/brand/projects/door-install.jpg",
  "Mounting & Hanging": "/brand/projects/picture-hanging.jpg",
  "Walls & Drywall": "/brand/projects/bathroom-shiplap.jpg",
  "Trim & Carpentry": "/brand/projects/lanai-porch.jpg",
  "Bathroom / Caulking / Accessories": "/brand/projects/bathroom-toilet.jpg",
  "Furniture & Assembly": "/brand/projects/furniture-assembly.jpg",
  "Exterior Repairs": "/brand/projects/exterior-carpentry.jpg",
  "Cabinets / Kitchen": "/brand/projects/wall-cabinets.jpg",
  "Fans & Fixtures": "/brand/projects/lanai-porch.jpg",
  "Punch Lists / Small Jobs": "/brand/projects/dishwasher.jpg",
  "General Home Repairs": "/brand/projects/feature-wall-tv.jpg",
};

export function publicCategoryPhoto(category: string) {
  return CATEGORY_VISUALS[category] ?? "/brand/projects/feature-wall-tv.jpg";
}

export const SERVICE_AREA_MAP_SRC =
  "https://www.openstreetmap.org/export/embed.html?bbox=-82.12%2C26.48%2C-81.70%2C26.74&layer=mapnik&marker=26.60%2C-81.91";
export const SERVICE_AREA_MAP_IMAGE = "/brand/illustrative/service-area-map.jpg";

export const HOME_FEATURED_PROJECT_IDS = [
  "feature-wall-tv",
  "closet",
  "wall-cabinets",
  "lanai-porch",
] as const;

export const HOMEPAGE_CATEGORY_LIMIT = 8;

export type PublicCatalogItem = {
  id: string;
  name: string;
  description: string | null;
  category: string;
  pricingMode: string;
  priceLabel: string;
};

export type PublicCatalogGroup = {
  category: string;
  items: PublicCatalogItem[];
};

export type PublicBusiness = {
  id: string;
  name: string;
  slug: string;
  tradeCode: string;
};

export function isCollProRenoSlug(slug: string) {
  return (COLLPRO_RENO_SLUGS as readonly string[]).includes(
    slug.trim().toLowerCase(),
  );
}

export function publicDisplayName(business: { name: string; slug: string }) {
  if (isCollProRenoSlug(business.slug)) {
    return COLLPRO_RENO_DISPLAY_NAME;
  }
  return business.name;
}

export function publicPhone(slug: string) {
  return isCollProRenoSlug(slug) ? COLLPRO_RENO_PHONE : null;
}

export function publicLogoSrc(slug: string) {
  return getBusinessLogoSrc(slug);
}

export function publicSiteUrl(slug: string) {
  const origin = getAppUrl();
  if (isCollProRenoSlug(slug)) {
    return origin ? `${origin}/` : "/";
  }
  return origin ? `${origin}/hire/${slug}` : `/hire/${slug}`;
}

export function toPublicCatalogItem(item: {
  id: string;
  name: string;
  description: string | null;
  category: string;
  pricingMode: string;
  price: { toString(): string } | number | null;
}): PublicCatalogItem {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    category: item.category,
    pricingMode: item.pricingMode,
    priceLabel: formatCatalogPriceLabel(item.pricingMode, item.price),
  };
}

export function groupPublicCatalog(
  items: PublicCatalogItem[],
  tradeCode: string,
): PublicCatalogGroup[] {
  const preferredOrder = isActiveTrade(tradeCode)
    ? HANDYMAN_CATALOG_CATEGORIES
    : [];
  return groupServiceCatalogItemsByCategory(items, preferredOrder);
}

export function preferredPublicCategoryOrder(tradeCode: string) {
  return isActiveTrade(tradeCode) ? [...HANDYMAN_CATALOG_CATEGORIES] : [];
}

export type PopularPublicCategory = {
  category: string;
  itemCount: number;
  descriptor: string;
};

/** High-level homepage cards from real persisted catalog groups — never a second catalog. */
export function popularPublicCategories(
  groups: PublicCatalogGroup[],
  limit = HOMEPAGE_CATEGORY_LIMIT,
): PopularPublicCategory[] {
  return groups.slice(0, limit).map((group) => ({
    category: group.category,
    itemCount: group.items.length,
    descriptor: publicCategoryDescriptor(group.items),
  }));
}

export function publicCategoryDescriptor(items: PublicCatalogItem[]) {
  const names = items.map((item) => item.name).filter(Boolean);
  if (names.length === 0) return "Handyman services";
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]}, and more`;
}

export function selectedWorkQuery(input: {
  catalogIds?: string[];
  includeOther?: boolean;
  otherDescription?: string;
}) {
  const params = new URLSearchParams();
  if (input.catalogIds?.length) params.set("services", input.catalogIds.join(","));
  if (input.includeOther) {
    params.set("other", "1");
    if (input.otherDescription?.trim()) params.set("otherText", input.otherDescription.trim());
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function publicServicesPath(
  slug: string,
  selected?: {
    catalogIds?: string[];
    includeOther?: boolean;
    otherDescription?: string;
  },
) {
  return `/hire/${slug}/services${selected ? selectedWorkQuery(selected) : ""}`;
}

export function publicAboutPath(slug: string) {
  return `/hire/${slug}/about`;
}

export function publicRequestPath(slug: string) {
  return `/r/${slug}`;
}

export function publicHomePath(slug: string) {
  return `/hire/${slug}`;
}

export function publicProjectsPath(slug: string) {
  return `/hire/${slug}/projects`;
}

export function publicReviewsPath(slug: string) {
  return `/hire/${slug}/reviews`;
}

export function publicServiceAreaPath(slug: string) {
  return `/hire/${slug}/service-area`;
}

export function publicContactPath(slug: string) {
  return `/hire/${slug}/contact`;
}

export function localBusinessJsonLd(input: {
  name: string;
  slug: string;
  phone: string | null;
  logoSrc: string | null;
  description: string;
}) {
  const origin = getAppUrl();
  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name: input.name,
    description: input.description,
    url: origin
      ? isCollProRenoSlug(input.slug)
        ? `${origin}/`
        : `${origin}/hire/${input.slug}`
      : undefined,
  };
  if (input.phone) {
    data.telephone = input.phone;
  }
  if (input.logoSrc && origin) {
    data.image = `${origin}${input.logoSrc}`;
  }
  return data;
}

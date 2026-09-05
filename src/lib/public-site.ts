import { getBusinessLogoSrc } from "@/lib/business-branding";
import {
  HANDYMAN_CATALOG_CATEGORIES,
} from "@/lib/handyman-starter-catalog";
import { getAppUrl } from "@/lib/mail";
import { formatCatalogPriceLabel, publicCatalogUnitAmount } from "@/lib/pricing-mode";
import {
  selectedWorkQuery as encodeSelectedWorkQuery,
  type SelectedWorkQueryInput,
} from "@/lib/selected-work";
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
  title: "About Us",
  lead: "Experience, craftsmanship, and dependable service for homeowners.",
} as const;

export const DEFAULT_PUBLIC_ABOUT_STORY = [
  "We've been working in construction and carpentry since 1992, coming from a family tradition of craftsmanship. Over the years, that experience has included hands-on carpentry, general contracting, subcontracting, project supervision, property work, renovations, and new construction.",
  "That broad background gives us a practical understanding of how homes are built, how different trades come together, and how repairs should be approached. We bring that experience, attention to detail, and commitment to every project.",
].join("\n\n");

export const ABOUT_TRUST_POINTS = [
  {
    title: "Honest Service",
    body: "Clear communication and straightforward recommendations.",
  },
  {
    title: "Quality Workmanship",
    body: "Careful, practical work on the jobs we take on.",
  },
  {
    title: "Customer Focused",
    body: "We treat your home with care and keep the work organized.",
  },
] as const;

export const ABOUT_REASON_CARDS = [
  {
    title: "Skilled & Experienced",
    body: "Construction and carpentry background applied to everyday home repairs.",
  },
  {
    title: "Reliable & Punctual",
    body: "We show up prepared and keep the project moving.",
  },
  {
    title: "Clear Estimates",
    body: "You review a written estimate before work is scheduled.",
  },
  {
    title: "Respect for Your Home",
    body: "We work carefully and leave the job organized.",
  },
  {
    title: "Local & Community Driven",
    body: "Proud to serve homeowners in the Fort Myers / Cape Coral area.",
  },
] as const;

export const REVIEWS_PLACEHOLDER_COPY =
  "Real customer feedback will appear here as it becomes available.";

export const PUBLIC_HOME_HERO_IMAGE = "/brand/illustrative/craftsman-hero.jpg";
export const PUBLIC_SERVICES_HERO_IMAGE = "/brand/illustrative/tools-services.jpg";
/** Neutral TBBT Reviews-hero fallback. Must not contain subscriber branding. */
export const PUBLIC_REVIEWS_HERO_IMAGE = "/brand/illustrative/tools-reviews.jpg";
/**
 * CollPro Reno business-content Reviews hero. Subscriber asset only —
 * never the reusable Reviews template default.
 */
export const COLLPRO_REVIEWS_HERO_IMAGE = "/brand/collpro/reviews-hero.png";
export const PUBLIC_AREA_HERO_IMAGE = "/brand/illustrative/coastal-area.jpg";
export const PUBLIC_CONTACT_HERO_IMAGE = "/brand/illustrative/dusk-home.jpg";
export const PUBLIC_PROJECTS_HERO_IMAGE = "/brand/projects/lanai-porch.jpg";
/** Neutral TBBT About-hero fallback. Must not contain subscriber branding. */
export const PUBLIC_ABOUT_HERO_IMAGE = "/brand/illustrative/craftsman-hero.jpg";
/**
 * CollPro Reno business-content About hero. Visible CollPro branding lives
 * in this subscriber asset only — never in the reusable About template.
 */
export const COLLPRO_ABOUT_HERO_IMAGE = "/brand/collpro/about-hero.png";
export const PUBLIC_ABOUT_STORY_IMAGE = "/brand/projects/door-install.jpg";
/** Neutral TBBT Request-a-Quote hero fallback. Must not contain subscriber branding. */
export const PUBLIC_QUOTE_HERO_IMAGE = "/brand/projects/wall-cabinets.jpg";
/**
 * CollPro Reno business-content Request-a-Quote hero. Subscriber asset only —
 * never the reusable intake template default.
 */
export const COLLPRO_QUOTE_HERO_IMAGE = "/brand/collpro/quote-hero.png";
/** Keep the handyman/customer on the right, left side usable for HTML copy. */
export const COLLPRO_QUOTE_HERO_POSITION = "80% 26%";
export const PUBLIC_QUOTE_HERO_POSITION = "70% 40%";
export const PUBLIC_ABOUT_PHOTO = "/brand/illustrative/craftsman-hero.jpg";
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
export const SERVICE_AREA_MAP_VIEWBOX = "0 0 1280 1024";
/** Simplified Lee County outline in the existing map's image coordinates. */
export const LEE_COUNTY_MAP_POINTS =
  "215.2,341.2 233.0,377.5 231.6,407.0 227.8,435.6 236.8,469.5 260.5,492.8 276.7,519.3 283.7,546.8 303.4,573.7 314.2,602.7 324.5,632.0 347.2,655.7 378.9,668.6 419.1,699.6 459.9,729.3 490.0,741.2 524.9,743.5 560.9,732.7 595.6,720.3 630.5,716.2 658.3,730.8 690.6,754.3 714.3,782.0 749.6,783.0 783.3,783.0 811.6,783.0 836.7,796.6 865.0,796.4 896.2,796.0 926.9,795.8 956.3,795.6 984.8,795.4 1002.9,773.9 1002.5,745.7 1001.8,715.5 1028.3,695.2 1057.3,694.8 1091.4,694.3 1114.2,676.6 1113.5,646.5 1112.8,611.5 1112.0,576.6 1111.6,542.0 1110.9,508.9 1110.4,480.3 1109.8,437.9 1109.8,409.1 1109.9,380.2 1091.4,359.0 1060.1,358.9 1023.2,358.9 990.0,358.9 958.7,358.9 929.5,358.9 901.2,358.9 858.7,358.9 810.3,358.7 769.5,358.7 737.2,358.6 690.8,358.5 660.6,358.4 598.7,358.3 562.2,358.2 534.0,358.1 477.0,357.8 446.4,357.8 403.2,357.7 374.0,357.7 347.4,347.1 319.3,342.7 290.8,339.6 215.2,341.2";

export const LEE_COUNTY_COMMUNITIES = [
  "Fort Myers",
  "Cape Coral",
  "North Fort Myers",
  "Bonita Springs",
  "Estero",
  "Lehigh Acres",
  "Sanibel",
  "Captiva",
  "Pine Island",
  "Matlacha",
  "Bokeelia",
  "St. James City",
  "Alva",
  "Fort Myers Beach",
  "San Carlos Park",
] as const;

export const EXTENDED_SERVICE_AREA_COPY =
  "We serve customers throughout Lee County and surrounding areas. Depending on your location, project size, and travel distance, an additional travel charge may apply to help cover travel time and transportation costs. Any applicable charge will be discussed with you before work is scheduled.";

export const HOME_FEATURED_PROJECT_IDS = [
  "feature-wall-tv",
  "closet",
  "wall-cabinets",
  "lanai-porch",
  "bathroom-shiplap",
  "door-install",
] as const;

export const HOMEPAGE_CATEGORY_LIMIT = 8;

export type PublicCatalogItem = {
  id: string;
  name: string;
  description: string | null;
  category: string;
  pricingMode: string;
  priceLabel: string;
  /** Public unit amount only. Null for CUSTOM_QUOTE. Never a client-trusted price. */
  unitAmount: number | null;
  intakeMeasurementMode: string;
  intakeMeasurementAxes: string;
  intakeMeasurementUnit: string;
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

/** Per-business About hero default. Other subscribers keep the unbranded fallback. */
export function publicAboutHeroImage(slug?: string | null) {
  return slug && isCollProRenoSlug(slug)
    ? COLLPRO_ABOUT_HERO_IMAGE
    : PUBLIC_ABOUT_HERO_IMAGE;
}

/** Per-business Reviews hero default. Other subscribers keep the unbranded fallback. */
export function publicReviewsHeroImage(slug?: string | null) {
  return slug && isCollProRenoSlug(slug)
    ? COLLPRO_REVIEWS_HERO_IMAGE
    : PUBLIC_REVIEWS_HERO_IMAGE;
}

/** Per-business Request-a-Quote hero default. Other subscribers keep the unbranded fallback. */
export function publicQuoteHeroImage(slug?: string | null) {
  return slug && isCollProRenoSlug(slug)
    ? COLLPRO_QUOTE_HERO_IMAGE
    : PUBLIC_QUOTE_HERO_IMAGE;
}

export function publicQuoteHeroPosition(slug?: string | null) {
  return slug && isCollProRenoSlug(slug)
    ? COLLPRO_QUOTE_HERO_POSITION
    : PUBLIC_QUOTE_HERO_POSITION;
}

export const REVIEWS_TRUST_VALUES = [
  {
    title: "Quality Work",
    body: "Careful, practical work on the jobs we take on.",
  },
  {
    title: "On-Time Service",
    body: "We show up prepared and keep the project moving.",
  },
  {
    title: "Honest & Fair",
    body: "Clear communication and straightforward recommendations.",
  },
  {
    title: "Customer Focused",
    body: "We treat your home with care and keep the work organized.",
  },
] as const;

export const REVIEWS_UNRATED_STATUS = {
  title: "Rating / Review status",
  body: "No public reviews are available to display yet.",
} as const;

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
  intakeMeasurementMode?: string | null;
  intakeMeasurementAxes?: string | null;
  intakeMeasurementUnit?: string | null;
}): PublicCatalogItem {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    category: item.category,
    pricingMode: item.pricingMode,
    priceLabel: formatCatalogPriceLabel(item.pricingMode, item.price),
    unitAmount: publicCatalogUnitAmount(item.pricingMode, item.price),
    intakeMeasurementMode: item.intakeMeasurementMode ?? "NONE",
    intakeMeasurementAxes: item.intakeMeasurementAxes ?? "",
    intakeMeasurementUnit: item.intakeMeasurementUnit ?? "IN",
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

export function selectedWorkQuery(input: SelectedWorkQueryInput) {
  return encodeSelectedWorkQuery(input);
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

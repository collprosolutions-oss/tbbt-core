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
    title: "Clear Estimates",
    body: "You review a written estimate before work is scheduled.",
  },
  {
    title: "Respect for Your Home",
    body: "We treat your property carefully and keep the work organized.",
  },
  {
    title: "Convenient Online Requests",
    body: "Describe the work, add optional photos, and send it from your phone.",
  },
  {
    title: "Organized Project Communication",
    body: "Your request becomes an organized project record we can review and follow up on.",
  },
] as const;

export const SERVICE_AREA_COPY =
  "Serving homeowners in the local area. Submit your project address and we will confirm whether we can help at that location. This site does not list a city-by-city service map.";

export const PRIMARY_CTA_LABEL = "Request Service";

export const ABOUT_COPY = {
  eyebrow: "About Us",
  title: "Local handyman help, explained clearly",
  lead:
    "CollPro Reno Handyman Services helps homeowners with repairs, installations, and home-improvement projects — from a single task to several jobs in one visit.",
  points: [
    "Clear project communication from the first request",
    "Organized written estimates you can review before scheduling",
    "Homeowner-focused service and attention to detail",
    "One request can include multiple tasks for the same visit",
  ],
} as const;

export const PROJECTS_PLACEHOLDER_COPY =
  "Project photos will appear here after they are approved for public marketing use. This site does not display stock or generated images as completed work.";

export const REVIEWS_PLACEHOLDER_COPY =
  "Customer reviews will appear here when they are approved for public display. This site does not invent ratings or customer quotes.";

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

export function publicServicesPath(slug: string) {
  return `/hire/${slug}/services`;
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

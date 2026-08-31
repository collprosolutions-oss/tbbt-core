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
    title: "Clear estimates",
    body: "You review a written estimate before work is scheduled.",
  },
  {
    title: "One request, multiple tasks",
    body: "Ask for several handyman jobs in a single visit request.",
  },
  {
    title: "Convenient online requests",
    body: "Describe the work, add optional photos, and send it from your phone.",
  },
  {
    title: "Project communication",
    body: "Your request becomes an organized project record we can review and follow up on.",
  },
  {
    title: "Digital estimate approval",
    body: "When an estimate is ready, you can review and approve it online.",
  },
  {
    title: "Organized project records",
    body: "After approval and scheduling, you can access your project information online when a private project link is sent.",
  },
] as const;

export const SERVICE_AREA_COPY =
  "Tell us the property address when you request service. We will confirm whether we can help at that location. This site does not list a city-by-city service map.";

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

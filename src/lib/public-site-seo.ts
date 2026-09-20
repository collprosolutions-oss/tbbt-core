import type { Metadata } from "next";
import { getAppUrl } from "@/lib/mail";
import {
  isCollProRenoSlug,
  publicDisplayName,
  publicHomePath,
  publicSiteUrl,
  type PublicBusiness,
} from "@/lib/public-site";

const META_DESCRIPTION_MAX = 160;

export function publicCanonicalUrl(slug: string, pathname: string) {
  if (!pathname || pathname === "/" || pathname === publicHomePath(slug)) {
    return publicSiteUrl(slug);
  }
  const origin = getAppUrl();
  return origin ? `${origin}${pathname}` : pathname;
}

export function publicSiteMetaDescription(
  business: PublicBusiness,
  about?: string | null,
) {
  const published = about?.replace(/\s+/g, " ").trim() ?? "";
  if (published) {
    if (published.length <= META_DESCRIPTION_MAX) return published;
    return `${published.slice(0, META_DESCRIPTION_MAX - 3).trimEnd()}...`;
  }
  const name = publicDisplayName(business);
  const area = isCollProRenoSlug(business.slug)
    ? ""
    : business.publicServiceAreaLabel?.trim();
  if (area) {
    return `Request handyman services from ${name} in ${area}. Choose one or more tasks for a single visit request.`;
  }
  return `Request handyman services from ${name}. Choose one or more tasks for a single visit request.`;
}

export function publicTenantPageMetadata(input: {
  business: PublicBusiness;
  title: string;
  description: string;
  pathname: string;
}): Metadata {
  const canonical = publicCanonicalUrl(input.business.slug, input.pathname);
  return {
    title: { absolute: input.title },
    description: input.description,
    alternates: { canonical },
  };
}

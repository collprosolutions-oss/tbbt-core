import type { Metadata } from "next";
import {
  tbbtCanonicalUrl,
  tbbtMarketingRobots,
  TBBT_MARKETING_CANONICAL_ORIGIN,
} from "@/lib/tbbt-marketing-host";
import {
  TBBT_PRODUCT_NAME,
  tbbtPageDescription,
  tbbtPageTitle,
} from "@/lib/tbbt-marketing";

export function tbbtMarketingMetadata(input: {
  page: string;
  pathname: string;
  host: string | null | undefined;
}): Metadata {
  const title = tbbtPageTitle(input.page);
  const description = tbbtPageDescription(input.page);
  const canonical = tbbtCanonicalUrl(input.pathname);
  const robots = tbbtMarketingRobots(input.host);
  const ogTitle =
    input.page === "home"
      ? `${TBBT_PRODUCT_NAME} — ${title}`
      : `${title} · ${TBBT_PRODUCT_NAME}`;

  return {
    title: input.page === "home" ? { absolute: ogTitle } : title,
    description,
    applicationName: TBBT_PRODUCT_NAME,
    metadataBase: new URL(TBBT_MARKETING_CANONICAL_ORIGIN),
    alternates: { canonical },
    robots: {
      index: robots.index,
      follow: robots.follow,
      googleBot: {
        index: robots.index,
        follow: robots.follow,
      },
    },
    openGraph: {
      type: "website",
      url: canonical,
      siteName: TBBT_PRODUCT_NAME,
      title: ogTitle,
      description,
      locale: "en_US",
    },
    twitter: {
      card: "summary",
      title: ogTitle,
      description,
    },
  };
}

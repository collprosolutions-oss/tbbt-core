/**
 * Host-aware `/` metadata. CollPro's unpublished compatibility homepage
 * gets a canonical only on CollPro public hosts. Tenant, unknown, and
 * preview hosts never receive a CollPro canonical.
 */
import type { Metadata } from "next";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  COLLPRO_RENO_DISPLAY_NAME,
  isCollProRenoSlug,
  publicDisplayName,
  publicHomePath,
} from "@/lib/public-site";
import { publicCanonicalUrl } from "@/lib/public-site-seo";
import { tbbtMarketingMetadata } from "@/lib/tbbt-marketing-seo";
import { isCollProPublicHost, shouldServeTbbtMarketingHome } from "@/lib/tbbt-marketing-host";
import { resolvePublicRoot } from "@/lib/website-engine/hosts";
import { loadPublicWebsiteView } from "@/lib/website-engine/public";
import { viewHomeMetadata } from "@/lib/website-engine/seo";

type Db = PrismaClient | Prisma.TransactionClient;

const COLLPRO_HOME_DESCRIPTION =
  "Request handyman services from CollPro Reno Handyman Services. Choose one or more tasks for a single visit request.";

function collproCompatibilityHomeMetadata(
  host: string | null | undefined,
  slug: string,
  origin: string | null | undefined,
): Metadata {
  const metadata: Metadata = {
    title: { absolute: `${COLLPRO_RENO_DISPLAY_NAME} | Handyman Services` },
    description: COLLPRO_HOME_DESCRIPTION,
  };
  if (!isCollProPublicHost(host)) return metadata;
  return {
    ...metadata,
    alternates: { canonical: publicCanonicalUrl(slug, "/", origin) },
  };
}

export async function publicRootPageMetadata(
  db: Db,
  host: string | null | undefined,
): Promise<Metadata> {
  const resolved = await resolvePublicRoot(db, host);
  if (resolved.kind === "marketing" || shouldServeTbbtMarketingHome(host)) {
    return tbbtMarketingMetadata({ page: "home", pathname: "/", host });
  }
  if (resolved.kind === "unknown") {
    return { title: { absolute: "Not found" }, robots: { index: false, follow: false } };
  }
  const view = await loadPublicWebsiteView(resolved.slug, db);
  if (view?.snapshot) {
    const snapshotMeta =
      viewHomeMetadata(view, "/", resolved.origin) ??
      viewHomeMetadata(view, publicHomePath(view.site.business.slug), resolved.origin);
    if (snapshotMeta) return snapshotMeta;
  }
  if (view && isCollProRenoSlug(view.site.business.slug) && !view.snapshot) {
    return collproCompatibilityHomeMetadata(host, view.site.business.slug, resolved.origin);
  }
  if (view) {
    const name = publicDisplayName(view.site.business);
    return {
      title: { absolute: `${name} | Services` },
      description:
        view.about ||
        `Request services from ${name}. Choose one or more tasks for a single visit request.`,
      alternates: { canonical: publicCanonicalUrl(view.site.business.slug, "/", resolved.origin) },
    };
  }
  return collproCompatibilityHomeMetadata(host, resolved.slug, resolved.origin);
}

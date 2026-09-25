import type { Metadata } from "next";
import { notFound } from "next/navigation";
import "@/components/public/public-site.css";
import { TbbtHomePage } from "@/components/tbbt-marketing/home";
import { TbbtMarketingShell } from "@/components/tbbt-marketing/shell";
import { PublicHome } from "@/components/public/public-home";
import { PublicSiteShell } from "@/components/public/public-site-shell";
import {
  COLLPRO_RENO_DISPLAY_NAME,
  isCollProRenoSlug,
  localBusinessJsonLd,
  publicDisplayName,
  publicHomePath,
  publicLogoSrc,
  publicPhone,
} from "@/lib/public-site";
import { buildPublicHomeImagePresentation, loadPublicHomeImages } from "@/lib/public-site-images";
import { prisma } from "@/lib/prisma";
import { loadDefaultPublicBusiness, loadPublicCatalog } from "@/lib/public-site-data";
import { readRequestHost } from "@/lib/request-host";
import { tbbtMarketingMetadata } from "@/lib/tbbt-marketing-seo";
import { shouldServeTbbtMarketingHome } from "@/lib/tbbt-marketing-host";
import { loadPublicWebsiteView, snapshotToImageRows } from "@/lib/website-engine/public";
import { resolvePublicRoot } from "@/lib/website-engine/hosts";
import { viewHomeMetadata } from "@/lib/website-engine/seo";
import {
  publishedHeroImageAlt,
  publishedLocalBusinessDescription,
  publishedServicesHeadline,
} from "@/lib/website-engine/copy";
import { publicCanonicalUrl } from "@/lib/public-site-seo";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const host = await readRequestHost();
  const resolved = await resolvePublicRoot(prisma, host);
  if (resolved.kind === "marketing" || shouldServeTbbtMarketingHome(host)) {
    return tbbtMarketingMetadata({ page: "home", pathname: "/", host });
  }
  if (resolved.kind === "unknown") {
    return { title: { absolute: "Not found" }, robots: { index: false, follow: false } };
  }
  const view = await loadPublicWebsiteView(resolved.slug);
  if (view?.snapshot) {
    const snapshotMeta =
      viewHomeMetadata(view, "/", resolved.origin) ??
      viewHomeMetadata(view, publicHomePath(view.site.business.slug), resolved.origin);
    if (snapshotMeta) return snapshotMeta;
  }
  if (view && isCollProRenoSlug(view.site.business.slug) && !view.snapshot) {
    return {
      title: { absolute: `${COLLPRO_RENO_DISPLAY_NAME} | Handyman Services` },
      description:
        "Request handyman services from CollPro Reno Handyman Services. Choose one or more tasks for a single visit request.",
    };
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
  return {
    title: { absolute: `${COLLPRO_RENO_DISPLAY_NAME} | Handyman Services` },
    description:
      "Request handyman services from CollPro Reno Handyman Services. Choose one or more tasks for a single visit request.",
  };
}

export default async function HomePage() {
  const host = await readRequestHost();
  const resolved = await resolvePublicRoot(prisma, host);
  if (resolved.kind === "marketing" || shouldServeTbbtMarketingHome(host)) {
    return (
      <TbbtMarketingShell host={host}>
        <TbbtHomePage />
      </TbbtMarketingShell>
    );
  }
  if (resolved.kind === "unknown") {
    notFound();
  }

  const view = await loadPublicWebsiteView(resolved.slug);
  const business =
    view?.site.business ??
    (isCollProRenoSlug(resolved.slug) ? await loadDefaultPublicBusiness() : null);
  if (!business) {
    return (
      <main className="public-site mx-auto flex min-h-full max-w-md items-center px-4 py-16">
        <div className="rounded-xl border border-border bg-white p-6">
          <h1 className="text-xl font-semibold">{COLLPRO_RENO_DISPLAY_NAME}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The public website is not available yet because the business record
            could not be found.
          </p>
        </div>
      </main>
    );
  }

  const catalog = view?.site ?? {
    business,
    ...(await loadPublicCatalog(business)),
  };
  const homeImages = view?.snapshot
    ? buildPublicHomeImagePresentation(catalog.groups, snapshotToImageRows(view.snapshot))
    : await loadPublicHomeImages(prisma, business.id, catalog.groups);
  const name = publicDisplayName(catalog.business);
  const description = view?.snapshot
    ? publishedLocalBusinessDescription({
        name,
        trades: view.snapshot.trades,
        area: view.snapshot.business.publicServiceAreaLabel,
      })
    : `Handyman services from ${name}. Request repairs, installations, mounting, carpentry, and other home projects.`;
  const jsonLd = localBusinessJsonLd({
    name,
    slug: catalog.business.slug,
    phone: publicPhone(catalog.business),
    logoSrc: publicLogoSrc(catalog.business.slug),
    description,
    origin: resolved.origin,
    url: publicCanonicalUrl(catalog.business.slug, "/", resolved.origin),
  });

  return (
    <PublicSiteShell business={catalog.business} groups={catalog.groups}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <PublicHome
        business={catalog.business}
        items={catalog.items}
        groups={catalog.groups}
        images={homeImages}
        headline={view?.snapshot?.home.headline}
        supporting={view?.snapshot?.home.supporting}
        servicesHeading={
          view?.snapshot ? publishedServicesHeadline(view.snapshot.trades) : undefined
        }
        heroImageAlt={
          view?.snapshot ? publishedHeroImageAlt(view.snapshot.trades) : undefined
        }
      />
    </PublicSiteShell>
  );
}

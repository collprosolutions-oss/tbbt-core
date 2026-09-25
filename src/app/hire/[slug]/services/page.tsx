import type { Metadata } from "next";
import "@/components/public/public-site.css";
import { PublicPageHero } from "@/components/public/public-page-hero";
import { PublicServicesBrowser } from "@/components/public/public-services-browser";
import { PublicSiteShell } from "@/components/public/public-site-shell";
import { smsHref } from "@/lib/directions";
import {
  publicDisplayName,
  publicHomePath,
  publicPhone,
  publicRequestPath,
  publicServicesPath,
} from "@/lib/public-site";
import { prisma } from "@/lib/prisma";
import { requirePublicWebsiteView } from "@/lib/require-public-site";
import { publicTenantPageMetadata } from "@/lib/public-site-seo";
import { buildPublicServicesImagePresentation, loadPublicServicesImages } from "@/lib/public-site-images";
import { snapshotToImageRows } from "@/lib/website-engine/public";
import { snapshotPageMetadata } from "@/lib/website-engine/seo";
import { parseSelectedWorkSearch } from "@/lib/selected-work";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{
    category?: string;
    services?: string;
    other?: string;
    otherText?: string;
    otherQty?: string;
  }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const view = await requirePublicWebsiteView(slug);
  if (view.snapshot) {
    return snapshotPageMetadata({
      snapshot: view.snapshot,
      page: view.snapshot.seo.services,
      pathname: publicServicesPath(view.site.business.slug),
    });
  }
  const name = publicDisplayName(view.site.business);
  return publicTenantPageMetadata({
    business: view.site.business,
    title: `Services | ${name}`,
    description: `Browse handyman services from ${name}. Select one or more tasks, then continue to request service.`,
    pathname: publicServicesPath(view.site.business.slug),
  });
}

export default async function PublicServicesPage({ params, searchParams }: PageProps) {
  const { slug } = await params;
  const query = await searchParams;
  const view = await requirePublicWebsiteView(slug);
  const site = view.site;
  const phone = publicPhone(site.business);
  const requestHref = publicRequestPath(site.business.slug);
  const textHref = smsHref(phone);
  const images = view.snapshot
    ? buildPublicServicesImagePresentation(site.groups, snapshotToImageRows(view.snapshot))
    : await loadPublicServicesImages(prisma, site.business.id, site.groups);
  const initialSelected = parseSelectedWorkSearch(query, new Set(site.items.map((item) => item.id)));

  return (
    <PublicSiteShell business={site.business} groups={site.groups}>
      <main>
        <PublicPageHero
          homeHref={publicHomePath(site.business.slug)}
          current="Services"
          title="Services"
          description="Professional handyman services to keep your home running smoothly and looking its best."
          imageSrc={images.hero.src}
          objectPosition={images.hero.objectPosition}
          objectZoom={images.hero.objectZoom}
          phone={phone}
          smsHref={textHref}
          requestHref={requestHref}
        />
        <section className="public-section bg-[var(--public-paper)]">
          <div className="public-container">
            <PublicServicesBrowser
              slug={site.business.slug}
              items={site.items}
              groups={site.groups}
              initialCategory={query.category}
              initialSelected={initialSelected}
              categoryImages={images.categories}
            />
          </div>
        </section>
      </main>
    </PublicSiteShell>
  );
}

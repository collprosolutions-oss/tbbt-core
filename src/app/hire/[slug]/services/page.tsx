import type { Metadata } from "next";
import "@/components/public/public-site.css";
import { PublicCtaBar } from "@/components/public/public-cta-bar";
import { PublicPageHero } from "@/components/public/public-page-hero";
import { PublicServicesBrowser } from "@/components/public/public-services-browser";
import { PublicSiteShell } from "@/components/public/public-site-shell";
import { PublicUnavailable } from "@/components/public/public-unavailable";
import { smsHref } from "@/lib/directions";
import {
  publicDisplayName,
  publicHomePath,
  publicPhone,
  publicRequestPath,
} from "@/lib/public-site";
import { prisma } from "@/lib/prisma";
import { loadPublicSite } from "@/lib/public-site-data";
import { loadPublicServicesImages } from "@/lib/public-site-images";
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
  const site = await loadPublicSite(slug);
  const name = site ? publicDisplayName(site.business) : "Services";
  return {
    title: { absolute: `Services | ${name}` },
    description: `Browse handyman services from ${name}. Select one or more tasks, then continue to request service.`,
  };
}

export default async function PublicServicesPage({ params, searchParams }: PageProps) {
  const { slug } = await params;
  const query = await searchParams;
  const site = await loadPublicSite(slug);
  if (!site) {
    return <PublicUnavailable title="Page unavailable" body="This business could not be found." />;
  }
  const phone = publicPhone(site.business.slug);
  const requestHref = publicRequestPath(site.business.slug);
  const textHref = smsHref(phone);
  const images = await loadPublicServicesImages(prisma, site.business.id, site.groups);
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
        <PublicCtaBar
          title="Ready to get started?"
          body="Tell us about your project and we will review the request before preparing a written estimate."
          requestHref={requestHref}
          smsHref={textHref}
          phone={phone}
        />
      </main>
    </PublicSiteShell>
  );
}

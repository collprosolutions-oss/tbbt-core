import type { Metadata } from "next";
import { notFound } from "next/navigation";
import "@/components/public/public-site.css";
import { PublicCtaBar } from "@/components/public/public-cta-bar";
import { PublicPageHero } from "@/components/public/public-page-hero";
import { PublicSiteShell } from "@/components/public/public-site-shell";
import { smsHref } from "@/lib/directions";
import { listServiceAreas } from "@/lib/service-area-ops";
import { publicServiceCityPath, resolvePublicLocalPage } from "@/lib/service-areas";
import {
  publicDisplayName,
  publicHomePath,
  publicPhone,
  publicRequestPath,
} from "@/lib/public-site";
import { prisma } from "@/lib/prisma";
import { requirePublicWebsiteView } from "@/lib/require-public-site";
import { publicTenantPageMetadata } from "@/lib/public-site-seo";
import { publicLocalPageFromView } from "@/lib/website-engine/public";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ slug: string; city: string; service: string }>;
};

async function loadPublicLocalPage(slug: string, city: string, service: string) {
  const view = await requirePublicWebsiteView(slug);
  if (view.snapshot) {
    const local = publicLocalPageFromView(view, city, service);
    if (!local) return null;
    return {
      site: view.site,
      snapshotLocal: local,
      catalog: view.site.items.find((item) => item.id === local.serviceId) ?? {
        id: local.serviceId,
        name: local.serviceName,
        description: local.copy,
      },
      matchedCity: { label: local.cityLabel, city: local.cityLabel },
    };
  }
  const areas = await listServiceAreas(prisma, view.site.business.id);
  const resolved = resolvePublicLocalPage({
    citySlug: city,
    serviceSlug: service,
    areas,
    services: view.site.items,
  });
  if (!resolved) return null;
  return { site: view.site, snapshotLocal: null, catalog: resolved.service, matchedCity: resolved.city };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug, city, service } = await params;
  const loaded = await loadPublicLocalPage(slug, city, service);
  if (!loaded) {
    return {
      title: { absolute: "Not found" },
      robots: { index: false, follow: false },
    };
  }
  const name = publicDisplayName(loaded.site.business);
  const title = `${loaded.catalog.name} in ${loaded.matchedCity.label} | ${name}`;
  const description =
    loaded.snapshotLocal?.copy ||
    `Request ${loaded.catalog.name} in ${loaded.matchedCity.label} from ${name}.`;
  return publicTenantPageMetadata({
    business: loaded.site.business,
    title,
    description,
    pathname: publicServiceCityPath(loaded.site.business.slug, service, city),
  });
}

export default async function PublicServiceCityPage({ params }: PageProps) {
  const { slug, city, service } = await params;
  const loaded = await loadPublicLocalPage(slug, city, service);
  if (!loaded) notFound();

  const phone = publicPhone(loaded.site.business);
  const approvedContent = loaded.snapshotLocal
    ? []
    : await prisma.marketingContent.findMany({
        where: {
          businessId: loaded.site.business.id,
          status: "APPROVED",
          catalogItemId: loaded.catalog.id,
        },
        select: { title: true, body: true },
        take: 3,
      });
  const localCopy =
    loaded.snapshotLocal?.copy ||
    loaded.catalog.description?.trim() ||
    `${loaded.catalog.name} for homeowners in ${loaded.matchedCity.label}.`;

  return (
    <PublicSiteShell business={loaded.site.business} groups={loaded.site.groups}>
      <main>
        <PublicPageHero
          homeHref={publicHomePath(loaded.site.business.slug)}
          current="Services"
          title={loaded.catalog.name}
          description={`Local page for ${loaded.matchedCity.label}. Generated from approved services and enabled service areas only.`}
          phone={phone}
          smsHref={smsHref(phone)}
          requestHref={publicRequestPath(loaded.site.business.slug)}
        />
        <section className="bg-[var(--public-paper)]">
          <div className="public-container space-y-4 py-8">
            <p className="text-sm whitespace-pre-wrap">{localCopy}</p>
            {approvedContent.length > 0 ? (
              <div className="space-y-2">
                <h2 className="text-lg font-semibold">Approved project notes</h2>
                {approvedContent.map((row) => (
                  <article key={row.title} className="rounded-md border p-3">
                    <h3 className="font-medium">{row.title}</h3>
                    <p className="text-sm whitespace-pre-wrap">{row.body}</p>
                  </article>
                ))}
              </div>
            ) : null}
          </div>
        </section>
        <PublicCtaBar
          title="Need this service?"
          body="Send a request. Qualification uses the owner-configured service area."
          requestHref={publicRequestPath(loaded.site.business.slug)}
          smsHref={smsHref(phone)}
          phone={phone}
        />
      </main>
    </PublicSiteShell>
  );
}

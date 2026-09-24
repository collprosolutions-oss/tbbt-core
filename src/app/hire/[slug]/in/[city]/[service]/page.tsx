import type { Metadata } from "next";
import Link from "next/link";
import "@/components/public/public-site.css";
import { PublicCtaBar } from "@/components/public/public-cta-bar";
import { PublicPageHero } from "@/components/public/public-page-hero";
import { PublicSiteShell } from "@/components/public/public-site-shell";
import { smsHref } from "@/lib/directions";
import { listServiceAreas } from "@/lib/service-area-ops";
import { publicServiceCityPath, slugifyLocalPagePart } from "@/lib/service-areas";
import {
  publicDisplayName,
  publicHomePath,
  publicPhone,
  publicRequestPath,
} from "@/lib/public-site";
import { prisma } from "@/lib/prisma";
import { requirePublicSite } from "@/lib/require-public-site";
import { publicTenantPageMetadata } from "@/lib/public-site-seo";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ slug: string; city: string; service: string }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug, city, service } = await params;
  const site = await requirePublicSite(slug);
  const name = publicDisplayName(site.business);
  const settings = await prisma.businessSettings.findUnique({
    where: { businessId: site.business.id },
    select: { seoTitleServices: true, seoDescriptionServices: true },
  });
  const catalog = site.items.find((item) => slugifyLocalPagePart(item.name) === service);
  const title = settings?.seoTitleServices?.trim() || `${catalog?.name ?? "Service"} in ${city} | ${name}`;
  const description =
    settings?.seoDescriptionServices?.trim() ||
    `Request ${catalog?.name ?? "handyman service"} in ${city} from ${name}.`;
  return publicTenantPageMetadata({
    business: site.business,
    title,
    description,
    pathname: publicServiceCityPath(site.business.slug, service, city),
  });
}

export default async function PublicServiceCityPage({ params }: PageProps) {
  const { slug, city, service } = await params;
  const site = await requirePublicSite(slug);
  const phone = publicPhone(site.business);
  const areas = await listServiceAreas(prisma, site.business.id);
  const matchedCity = areas.find(
    (area) =>
      area.enabled &&
      area.kind === "CITY" &&
      slugifyLocalPagePart(area.city || area.label) === city,
  );
  const catalog = site.items.find((item) => slugifyLocalPagePart(item.name) === service);
  const approvedContent = catalog
    ? await prisma.marketingContent.findMany({
        where: {
          businessId: site.business.id,
          status: "APPROVED",
          catalogItemId: catalog.id,
        },
        select: { title: true, body: true },
        take: 3,
      })
    : [];

  return (
    <PublicSiteShell business={site.business} groups={site.groups}>
      <main>
        <PublicPageHero
          homeHref={publicHomePath(site.business.slug)}
          current="Services"
          title={catalog?.name ?? "Service"}
          description={
            matchedCity
              ? `Local page for ${matchedCity.label}. Generated from approved services and enabled service areas only.`
              : "This city is not an enabled service area for this business."
          }
          phone={phone}
          smsHref={smsHref(phone)}
          requestHref={publicRequestPath(site.business.slug)}
        />
        <section className="bg-[var(--public-paper)]">
          <div className="public-container space-y-4 py-8">
            {!matchedCity || !catalog ? (
              <p className="text-sm text-muted-foreground">
                TBBT will not invent a city or service page. Use the{" "}
                <Link className="underline" href={publicRequestPath(site.business.slug)}>
                  request form
                </Link>{" "}
                if you still want to inquire.
              </p>
            ) : (
              <>
                <p className="text-sm">
                  {catalog.description?.trim() || `${catalog.name} for homeowners in ${matchedCity.label}.`}
                </p>
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
              </>
            )}
          </div>
        </section>
        <PublicCtaBar
          title="Need this service?"
          body="Send a request. Qualification uses the owner-configured service area."
          requestHref={publicRequestPath(site.business.slug)}
          smsHref={smsHref(phone)}
          phone={phone}
        />
      </main>
    </PublicSiteShell>
  );
}

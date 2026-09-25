import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import "@/components/public/public-site.css";
import { PublicCtaBar } from "@/components/public/public-cta-bar";
import { PublicPageHero } from "@/components/public/public-page-hero";
import { PublicSiteShell } from "@/components/public/public-site-shell";
import { smsHref } from "@/lib/directions";
import {
  publicDisplayName,
  publicHomePath,
  publicPhone,
  publicRequestPath,
  publicServiceDetailPath,
  selectedWorkQuery,
} from "@/lib/public-site";
import { requirePublicWebsiteView } from "@/lib/require-public-site";
import { publicTenantPageMetadata } from "@/lib/public-site-seo";
import { publicServiceFromView } from "@/lib/website-engine/public";
import { publicOriginForSlug } from "@/lib/website-engine/hosts";
import { readRequestHost } from "@/lib/request-host";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ slug: string; serviceSlug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug, serviceSlug } = await params;
  const view = await requirePublicWebsiteView(slug);
  const service = publicServiceFromView(view, serviceSlug);
  if (!service) {
    return { title: { absolute: "Not found" }, robots: { index: false, follow: false } };
  }
  const name = publicDisplayName(view.site.business);
  const origin = await publicOriginForSlug(prisma, view.site.business.slug, await readRequestHost());
  return publicTenantPageMetadata({
    business: view.site.business,
    title: `${service.name} | ${name}`,
    description: service.description || `Request ${service.name} from ${name}.`,
    pathname: publicServiceDetailPath(view.site.business.slug, service.slug),
    origin,
  });
}

export default async function PublicServiceDetailPage({ params }: PageProps) {
  const { slug, serviceSlug } = await params;
  const view = await requirePublicWebsiteView(slug);
  const service = publicServiceFromView(view, serviceSlug);
  if (!service) notFound();
  const phone = publicPhone(view.site.business);
  const requestHref = `${publicRequestPath(view.site.business.slug)}${selectedWorkQuery({
    catalogIds: [service.id],
  })}`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Service",
    name: service.name,
    description: service.description || undefined,
    provider: { "@type": "LocalBusiness", name: publicDisplayName(view.site.business) },
    areaServed: view.site.business.publicServiceAreaLabel || undefined,
  };

  return (
    <PublicSiteShell business={view.site.business} groups={view.site.groups}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <main>
        <PublicPageHero
          homeHref={publicHomePath(view.site.business.slug)}
          current={service.name}
          title={<>{service.name}</>}
          description={`${service.tradeLabel} · ${service.category}`}
          imageSrc={service.imageUrl ?? undefined}
          phone={phone}
          smsHref={smsHref(phone)}
          requestHref={requestHref}
        />
        <section className="public-container" style={{ padding: "2rem 0" }}>
          <p className="text-sm">{service.priceLabel}</p>
          {service.recurrenceEligible ? (
            <p className="text-sm">Available as a recurring visit when requested.</p>
          ) : null}
          {service.description ? (
            <div className="mt-4 whitespace-pre-line">{service.description}</div>
          ) : null}
          <p className="mt-6">
            <Link href={requestHref} className="underline">
              Request this service
            </Link>
          </p>
        </section>
        <PublicCtaBar
          title={`Request ${service.name}`}
          body="Tell us about the work. You will receive a written estimate to review."
          requestHref={requestHref}
          smsHref={smsHref(phone)}
          phone={phone}
        />
      </main>
    </PublicSiteShell>
  );
}
